#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

# NAS is shared application configuration in Jointbox and is referenced by
# foreign keys from public tables (Subscriber, IpPool, NetworkLog, etc.).
# Moving it behind a public view would break future Prisma FK migrations.
# Keep the NAS config table public; expose radius.nas as a read-only RADIUS view.

RADIUS_DB_USER="${RADIUS_DB_USER:-$(node -e "const u=new URL(process.env.RADIUS_DATABASE_URL || process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.username))")}" 
ADMIN_DB_URL="${ADMIN_DATABASE_URL:-$DATABASE_URL}"

if [[ ! "$RADIUS_DB_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "✗ Invalid RADIUS_DB_USER"
  exit 1
fi

psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 <<SQL
SET lock_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS radius;

DO \$\$
DECLARE
  t text;
  tables text[] := ARRAY[
    'radcheck','radreply','radacct','radgroupcheck','radgroupreply',
    'radusergroup','radpostauth','nasreload'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('radius.' || t) IS NULL
       AND to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA radius', t);
    END IF;
  END LOOP;
END \$\$;

-- Compatibility views preserve the existing Prisma/raw-SQL public names.
DO \$\$
DECLARE
  t text;
  tables text[] := ARRAY[
    'radcheck','radreply','radacct','radgroupcheck','radgroupreply',
    'radusergroup','radpostauth','nasreload'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('radius.' || t) IS NOT NULL
       AND to_regclass('public.' || t) IS NULL THEN
      EXECUTE format('CREATE VIEW public.%I AS SELECT * FROM radius.%I', t, t);
    END IF;
  END LOOP;
END \$\$;

-- NAS remains a public application table because public foreign keys point to
-- it. FreeRADIUS may use radius.nas without duplicating the configuration.
DO \$\$
BEGIN
  IF to_regclass('public.nas') IS NOT NULL AND to_regclass('radius.nas') IS NULL THEN
    EXECUTE 'CREATE VIEW radius.nas AS SELECT * FROM public.nas';
  END IF;
END \$\$;

GRANT USAGE ON SCHEMA radius TO "${RADIUS_DB_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA radius TO "${RADIUS_DB_USER}";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA radius TO "${RADIUS_DB_USER}";
GRANT SELECT ON public.radcheck, public.radreply, public.radacct,
  public.radgroupcheck, public.radgroupreply, public.radusergroup,
  public.radpostauth, public.nasreload TO "${RADIUS_DB_USER}";
GRANT SELECT ON radius.nas TO "${RADIUS_DB_USER}";
SQL

# Point FreeRADIUS at the separated authentication/accounting objects. Missing
# config files are tolerated so the CRM can be deployed before FreeRADIUS exists.
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

if command -v freeradius >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files freeradius.service >/dev/null 2>&1; then
  freeradius -XC >/dev/null 2>&1 || { echo "✗ FreeRADIUS config check failed after schema update"; exit 1; }
  systemctl restart freeradius
fi

echo "✓ RADIUS auth/accounting tables isolated in schema radius; NAS remains shared safely"
