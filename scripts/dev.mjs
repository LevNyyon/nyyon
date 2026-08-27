#!/usr/bin/env node
// `npm start` — runs the worker and the web app together.
//
// Two processes rather than one because that is what the stack is: a
// Cloudflare Worker (locally: workerd against a SQLite file) serving the API,
// and Vite serving the SPA and proxying /api and /__gate to it. Running them
// under one command just means nobody has to know that on day one.
//
// Ctrl-C stops both. If either dies, the other is torn down too — a half-dead
// app that still paints but cannot answer is worse than a clean exit.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(repo, 'workers', 'api');
const web = join(repo, 'web');

if (!existsSync(join(api, 'node_modules')) || !existsSync(join(web, 'node_modules'))) {
  console.error('\x1b[31m✗ Dependencies are missing.\x1b[0m Run: npm run setup');
  process.exit(1);
}
if (!existsSync(join(api, '.dev.vars'))) {
  console.error('\x1b[31m✗ No .dev.vars — this install has no session secret.\x1b[0m Run: npm run setup');
  process.exit(1);
}

const API_PORT = process.env.NYYON_API_PORT || '8799';
const WEB_PORT = process.env.NYYON_WEB_PORT || '5180';

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 300);
}

function start(name, cmd, args, cwd, colour) {
  const child = spawn(cmd, args, { cwd, env: process.env });
  children.push(child);
  const tag = `\x1b[${colour}m[${name}]\x1b[0m `;
  const pipe = (stream, to) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) to.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`\n\x1b[31m${name} exited (${code}).\x1b[0m Stopping the other half too.`);
    stopAll(code ?? 1);
  });
  return child;
}

console.log(`\nStarting…  api :${API_PORT}   web :${WEB_PORT}\n`);
// NYYON_HOST=0.0.0.0 opens the app to the network — the VM/server edition
// sets it so the web UI is reachable from outside the guest. Unset (the
// default, laptop install) everything stays loopback-only.
const HOST = process.env.NYYON_HOST || '';
start('api', 'npx', ['wrangler', 'dev', '--port', API_PORT, '--local', ...(HOST ? ['--ip', HOST] : [])], api, '36');
start('web', 'npx', ['vite', '--port', WEB_PORT, ...(HOST ? ['--host', HOST] : [])], web, '35');

setTimeout(() => {
  console.log(`\n\x1b[1m\x1b[32m→ http://localhost:${WEB_PORT}\x1b[0m\n`);
}, 4000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
