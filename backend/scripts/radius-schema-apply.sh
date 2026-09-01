#!/usr/bin/env bash
set -euo pipefail

# RADIUS schema ownership is deliberately outside Prisma migrations.
# The real tables live in PostgreSQL schema `radius`; public compatibility
# views keep existing Prisma/raw-SQL application code working during rollout.

: "${DATABASE_URL:?DATABASE_URL is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SET lock_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS radius;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'radcheck','radreply','radacct','radgroupcheck','radgroupreply',
    'radusergroup','radpostauth','nas','nasreload'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('radius.' || t) IS NULL
       AND to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA radius', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'radcheck','radreply','radacct','radgroupcheck','radgroupreply',
    'radusergroup','radpostauth','nas','nasreload'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('radius.' || t) IS NOT NULL
       AND to_regclass('public.' || t) IS NULL THEN
      EXECUTE format(
        'CREATE VIEW public.%I AS SELECT * FROM radius.%I', t, t
      );
    END IF;
  END LOOP;
END $$;
SQL

for f in \
  /etc/freeradius/3.0/mods-config/sql/main/postgresql/queries.conf \
  /etc/freeradius/3.0/mods-enabled/sql; do
  if [[ -f "$f" ]]; then
    sed -i \
      -e 's/^[[:space:]]*authcheck_table[[:space:]]*=.*/    authcheck_table  = "radius.radcheck"/' \
      -e 's/^[[:space:]]*authreply_table[[:space:]]*=.*/    authreply_table   = "radius.radreply"/' \
      -e 's/^[[:space:]]*groupcheck_table[[:space:]]*=.*/    groupcheck_table  = "radius.radgroupcheck"/' \
      -e 's/^[[:space:]]*groupreply_table[[:space:]]*=.*/    groupreply_table   = "radius.radgroupreply"/' \
      -e 's/^[[:space:]]*usergroup_table[[:space:]]*=.*/    usergroup_table   = "radius.radusergroup"/' \
      -e 's/^[[:space:]]*acct_table1[[:space:]]*=.*/    acct_table1       = "radius.radacct"/' \
      -e 's/^[[:space:]]*postauth_table[[:space:]]*=.*/    postauth_table    = "radius.radpostauth"/' \
      "$f"
  fi
done

if command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files freeradius.service >/dev/null 2>&1; then
  systemctl restart freeradius || true
fi

echo "✓ RADIUS tables are isolated in schema radius; compatibility views are ready"
