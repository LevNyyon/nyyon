#!/usr/bin/env bash
# Start on a container host: make sure the disk has a database, then run the
# same server the VM runs (worker + plugin applier + internal cron).
set -euo pipefail
STATE_DIR="${NYYON_STATE_DIR:-/var/data/wrangler}"
mkdir -p "$STATE_DIR"

# First boot on a fresh disk: create the schema. Idempotent — later boots see
# the tables already there and move on.
if [ ! -f "$STATE_DIR/.nyyon-initialized" ]; then
  echo "== first boot: building the database on the disk =="
  ( cd workers/api && npx wrangler d1 execute nyyon --local --persist-to "$STATE_DIR" --file ../../db/schema.sql ) || true
  for f in db/migrations/*.sql; do
    ( cd workers/api && npx wrangler d1 execute nyyon --local --persist-to "$STATE_DIR" --file "../../$f" ) >/dev/null 2>&1 || true
  done
  # Register the packs baked in at build time as installed-and-active.
  node deploy/register-bundled.mjs || true
  touch "$STATE_DIR/.nyyon-initialized"
fi

exec npm run server
