#!/usr/bin/env node
// `npm run server` — the VM / always-on edition. One process instead of two.
//
// Where `npm start` (dev.mjs) runs Vite's dev server next to the worker for
// the edit-and-see laptop loop, this runs ONLY the worker, which serves the
// COMPILED SPA from web/dist via the assets binding. Nothing development-
// grade faces the network: the worker binds loopback and a reverse proxy
// (Caddy on the VM image) is the only thing with a public ear.
//
// --test-scheduled exposes /__scheduled so the image's cron shim (a systemd
// timer) can fire the scheduled work wrangler cannot fire itself off-cloud.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(repo, 'workers', 'api');
const web = join(repo, 'web');

if (!existsSync(join(api, 'node_modules'))) {
  console.error('✗ Dependencies are missing. Run: npm run setup');
  process.exit(1);
}
if (!existsSync(join(api, '.dev.vars'))) {
  console.error('✗ No .dev.vars — this install has no session secret. Run: npm run setup');
  process.exit(1);
}

// The compiled SPA is a build product, not a checkout file. Build it if it is
// missing or the source is newer — first boot, and after any self-edit.
// Rebuild when dist is missing OR older than any source file. Building only on
// "missing" meant a source update (a sync, a git pull, an edit) kept serving a
// stale bundle forever: a page added to the app simply never appeared, with
// nothing on screen or in the log to say why.
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}
const distIndex = join(web, 'dist', 'index.html');
const distAt = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
if (!distAt || newestSourceMtime(web) > distAt) {
  console.log(distAt ? 'Web sources changed — rebuilding…' : 'Building the web app (first run)…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: web, stdio: 'inherit' });
  // A failed build must be LOUD: continuing would silently serve the old
  // bundle, which is exactly how a stale UI hides a broken deploy.
  if (r.status !== 0) {
    console.error('\n✗ The web build failed. The app would serve a stale bundle, so it is not starting.');
    console.error('  Fix the errors above (a common cause is a source file deleted upstream but left behind by a sync).');
    process.exit(r.status ?? 1);
  }
}

// PORT is what container hosts assign and then route to; NYYON_API_PORT is
// the VM's fixed port behind Caddy. Honour the platform first.
const PORT = process.env.PORT || process.env.NYYON_API_PORT || '8799';
// Where the install's DATA lives. On a VM that is the checkout itself; on a
// container host it must be the mounted disk, or every deploy wipes the
// operator's database. Either way it is a plain directory on this machine —
// nothing is hosted elsewhere.
const STATE_DIR = process.env.NYYON_STATE_DIR || '';
// 0.0.0.0 when something in front of us (Caddy on the VM, the platform's
// router on a container host) needs to reach the port.
const BIND = process.env.NYYON_BIND_IP || '127.0.0.1';
const child = spawn('npx',
  ['wrangler', 'dev', '--port', PORT, '--ip', BIND, '--local', '--test-scheduled',
   ...(STATE_DIR ? ['--persist-to', STATE_DIR] : [])],
  { cwd: api, stdio: 'inherit' });

// The plugin applier runs beside the worker. A Worker cannot write its own
// source, so without this sidecar a code-bearing plugin imports, reaches
// `bound`, and stays there — the Plugins module looks broken for a reason
// nothing on screen explains. It is idle (one poll every 20s) until there is
// work, and it no-ops when no applier key exists yet.
const sidecars = [
  ['plugin applier', join(repo, 'services', 'plugins', 'apply.mjs')],
  // The Telegram line's only inbound path — a Worker cannot hold a long poll
  // open. It sleeps until a bot token exists, so it costs nothing when unused.
  ['telegram poll', join(repo, 'services', 'telegram', 'poll.mjs')],
].map(([label, script]) => {
  const p = spawn(process.execPath, [script], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, NYYON_API_PORT: PORT, PORT: undefined, NYYON_RESTART_CMD: process.env.NYYON_RESTART_CMD ?? '' },
  });
  p.on('error', (e) => console.error(`[server] ${label} failed to start:`, e?.message || e));
  return p;
});

// The cron shim. On the VM a systemd timer fires these; a container host has
// no systemd, so the same schedule runs from inside this process. Identical
// effect: the install drives its own scheduled work, nothing external does.
if (process.env.NYYON_INTERNAL_CRON === '1') {
  const LEGS = ['0 * * * *', '45 * * * *', '0 6 * * *'];
  let lastHour = -1;
  let lastDay = '';
  const fire = async (cron) => {
    try {
      await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=${encodeURIComponent(cron)}`, { signal: AbortSignal.timeout(120_000) });
      console.log(`[cron] fired ${cron}`);
    } catch (e) { console.error(`[cron] ${cron}:`, e?.message || e); }
  };
  setInterval(() => {
    const d = new Date();
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    if (m < 5 && h !== lastHour) { lastHour = h; void fire(LEGS[0]); if (h === 6 && day !== lastDay) { lastDay = day; void fire(LEGS[2]); } }
    if (m >= 45 && m < 50 && lastHour === h) { void fire(LEGS[1]); lastHour = -2; }
  }, 60_000);
  console.log('[server] internal cron shim armed (hourly, :45, daily 06:00 UTC)');
}

const stop = () => {
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  for (const p of sidecars) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
};
child.on('exit', (code) => { stop(); process.exit(code ?? 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
