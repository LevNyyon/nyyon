#!/usr/bin/env node
// Prepare this instance's OWN database, on its own disk.
//
// Creates the miniflare D1 file wrangler will open, applies schema + every
// migration, and registers the packs baked in at build time. Idempotent: a
// redeploy re-runs it and finds the work already done. No network, no hosted
// database — the file lives on this machine.
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = process.env.NYYON_STATE_DIR || join(REPO, 'workers', 'api', '.wrangler', 'state');
const D1DIR = join(STATE, 'v3', 'd1', 'miniflare-D1DatabaseObject');
mkdirSync(D1DIR, { recursive: true });

// Miniflare names the file from the binding's database id. wrangler.jsonc uses
// the literal "LOCAL", and miniflare hashes it — match that so the server
// opens the database we just built rather than an empty second one.
const idFor = (s) => createHash('sha256').update(s).digest('hex');
const existing = readdirSync(D1DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const dbFile = existing.length
  ? join(D1DIR, existing.sort((a, b) => readFileSync(join(D1DIR, b)).length - readFileSync(join(D1DIR, a)).length)[0])
  : join(D1DIR, `${idFor('LOCAL')}.sqlite`);

// Does this instance have durable storage? The worker needs to know, because
// an install that cannot remember must not invite anyone to set it up.
const { storageReport } = await import('./check-persistence.mjs');
const storage = storageReport();
console.log(`[init] storage: ${storage.persistent ? 'PERSISTENT' : 'EPHEMERAL'} — ${storage.why}`);
if (!storage.persistent && process.env.NYYON_ALLOW_EPHEMERAL !== '1') {
  console.error('[init] Refusing to present a setup screen for data that would be erased.');
  console.error('[init] Attach a disk and point NYYON_STATE_DIR at it (Render: Starter plan,');
  console.error('[init] a 1GB disk at /var/data, NYYON_STATE_DIR=/var/data/wrangler).');
  console.error('[init] To run a deliberately throwaway demo: NYYON_ALLOW_EPHEMERAL=1');
}

// The worker reads its secrets from workers/api/.dev.vars (wrangler's local
// convention). A container has environment variables instead, so write the
// file from them — generating the ones that must simply exist and be stable
// for the life of this instance. Never overwrite an existing file.
{
  const varsPath = join(REPO, 'workers', 'api', '.dev.vars');
  if (!existsSync(varsPath)) {
    const gen = () => createHash('sha256').update(`${Math.random()}${Date.now()}${process.pid}`).digest('hex');
    const vars = {
      GATE_SECRET: process.env.GATE_SECRET || gen(),
      NYYON_APPLIER_KEY: process.env.NYYON_APPLIER_KEY || gen(),
      // The gate reads this and blocks account creation on throwaway storage.
      NYYON_STORAGE: storage.persistent ? 'persistent' : 'ephemeral',
      NYYON_STORAGE_WHY: storage.why,
      // Enough to send the operator straight to the right settings page.
      ...(storage.host ? { NYYON_HOST: storage.host } : {}),
      ...(process.env.RENDER_SERVICE_ID ? { NYYON_HOST_SERVICE_ID: process.env.RENDER_SERVICE_ID } : {}),
      ...(process.env.FLY_APP_NAME ? { NYYON_HOST_APP: process.env.FLY_APP_NAME } : {}),
      ...(process.env.NYYON_ALLOW_EPHEMERAL === '1' ? { NYYON_ALLOW_EPHEMERAL: '1' } : {}),
    };
    // Anything else the operator configured on the platform travels through
    // untouched (model keys, gateway credentials).
    for (const [k, v] of Object.entries(process.env)) {
      if (!v) continue;
      if (/^(ANTHROPIC|OPENAI|NYYON_GW_|WA_|LI_|UNIPILE|TELEGRAM|SERP|PDL|TWILIO|THEORG|DEV_API_KEY)/.test(k)) vars[k] = v;
    }
    writeFileSync(varsPath, Object.entries(vars).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join('\n') + '\n');
    console.log(`[init] wrote .dev.vars (${Object.keys(vars).length} keys) from the environment`);
  }
}

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys=ON');
const already = () => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugins'").get(); }
  catch { return false; }
};

if (!already()) {
  console.log('[init] building the database at', dbFile);
  // Whole-file exec first (node:sqlite runs multi-statement SQL, and it keeps
  // multi-line CREATEs intact). Only if a file trips — a historical migration
  // referencing a table later removed from the schema — fall back to
  // statement-at-a-time so ONE bad statement cannot skip the whole file.
  const run = (sql, label) => {
    try { db.exec(sql); return; } catch { /* fall through */ }
    let depth = 0, buf = '';
    const stmts = [];
    for (const ch of sql) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ';' && depth <= 0) { stmts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) stmts.push(buf);
    for (const raw of stmts) {
      const st = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      if (!st) continue;
      try { db.exec(st); } catch (e) {
        const m = String(e?.message || e);
        if (/already exists|duplicate column/i.test(m)) continue;
        console.error(`[init] ${label}: ${m.slice(0, 110)}`);
      }
    }
  };
  run(readFileSync(join(REPO, 'db', 'schema.sql'), 'utf8'), 'schema');
  for (const f of readdirSync(join(REPO, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    run(readFileSync(join(REPO, 'db', 'migrations', f), 'utf8'), f);
  }
  console.log('[init] schema + migrations applied');
} else {
  console.log('[init] database already present — leaving it alone');
}
db.close();

// Register the baked packs (its own module: it opens the same file).
const { execFileSync } = await import('node:child_process');
try { execFileSync(process.execPath, [join(REPO, 'deploy', 'register-bundled.mjs')], { stdio: 'inherit', env: process.env }); }
catch (e) { console.error('[init] register-bundled:', e?.message || e); }
