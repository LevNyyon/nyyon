#!/usr/bin/env bash
# Start on a container host: prepare the disk, then run the same server the VM
# runs (worker + plugin applier + the internal cron shim).
#
# The database is built with node:sqlite rather than one `wrangler d1 execute`
# per migration: ~75 process spawns delayed the open port by minutes and the
# platform's port scan gave up before the app ever answered.
set -euo pipefail
export NYYON_STATE_DIR="${NYYON_STATE_DIR:-/var/data/wrangler}"
mkdir -p "$NYYON_STATE_DIR"

node deploy/init-state.mjs

exec npm run server
