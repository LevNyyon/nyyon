#!/usr/bin/env node
// Register the packs baked in at build time as installed + active.
//
// Runs against the LOCAL sqlite on this instance's disk (no network, no API
// key): the code is already in the bundle, so the rows are bookkeeping the
// UI reads. Bound parameters, because a manifest is megabytes and a SQL
// statement of that size is refused.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = process.env.NYYON_STATE_DIR || join(REPO, 'workers', 'api', '.wrangler', 'state');
const D1DIR = join(STATE, 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MANIFESTS = join(REPO, 'db', 'generated', 'bundled-manifests.json');

if (!existsSync(MANIFESTS)) { console.log('[register] no baked manifests — nothing to register'); process.exit(0); }
if (!existsSync(D1DIR)) { console.error('[register] no database yet at', D1DIR); process.exit(0); }

// The biggest .sqlite in the D1 dir is the database (the others are metadata).
const files = readdirSync(D1DIR).filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: readFileSync(join(D1DIR, f)).length }))
  .sort((a, b) => b.size - a.size);
if (!files.length) { console.error('[register] no sqlite file found'); process.exit(0); }

const db = new DatabaseSync(join(D1DIR, files[0].f));
const manifests = JSON.parse(readFileSync(MANIFESTS, 'utf8'));
const now = Date.now();
const stmt = db.prepare(`INSERT INTO plugins (name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at)
VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET version=excluded.version, title=excluded.title, status='active',
  manifest_json=excluded.manifest_json, binding_json=excluded.binding_json, updated_at=excluded.updated_at`);

for (const m of manifests) {
  // Bind every gateway the pack declared to the host gateway of the same slug
  // — the same shape bindGateways() produces for a host-satisfied requirement.
  const binding = {};
  for (const g of (m.requires?.gateways || [])) {
    if (g?.slug) binding[g.slug] = { via: 'host', target: g.slug, modes: g.modes || [] };
  }
  // The pack's own tables must exist before its tools run.
  for (const t of (m.requires?.tables || [])) {
    if (t?.ddl) { try { db.exec(t.ddl); } catch (e) { console.error(`[register] ${m.name} ddl:`, e?.message || e); } }
  }
  try {
    stmt.run(m.name, m.version || '1.0.0', m.title || m.name, JSON.stringify(m), JSON.stringify(binding), '{"step":"bundled"}', now, now);
    console.log(`[register] ${m.name} active`);
  } catch (e) { console.error(`[register] ${m.name}:`, e?.message || e); }
}
db.close();
