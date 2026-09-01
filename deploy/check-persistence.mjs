#!/usr/bin/env node
// Will this install REMEMBER anything?
//
// A container host gives every deploy a fresh filesystem. If the database sits
// on it rather than on a mounted disk, the operator can spend an hour setting
// up their world and lose all of it at the next restart — the worst failure
// this product can have, and a silent one. So we detect it and say so, loudly,
// BEFORE anyone is invited to create an account.
//
// The test: a real mounted volume is a DIFFERENT device than the root
// filesystem. Same device on a container host means the data is temporary.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function storageReport() {
  const stateDir = process.env.NYYON_STATE_DIR
    || join(REPO, 'workers', 'api', '.wrangler', 'state');
  try { mkdirSync(stateDir, { recursive: true }); } catch { /* checked below */ }

  // Which hosts hand out a throwaway filesystem. On a VM or a laptop the root
  // filesystem IS the disk, so "same device" there is perfectly durable.
  const containerHost =
    process.env.RENDER ? 'Render' :
    process.env.FLY_APP_NAME ? 'Fly.io' :
    process.env.RAILWAY_ENVIRONMENT ? 'Railway' :
    existsSync('/.dockerenv') ? 'a container' : null;

  if (!containerHost) return { persistent: true, why: 'not a container host — the filesystem is the machine\'s own disk', stateDir };

  let sameDeviceAsRoot = true;
  try { sameDeviceAsRoot = statSync(stateDir).dev === statSync('/').dev; } catch { /* assume the worst */ }

  return {
    persistent: !sameDeviceAsRoot,
    host: containerHost,
    stateDir,
    why: sameDeviceAsRoot
      ? `on ${containerHost}, ${stateDir} is on the container filesystem — it is erased on every restart and redeploy`
      : `${stateDir} is on a mounted volume — it survives restarts and redeploys`,
  };
}

// CLI: print the verdict; exit 1 when data would be lost, so a deploy step can
// stop rather than hand someone an install that forgets.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = storageReport();
  console.log(`[storage] ${r.persistent ? 'PERSISTENT' : 'EPHEMERAL'} — ${r.why}`);
  if (!r.persistent && process.env.NYYON_ALLOW_EPHEMERAL !== '1') process.exit(1);
}
