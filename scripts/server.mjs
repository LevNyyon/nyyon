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
import { existsSync } from 'node:fs';
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
if (!existsSync(join(web, 'dist', 'index.html'))) {
  console.log('Building the web app (first run)…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: web, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const PORT = process.env.NYYON_API_PORT || '8799';
const child = spawn('npx',
  ['wrangler', 'dev', '--port', PORT, '--ip', '127.0.0.1', '--local', '--test-scheduled'],
  { cwd: api, stdio: 'inherit' });

// The plugin applier runs beside the worker. A Worker cannot write its own
// source, so without this sidecar a code-bearing plugin imports, reaches
// `bound`, and stays there — the Plugins module looks broken for a reason
// nothing on screen explains. It is idle (one poll every 20s) until there is
// work, and it no-ops when no applier key exists yet.
const applier = spawn(process.execPath, [join(repo, 'services', 'plugins', 'apply.mjs')], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, NYYON_API_PORT: PORT, NYYON_RESTART_CMD: process.env.NYYON_RESTART_CMD ?? '' },
});
applier.on('error', (e) => console.error('[server] plugin applier failed to start:', e?.message || e));

const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } try { applier.kill('SIGTERM'); } catch { /* gone */ } };
child.on('exit', (code) => { stop(); process.exit(code ?? 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
