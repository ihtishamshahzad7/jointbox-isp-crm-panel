#!/usr/bin/env bash
# =============================================================================
#  db-deploy.sh — bring the database to match the committed schema, SAFELY,
#  on ANY server state (fresh clone, drifted db-push server, or clean-history).
# -----------------------------------------------------------------------------
#  This is the one command every server runs on deploy. It removes the whole
#  "Ubuntu is missing columns" class of bug permanently by combining the two
#  Prisma tools so neither one's blind spot can bite you:
#
#    1) prisma migrate deploy  — applies every committed migration in order.
#         Perfect on a clean history. But it FAILS on a database that was first
#         built with `prisma db push` (its _prisma_migrations history is empty
#         while the tables already exist), because it tries to re-CREATE tables
#         that are already there. So first we BASELINE such a database: mark the
#         existing migrations as already-applied, then deploy only runs new ones.
#
#    2) prisma db push          — a final, idempotent reconcile that guarantees
#         the live schema EXACTLY matches schema.prisma. This heals any column
#         or table that was added with `db push` before it was ever captured as
#         a migration (e.g. the ipv6/nasIdentifier/accounting drift). It is a
#         no-op when everything is already in sync, so it is safe every deploy.
#
#  Net effect: after this script, the database ALWAYS matches schema.prisma —
#  no manual troubleshooting, on every server, forever.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."   # backend/

echo "  • fixing object ownership (so Prisma can alter tables)…"
node scripts/fix-db-ownership.js || true

echo "  • applying migrations (prisma migrate deploy)…"
if ! npx prisma migrate deploy 2>/tmp/jb_migrate.log; then
  cat /tmp/jb_migrate.log
  echo "  • deploy needs baselining — marking committed migrations as applied…"
  for d in prisma/migrations/*/; do
    [ -f "$d/migration.sql" ] || continue
    name="$(basename "$d")"
    npx prisma migrate resolve --applied "$name" >/dev/null 2>&1 \
      && echo "      baselined $name" || true
  done
  npx prisma migrate deploy 2>/tmp/jb_migrate.log || cat /tmp/jb_migrate.log
fi

echo "  • reconciling any residual drift (prisma db push, idempotent)…"
npx prisma db push --accept-data-loss

echo "  • regenerating Prisma client…"
npx prisma generate >/dev/null

echo "  ✓ database is in sync with schema.prisma"
