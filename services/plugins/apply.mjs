#!/usr/bin/env node
// Plugin applier — the self-hosted materializer.
//
// A Worker cannot load new code at runtime, so this sidecar closes the loop:
// it polls the worker for plugins in status `bound`, writes their code files
// under workers/api/src/plugins/<name>/, regenerates plugins/index.js from
// the full installed set (deterministic — never reads the old file), reports
// back, restarts the app, and then calls verify so the plugin flips active.
//
// Paths are HARD-SCOPED: this process refuses to write anything outside
// workers/api/src/plugins/. That guarantee is the applier's whole contract.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_ROOT = join(REPO, 'workers', 'api', 'src', 'plugins');
const API_PORT = process.env.NYYON_API_PORT || '8799';
const BASE = `http://127.0.0.1:${API_PORT}`;
const DEV_VARS = join(REPO, 'workers', 'api', '.dev.vars');

function applierKey() {
  try {
    const m = readFileSync(DEV_VARS, 'utf8').match(/^NYYON_APPLIER_KEY\s*=\s*"?([^"\n]+)"?/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// The path guard: everything lands inside PLUGIN_ROOT or is refused.
function safeWrite(repoRelPath, content) {
  const abs = resolve(REPO, repoRelPath);
  if (!abs.startsWith(PLUGIN_ROOT + sep) && abs !== join(PLUGIN_ROOT, 'index.js')) {
    throw new Error(`refusing to write outside the plugin root: ${repoRelPath}`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`[plugin-apply] wrote ${repoRelPath} (${content.length}b)`);
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

console.log('[plugin-apply] up — watching for bound plugins');
for (;;) {
  const key = applierKey();
  if (!key) { await sleep(60_000); continue; }
  try {
    const work = await call('/api/plugins/pending', null, key);
    const pending = work.pending || [];
    const removals = work.remove || [];
    if (!pending.length && !removals.length) { await sleep(20_000); continue; }

    for (const name of removals) {
      const dir = join(PLUGIN_ROOT, name);
      if (existsSync(dir)) { rmSync(dir, { recursive: true }); console.log(`[plugin-apply] removed ${name}/`); }
    }
    for (const p of pending) {
      try {
        for (const f of p.files) safeWrite(f.path, f.content);
        await call('/api/plugins/applied', { name: p.name, ok: true }, key);
      } catch (e) {
        console.error(`[plugin-apply] ${p.name} failed:`, e?.message || e);
        await call('/api/plugins/applied', { name: p.name, ok: false, error: String(e?.message || e) }, key).catch(() => {});
      }
    }
    // The aggregator is regenerated from the FULL installed set every pass.
    safeWrite(work.index_file.path, work.index_file.content);

    console.log('[plugin-apply] restarting the app to load new code');
    execSync('sudo systemctl restart nyyon', { stdio: 'inherit' });
    // Give wrangler time to boot, then flip verified plugins active.
    await sleep(20_000);
    for (const p of pending) {
      const v = await call('/api/plugins/verify', { name: p.name }, key).catch((e) => ({ ok: false, error: String(e) }));
      console.log(`[plugin-apply] verify ${p.name}:`, JSON.stringify(v));
    }
  } catch (e) {
    // Worker restarting or unreachable — normal during our own restart cycle.
    if (!/ECONNREFUSED|fetch failed|timeout/i.test(String(e?.message || e))) {
      console.error('[plugin-apply]', e?.message || e);
    }
    await sleep(15_000);
  }
}
