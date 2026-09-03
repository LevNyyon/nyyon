#!/usr/bin/env node
// Install nyyon into YOUR OWN Cloudflare account — free tier, no card.
//
// This is the agent-first installer: an AI agent (or a person) runs
//   npx wrangler login      (you click Allow in the browser)
//   npm run deploy
// and gets back a live URL plus a one-time setup link. Everything it creates
// — the worker, the database, the bucket — lives in YOUR account. Nothing is
// shared with anyone; there is no central server in this picture at all.
//
// Re-runnable: an existing database is KEPT (your data survives a redeploy),
// the worker is updated in place, and only missing secrets are minted.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'workers', 'api');
const NAME = (process.env.NYYON_NAME || 'nyyon').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const notes = [];
const say = (m) => console.log(`\n▸ ${m}`);

function sh(cmd, { cwd = ROOT, input, ok = false } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd, input, encoding: 'utf8', env: process.env,
    maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !ok) { console.error(out); throw new Error(`${cmd.join(' ')} failed`); }
  return { out, code: r.status ?? 1 };
}
const wr = (args, opts = {}) => sh(['npx', 'wrangler', ...args], { cwd: API, ...opts });

// ── 0. signed in? ──
// Two ways in, and an AGENT can only use the second: an interactive
// `wrangler login` needs a human at a browser, while CLOUDFLARE_API_TOKEN is
// pasted once and works headless. The README's front door hands the operator
// a pre-filled token link for exactly this reason.
say('checking Cloudflare access');
const hasToken = !!(process.env.CLOUDFLARE_API_TOKEN || '').trim();
const who = wr(['whoami'], { ok: true });
if (!hasToken && (who.code !== 0 || /not authenticated|please run.*login/i.test(who.out))) {
  console.error(`
No Cloudflare access yet. Two ways to give it:

  1. A token (works for an AI agent, no browser needed). Create one here, with
     Workers and D1 permissions already ticked:

     https://dash.cloudflare.com/profile/api-tokens/create

     Then run:  CLOUDFLARE_API_TOKEN=<your token> npm run deploy

  2. Or sign in yourself:  npx wrangler login
     A browser opens; sign in (the free account is email and password, no card)
     and click Allow. Then run \`npm run deploy\` again.
`);
  process.exit(1);
}
if (hasToken) say('using CLOUDFLARE_API_TOKEN');

// ── 1. dependencies + build ──
say('installing dependencies (first run only)');
for (const d of [ROOT, join(ROOT, 'web'), API]) {
  if (!existsSync(join(d, 'node_modules'))) sh(['npm', 'install', '--no-audit', '--no-fund'], { cwd: d });
}
say('building the app');
sh(['node', 'scripts/bundle-schema.mjs']);
sh(['node', 'scripts/materialize-bundled.mjs']);
sh(['npx', 'vite', 'build'], { cwd: join(ROOT, 'web') });

// ── 2. your database ──
say(`database "${NAME}" (D1, durable, free tier)`);
let dbId;
const created = wr(['d1', 'create', NAME], { ok: true });
if (created.code === 0) {
  dbId = created.out.match(UUID)[0];
} else if (/already exists/i.test(created.out)) {
  dbId = (wr(['d1', 'info', NAME]).out.match(UUID) || [])[0];
  if (!dbId) throw new Error(`database "${NAME}" exists but its id could not be read`);
  notes.push(`kept your existing "${NAME}" database — nothing in it was touched`);
} else {
  console.error(created.out);
  throw new Error('could not create the database');
}

// ── 3. asset storage (optional — the app runs without it) ──
const bucket = `${NAME}-assets`;
const r2 = wr(['r2', 'bucket', 'create', bucket], { ok: true });
const hasR2 = r2.code === 0 || /already (exists|owned)/i.test(r2.out);
if (!hasR2) notes.push('R2 storage was not available on this account — image features are off, everything else works');

// ── 4. point the config at YOUR resources ──
let cfg = readFileSync(join(API, 'wrangler.jsonc'), 'utf8');
cfg = cfg.replace(/"name":\s*"[^"]*"/, `"name": "${NAME}"`);
cfg = cfg.replace(/"database_name":\s*"[^"]*"/, `"database_name": "${NAME}"`);
cfg = cfg.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${dbId}"`);
cfg = cfg.replace(/"workers_dev":\s*(true|false)/, '"workers_dev": true');
if (hasR2) cfg = cfg.replace(/"bucket_name":\s*"[^"]*"/g, `"bucket_name": "${bucket}"`);
else cfg = cfg.replace(/"r2_buckets":\s*\[[^\]]*\],?/s, '');
writeFileSync(join(API, 'wrangler.jsonc'), cfg);

// ── 5. deploy ──
say('deploying the worker');
let dep = wr(['deploy'], { ok: true });
if (dep.code !== 0 && /cron triggers per account/i.test(dep.out)) {
  // Account at Cloudflare's free 5-cron cap: ship without schedules rather
  // than fail. A fresh account never hits this.
  cfg = readFileSync(join(API, 'wrangler.jsonc'), 'utf8');
  writeFileSync(join(API, 'wrangler.jsonc'), cfg.replace(/"triggers":\s*\{[^}]*\},?/s, ''));
  notes.push('this account is at its cron-trigger cap, so scheduled jobs are off for this install');
  dep = wr(['deploy'], { ok: true });
}
if (dep.code !== 0) {
  console.error(dep.out);
  if (/subdomain/i.test(dep.out)) {
    console.error('\nYour account needs its free workers.dev subdomain first: open dash.cloudflare.com → Workers & Pages, pick any name when asked, then run `npm run deploy` again.');
  }
  process.exit(1);
}
const url = (dep.out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
if (!url) { console.error(dep.out); throw new Error('deployed, but no workers.dev URL in the output'); }

// ── 6. secrets: setup link + applier always fresh, sessions preserved ──
say('minting this install\'s keys');
const existing = new Set();
try { for (const s of JSON.parse(wr(['secret', 'list']).out)) existing.add(s.name); } catch { /* fine */ }
const setupToken = randomBytes(12).toString('hex');
const applierKey = randomBytes(24).toString('hex');
wr(['secret', 'put', 'SETUP_TOKEN'], { input: setupToken });
wr(['secret', 'put', 'NYYON_APPLIER_KEY'], { input: applierKey });
if (!existing.has('GATE_SECRET')) wr(['secret', 'put', 'GATE_SECRET'], { input: randomBytes(32).toString('hex') });

// ── 7. the database schema (idempotent — every statement IF NOT EXISTS) ──
say('building the database');
wr(['d1', 'execute', NAME, '--remote', '--file', 'src/generated/schema.sql']);

// ── 8. install the four bundled modules ──
say('installing the modules');
for (let i = 0; i < 20; i++) {
  try { if ((await fetch(`${url}/__up`)).ok) break; } catch { /* still waking */ }
  await new Promise((r) => setTimeout(r, 3000));
}
const packs = JSON.parse(readFileSync(join(ROOT, 'db', 'generated', 'bundled-manifests.json'), 'utf8'));
for (const m of packs) {
  // The first request can race the deploy's edge propagation (the fresh
  // secrets are not visible everywhere for a few seconds) — retry, don't fail.
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`${url}/api/plugins/import-bundled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${applierKey}` },
      body: JSON.stringify({ manifest: m, prematerialized: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) { last = d.status || 'active'; break; }
    last = String(d.errors?.[0] || d.error || `HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, attempt * 3000));
  }
  console.log(`   ${m.name}: ${last}`);
}

// ── done ──
console.log(`
========================================================
 Your nyyon is live:   ${url}

 Claim it (create your account, do this now):
 ${url}/?setup_token=${setupToken}

 The link stops working the moment the install has an
 owner. Your data lives in YOUR Cloudflare account.
========================================================`);
for (const n of notes) console.log(` note: ${n}`);
