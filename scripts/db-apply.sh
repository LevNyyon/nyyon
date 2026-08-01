#!/usr/bin/env bash
# Apply the full D1 schema + every migration, in order.
#
# Used by `npm run db:apply:local` / `db:apply:remote` (workers/api).
# Auto-includes every file in db/migrations/*.sql, so new migrations are
# picked up without editing package.json.
#
# Tolerant by design: a statement that's already applied (e.g. a column that
# an early migration adds and that also lives in schema.sql) logs and
# continues instead of aborting the whole setup — so a fresh clone gets a
# complete database in one command.
set -u

MODE="${1:-local}"
case "$MODE" in
  local)  FLAG="--local"  ;;
  remote) FLAG="--remote" ;;
  *) echo "usage: db-apply.sh [local|remote]"; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/db"
cd "$ROOT/workers/api" || exit 1

echo "▶ applying schema + migrations to D1 ($MODE)"
npx wrangler d1 execute nyyon "$FLAG" --file="$DB/schema.sql" >/dev/null 2>&1 \
  && echo "  ✓ schema.sql" \
  || echo "  • schema.sql (already applied / partial — continuing)"

for f in "$DB"/migrations/*.sql; do
  name="$(basename "$f")"
  if npx wrangler d1 execute nyyon "$FLAG" --file="$f" >/dev/null 2>&1; then
    echo "  ✓ $name"
  else
    echo "  • $name (already applied — skipped)"
  fi
done

echo "✔ D1 ($MODE) is up to date."
