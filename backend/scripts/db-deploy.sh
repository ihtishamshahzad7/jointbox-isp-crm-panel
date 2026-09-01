#!/usr/bin/env bash
# RADIUS schema boundary is deployed separately from Prisma migrations.
set -uo pipefail
cd "$(dirname "$0")/.."

node scripts/fix-db-ownership.js || true

if ! bash scripts/radius-schema-apply.sh; then
  echo "  ✗ RADIUS schema separation failed; refusing to continue."
  exit 1
fi

MLOG="$(mktemp 2>/dev/null || echo "./.jb_migrate.log")"
trap 'rm -f "$MLOG"' EXIT
if ! npx prisma migrate deploy 2>"$MLOG"; then
  cat "$MLOG"
  for d in prisma/migrations/*/; do
    [ -f "$d/migration.sql" ] || continue
    name="$(basename "$d")"
    npx prisma migrate resolve --applied "$name" >/dev/null 2>&1 && echo "      baselined $name" || true
  done
  if ! npx prisma migrate deploy 2>"$MLOG"; then
    cat "$MLOG"
    exit 1
  fi
fi

npx prisma generate >/dev/null
echo "  ✓ application migrations deployed; RADIUS schema remains separately owned"
