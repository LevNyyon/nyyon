#!/usr/bin/env node
// Plugin applier — the self-hosted materializer.
//
// A Worker cannot load new code at runtime, so this sidecar closes the loop:
// it polls the worker for plugins in status `bound`, writes their code files
// under workers/api/src/plugins/<name>/, regenerates plugins/index.js from
// the full installed set (deterministic — never reads the old file), reports
// back, restarts the app, and calls verify so the plugin flips active.
//
// Paths are HARD-SCOPED: this process refuses to touch anything outside
// workers/api/src/plugins/. That guarantee is the applier's whole contract,
// and it applies to DELETES as much as writes — a plugin name is attacker-
// influenced text that becomes a directory path.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_ROOT = join(REPO, 'workers', 'api', 'src', 'plugins');
// Page surfaces materialize into the SPA the same way tools materialize into
// the worker. Same contract: ONLY these two roots, writes and deletes alike.
const WEB_PLUGIN_ROOT = join(REPO, 'web', 'src', 'plugins');
const API_PORT = process.env.NYYON_API_PORT || '8799';
const BASE = `http://127.0.0.1:${API_PORT}`;
const DEV_VARS = join(REPO, 'workers', 'api', '.dev.vars');
// How this install restarts the worker. Empty = no supervisor (wrangler's own
// watcher reloads on source change), so a missing systemd unit is not fatal.
const RESTART_CMD = process.env.NYYON_RESTART_CMD ?? 'sudo systemctl restart nyyon';
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

function applierKey() {
  try {
    const m = readFileSync(DEV_VARS, 'utf8').match(/^NYYON_APPLIER_KEY\s*=\s*"?([^"\n]+)"?/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// The one path guard, used by every filesystem operation in this file.
function insidePluginRoot(abs) {
  return abs.startsWith(PLUGIN_ROOT + sep) || abs === join(PLUGIN_ROOT, 'index.js')
    || abs.startsWith(WEB_PLUGIN_ROOT + sep) || abs === join(WEB_PLUGIN_ROOT, 'index.ts');
}

function safeWrite(repoRelPath, content) {
  const abs = resolve(REPO, repoRelPath);
  if (!insidePluginRoot(abs)) throw new Error(`refusing to write outside the plugin root: ${repoRelPath}`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`[plugin-apply] wrote ${repoRelPath} (${content.length}b)`);
}

// Deleting needs the SAME guard as writing. A name like "../.." would
// otherwise have handed rmSync the whole install.
function safeRemoveDir(name) {
  if (!NAME_RE.test(name || '')) throw new Error(`refusing to delete: invalid plugin name ${JSON.stringify(name)}`);
  let removed = false;
  for (const root of [PLUGIN_ROOT, WEB_PLUGIN_ROOT]) {
    const abs = resolve(root, name);
    if (!abs.startsWith(root + sep)) throw new Error(`refusing to delete outside the plugin root: ${name}`);
    if (!existsSync(abs)) continue;
    rmSync(abs, { recursive: true });
    removed = true;
  }
  if (removed) console.log(`[plugin-apply] removed ${name}/`);
  return removed;
}

// A plugin page is a stranger's TSX entering YOUR build, so the build runs
// HERE, before the app restarts into it. On failure the offending plugin's
// web files are rolled back and the failure is reported on that plugin —
// its author's mistake, never your outage.
function buildWeb() {
  execSync('npx tsc -b --pretty false && npx vite build', {
    cwd: join(REPO, 'web'), stdio: 'pipe', timeout: 300_000,
  });
}
function tryBuildOrRollback(pluginName, webIndexContent) {
  try { buildWeb(); return { ok: true }; }
  catch (e) {
    const out = String(e?.stdout || '') + String(e?.stderr || '');
    console.error(`[plugin-apply] SPA build failed for ${pluginName} — rolling its page back`);
    try {
      const abs = resolve(WEB_PLUGIN_ROOT, pluginName);
      if (abs.startsWith(WEB_PLUGIN_ROOT + sep) && existsSync(abs)) rmSync(abs, { recursive: true });
      // Regenerate the index WITHOUT the rolled-back plugin so the map has no
      // dangling import, then prove the app still builds.
      const lines = webIndexContent.split('\n').filter((l) => !l.includes(`./${pluginName}/`));
      safeWrite('web/src/plugins/index.ts', lines.join('\n'));
      buildWeb();
    } catch (e2) {
      console.error('[plugin-apply] rollback build also failed:', String(e2?.message || e2).slice(0, 400));
    }
    return { ok: false, error: `SPA build failed: ${out.slice(-1200)}` };
  }
}

// ── bundled-pack seeding ────────────────────────────────────────────────────
// A fresh install must come up with its standard modules INSTALLED. The repo
// ships them as packs under plugins/<name>/; on every boot the applier offers
// each one to the worker (which skips names it already has, any status) and
// the normal pipeline takes it from bound to active.
import { readdirSync } from 'node:fs';

function assemblePack(dir) {
  const readRef = (ref) => {
    const abs = resolve(dir, ref);
    if (!abs.startsWith(resolve(dir) + sep)) throw new Error(`ref escapes pack: ${ref}`);
    return readFileSync(abs, 'utf8');
  };
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const arr = (v) => (Array.isArray(v) ? v : []);
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

let seeded = false;
async function seedBundledPacks(key) {
  if (seeded) return;
  const packsDir = join(REPO, 'plugins');
  let names = [];
  try { names = readdirSync(packsDir).filter((n) => NAME_RE.test(n) && existsSync(join(packsDir, n, 'manifest.json'))); }
  catch { seeded = true; return; }
  for (const name of names) {
    try {
      const manifest = assemblePack(join(packsDir, name));
      const r = await report('/api/plugins/import-bundled', { manifest }, key);
      if (r?.skipped) console.log(`[plugin-apply] bundled ${name}: ${r.skipped}`);
      else if (r?.ok) console.log(`[plugin-apply] bundled ${name}: imported (${r.status})`);
      else console.error(`[plugin-apply] bundled ${name}: refused —`, (r?.errors || [r?.error]).slice(0, 3).join('; '));
    } catch (e) {
      console.error(`[plugin-apply] bundled ${name}:`, e?.message || e);
    }
  }
  seeded = true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body = null, key) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Report delivery is retried on its own: a network blip on the way BACK must
// not mark a correctly-written plugin permanently blocked.
async function report(path, body, key, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await call(path, body, key); } catch (e) {
      if (i === tries - 1) { console.error(`[plugin-apply] report ${path} failed:`, e?.message || e); return null; }
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

function restart() {
  if (!RESTART_CMD) { console.log('[plugin-apply] no restart command configured — relying on the dev watcher'); return; }
  try { execSync(RESTART_CMD, { stdio: 'inherit' }); } catch (e) {
    // A failed restart must not skip the verify pass below.
    console.error('[plugin-apply] restart failed (continuing):', e?.message || e);
  }
}

// Wait for the worker to answer again rather than sleeping a fixed guess.
async function waitForWorker(maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) });
      if (r.status) return true;
    } catch { /* still down */ }
    await sleep(2000);
  }
  return false;
}

console.log('[plugin-apply] up — watching for bound plugins');
for (;;) {
  const key = applierKey();
  if (!key) { await sleep(60_000); continue; }
  try {
    await seedBundledPacks(key);
    const work = await call('/api/plugins/pending', null, key);
    const pending = work.pending || [];
    const removals = work.remove || [];
    let changed = false;

    // Reconcile: an installed plugin whose files vanished (source sync, disk
    // mishap) is healed from the DB record, which is the source of truth.
    // The aggregator counts too — a source sync overwrites it with the repo's
    // empty copy while the tool files survive.
    for (const p of work.installed || []) {
      for (const f of p.files) {
        const abs = resolve(REPO, f.path);
        let current = null;
        try { current = readFileSync(abs, 'utf8'); } catch { /* missing */ }
        if (current !== f.content) { safeWrite(f.path, f.content); changed = true; }
      }
    }
    for (const idx of [work.index_file, work.web_index_file].filter(Boolean)) {
      const abs = resolve(REPO, idx.path);
      let current = null;
      try { current = readFileSync(abs, 'utf8'); } catch { /* missing */ }
      if (current !== idx.content) { safeWrite(idx.path, idx.content); changed = true; }
    }

    // Removals: delete the directory, then ACK so the removal drops off the
    // work list. Without the ack the applier deleted nothing, restarted the
    // app, and repeated that every tick forever.
    for (const name of removals) {
      try {
        if (safeRemoveDir(name)) changed = true;
        await report('/api/plugins/cleaned', { name }, key);
      } catch (e) {
        console.error(`[plugin-apply] remove ${name} failed:`, e?.message || e);
      }
    }

    // New code. A write failure is the plugin's problem (report ok:false); a
    // failure to DELIVER the report is ours (retried above, never inverted).
    for (const p of pending) {
      let wrote = true;
      let hasWebFiles = false;
      try {
        for (const f of p.files) {
          safeWrite(f.path, f.content);
          if (f.path.startsWith('web/')) hasWebFiles = true;
        }
        changed = true;
      } catch (e) {
        wrote = false;
        console.error(`[plugin-apply] ${p.name} failed:`, e?.message || e);
        await report('/api/plugins/applied', { name: p.name, ok: false, error: String(e?.message || e) }, key);
      }
      // A page must PROVE it builds before this plugin is reported applied.
      // The index is written first so the build compiles the real final map.
      if (wrote && hasWebFiles && work.web_index_file) {
        safeWrite(work.web_index_file.path, work.web_index_file.content);
        const b = tryBuildOrRollback(p.name, work.web_index_file.content);
        if (!b.ok) {
          wrote = false;
          await report('/api/plugins/applied', { name: p.name, ok: false, error: b.error }, key);
        }
      }
      if (wrote) await report('/api/plugins/applied', { name: p.name, ok: true }, key);
    }

    // Whatever the pending set was, the aggregator must reflect the state the
    // worker just reported. Re-fetch so it includes the rows we just applied.
    if (changed) {
      const fresh = await call('/api/plugins/pending', null, key).catch(() => null);
      for (const idx of [fresh?.index_file || work.index_file, fresh?.web_index_file || work.web_index_file].filter(Boolean)) {
        const abs = resolve(REPO, idx.path);
        let current = null;
        try { current = readFileSync(abs, 'utf8'); } catch { /* missing */ }
        if (current !== idx.content) safeWrite(idx.path, idx.content);
      }

      console.log('[plugin-apply] restarting the app to load new code');
      restart();
      await waitForWorker();
    }

    // Verify anything materialized-but-not-yet-active, not just this pass's
    // pending set — a verify that missed its window used to strand a plugin.
    const toVerify = new Set([...(work.verify || []), ...pending.map((p) => p.name)]);
    for (const name of toVerify) {
      const v = await call('/api/plugins/verify', { name }, key).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (v?.ok) console.log(`[plugin-apply] verify ${name}: active`);
    }

    if (!changed) await sleep(20_000);
  } catch (e) {
    // Worker restarting or unreachable — normal during our own restart cycle.
    if (!/ECONNREFUSED|fetch failed|timeout/i.test(String(e?.message || e))) {
      console.error('[plugin-apply]', e?.message || e);
    }
    await sleep(15_000);
  }
}
