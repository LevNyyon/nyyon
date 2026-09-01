#!/usr/bin/env bash
# Build for a container host. Same steps the VM installer runs, minus the
# machine setup the platform already did.
set -euo pipefail
echo "== deps =="
npm install --no-audit --no-fund
( cd web && npm install --no-audit --no-fund )
( cd workers/api && npm install --no-audit --no-fund )

echo "== bake the bundled plugins into the source tree =="
# A container's filesystem is rebuilt on every deploy, so the applier's
# runtime materialization cannot be the only path — the packs are baked in
# at BUILD time, exactly as they are for any non-writable host.
node scripts/bundle-schema.mjs
node scripts/materialize-bundled.mjs

echo "== build the app =="
( cd web && npm run build )
echo "BUILD OK"
