#!/usr/bin/env node
// Bake every bundled pack (plugins/<name>/) into the source tree BEFORE a build.
//
// On a self-hosted install the applier does this at runtime: it writes each
// plugin's code to disk and regenerates the two aggregators. A Cloudflare
// Worker cannot write its own source, so on a cloud deploy that never happens
// and the app ships with an empty sidebar. This script is the applier's
// build-time twin: same inputs (the packs), same outputs (files + aggregators),
// run once before `npm run build`.
//
// Idempotent. Safe to re-run. Writes ONLY under the two plugin roots.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesFor, generateIndex, generateWebIndex, bindGateways, validateManifest } from '../workers/api/src/lib/plugins.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(REPO, 'plugins');
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const arr = (v) => (Array.isArray(v) ? v : []);

function assemble(dir) {
  const readRef = (ref) => {
    const abs = resolve(dir, ref);
    if (!abs.startsWith(resolve(dir) + sep)) throw new Error(`ref escapes the pack: ${ref}`);
    return readFileSync(abs, 'utf8');
  };
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const lf of arr(m.lib)) if (lf.code_file) { lf.code = readRef(lf.code_file); delete lf.code_file; }
  for (const t of arr(m.provides?.tools)) if (t.code_file) { t.code = readRef(t.code_file); delete t.code_file; }
  for (const g of arr(m.provides?.gateways)) if (g.code_file) { g.code = readRef(g.code_file); delete g.code_file; }
  for (const k of arr(m.provides?.knowledge)) if (k.body_file) { k.body = readRef(k.body_file); delete k.body_file; }
  for (const sf of arr(m.provides?.surfaces)) {
    if (sf.page_file) { sf.page_code = readRef(sf.page_file); delete sf.page_file; }
    for (const f of arr(sf.files)) if (f.code_file) { f.code = readRef(f.code_file); delete f.code_file; }
  }
  return m;
}

const names = existsSync(PACKS)
  ? readdirSync(PACKS).filter((n) => NAME_RE.test(n) && existsSync(join(PACKS, n, 'manifest.json'))).sort()
  : [];

const rows = [];
for (const name of names) {
  const manifest = assemble(join(PACKS, name));
  // Same gate the import route applies. A pack that would be REFUSED at
  // import must not be baked in silently.
  const v = await validateManifest({}, manifest);
  const errs = (v.errors || []).filter((e) => !e.includes('tool pool unavailable'));
  if (errs.length) {
    console.error(`✗ ${name}: refused by the validator, NOT baked in`);
    for (const e of errs.slice(0, 6)) console.error(`    ${e}`);
    process.exitCode = 1;
    continue;
  }
  const binding = bindGateways(manifest).binding || {};
  for (const f of filesFor(manifest, binding)) {
    const abs = resolve(REPO, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  rows.push({ name, manifest_json: JSON.stringify(manifest), binding_json: JSON.stringify(binding) });
  console.log(`✓ ${name}: ${filesFor(manifest, binding).length} files`);
}

// Both aggregators, generated from the full set exactly as the applier does.
writeFileSync(join(REPO, 'workers', 'api', 'src', 'plugins', 'index.js'), generateIndex(rows));
mkdirSync(join(REPO, 'web', 'src', 'plugins'), { recursive: true });
writeFileSync(join(REPO, 'web', 'src', 'plugins', 'index.ts'), generateWebIndex(rows));

// The DB rows these packs need, so the deployed install KNOWS they are
// installed (the applier normally writes these). Emitted as SQL the deploy
// applies after the migrations.
// The manifests, for a CLOUD deploy to POST at /api/plugins/import-bundled
// with {prematerialized:true}. Posting (bound params) instead of raw SQL is
// deliberate: a manifest is megabytes and D1 caps statement TEXT length.
writeFileSync(join(REPO, 'db', 'generated', 'bundled-manifests.json'),
  JSON.stringify(rows.map((r) => JSON.parse(r.manifest_json))));

const sql = rows.map((r) => {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `INSERT INTO plugins (name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at)
VALUES (${q(r.name)}, ${q(JSON.parse(r.manifest_json).version || '1.0.0')}, ${q(JSON.parse(r.manifest_json).title || r.name)}, 'active', ${q(r.manifest_json)}, ${q(r.binding_json)}, '{"step":"bundled"}', ${Date.now()}, ${Date.now()})
ON CONFLICT(name) DO UPDATE SET version=excluded.version, title=excluded.title, status='active',
  manifest_json=excluded.manifest_json, binding_json=excluded.binding_json, updated_at=excluded.updated_at;`;
}).join('\n');
mkdirSync(join(REPO, 'db', 'generated'), { recursive: true });
writeFileSync(join(REPO, 'db', 'generated', 'bundled-plugins.sql'), sql + '\n');

console.log(`\nbaked ${rows.length} pack(s) + both aggregators + db/generated/bundled-plugins.sql`);
