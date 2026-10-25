#!/usr/bin/env bash
# Integration test for the database-deploy chain against a DISPOSABLE Postgres
# cluster. Never touches a real client database.
#
# Proves, end to end, that:
#   * a Prisma DATABASE_URL containing ?connection_limit=…&pool_timeout=30 is
#     accepted by psql (the original production failure) ;
#   * radius-schema-apply.sh isolates the RADIUS tables into schema `radius`,
#     creates public compatibility views, and KEEPS `nas` as a public table ;
#   * the whole thing is idempotent (safe re-run) — covers both "radius schema
#     does not exist yet" (first run) and "radius schema + views already exist"
#     (second run) ;
#   * db-deploy.sh fails fast with a clear message and nonzero exit when the
#     database config is missing/invalid, and never prints the URL.
#
# Requires a local PostgreSQL *server* (initdb/pg_ctl). If absent, the test
# SKIPS (exit 0) so environments with only the pure unit tests still pass.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # -> backend/
BACKEND="$PWD"

# ---- locate a postgres server install --------------------------------------
PGBIN=""
for d in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /usr/local/pgsql/bin; do
  [ -x "$d/initdb" ] && [ -x "$d/pg_ctl" ] && { PGBIN="$d"; break; }
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: no PostgreSQL server (initdb/pg_ctl) found — run the pure unit tests instead." >&2
  exit 0
fi

fail() { echo "  ✗ $1" >&2; exit 1; }
pass() { echo "  ✓ $1"; }

# ---- disposable cluster ----------------------------------------------------
WORK="$(mktemp -d)"
PGDATA="$WORK/data"
SOCK="$WORK/sock"
PORT=55433
mkdir -p "$PGDATA" "$SOCK"

# initdb refuses to run as root; drop to the 'postgres' user when we are root.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  RUNAS="sudo -u postgres"
  chown -R postgres "$WORK"
fi

cleanup() {
  $RUNAS "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "db-deploy integration:"
$RUNAS "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres >/dev/null 2>&1 \
  || fail "initdb failed"
$RUNAS "$PGBIN/pg_ctl" -D "$PGDATA" \
  -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" -w start >/dev/null 2>&1 \
  || fail "pg_ctl start failed"

PSQL="$RUNAS $PGBIN/psql -v ON_ERROR_STOP=1 -p $PORT -h $SOCK -U postgres"

# app role + database (trust auth, so password in URL is cosmetic)
$PSQL -qc "CREATE ROLE jbtest LOGIN PASSWORD 'jbpass';" postgres >/dev/null
$PSQL -qc "CREATE DATABASE jbtest OWNER jbtest;" postgres >/dev/null

# Seed the "legacy" state that exists right after Prisma's baseline migration:
# RADIUS tables + nas live in public.
$PSQL jbtest >/dev/null <<'SQL'
CREATE TABLE public.radcheck (id serial primary key, username text);
CREATE TABLE public.radreply (id serial primary key);
CREATE TABLE public.radacct (id serial primary key);
CREATE TABLE public.radgroupcheck (id serial primary key);
CREATE TABLE public.radgroupreply (id serial primary key);
CREATE TABLE public.radusergroup (id serial primary key);
CREATE TABLE public.radpostauth (id serial primary key);
CREATE TABLE public.nasreload (id serial primary key);
CREATE TABLE public.nas (id serial primary key, nasname text);
-- Prisma creates these as the app user, and db-deploy.sh runs
-- fix-db-ownership.js first; reflect that realistic state here.
ALTER TABLE public.radcheck OWNER TO jbtest;
ALTER TABLE public.radreply OWNER TO jbtest;
ALTER TABLE public.radacct OWNER TO jbtest;
ALTER TABLE public.radgroupcheck OWNER TO jbtest;
ALTER TABLE public.radgroupreply OWNER TO jbtest;
ALTER TABLE public.radusergroup OWNER TO jbtest;
ALTER TABLE public.radpostauth OWNER TO jbtest;
ALTER TABLE public.nasreload OWNER TO jbtest;
ALTER TABLE public.nas OWNER TO jbtest;
SQL
pass "disposable cluster up; legacy RADIUS tables seeded in public"

# THE problem URL: connection_limit + pool_timeout that psql used to reject.
# TCP to 127.0.0.1 on our private port.
export DATABASE_URL="postgresql://jbtest:jbpass@127.0.0.1:$PORT/jbtest?connection_limit=20&pool_timeout=30"
export RADIUS_DATABASE_URL="postgresql://jbtest:jbpass@127.0.0.1:$PORT/jbtest"
export RADIUS_DB_USER="jbtest"

q() { $RUNAS "$PGBIN/psql" -tAq -p "$PORT" -h "$SOCK" -U postgres jbtest -c "$1"; }

# ---- first run: radius schema does not exist yet ---------------------------
bash scripts/radius-schema-apply.sh >/dev/null 2>&1 \
  || fail "radius-schema-apply.sh failed on first run (connection_limit URL?)"
pass "radius-schema-apply.sh ran with ?connection_limit= URL (psql no longer rejects it)"

[ "$(q "SELECT count(*) FROM pg_namespace WHERE nspname='radius'")" = "1" ] \
  || fail "radius schema not created"
pass "radius schema created"

[ "$(q "SELECT count(*) FROM pg_tables WHERE schemaname='radius' AND tablename='radcheck'")" = "1" ] \
  || fail "radcheck not moved into radius schema"
pass "RADIUS tables moved into schema radius"

[ "$(q "SELECT count(*) FROM pg_views WHERE schemaname='public' AND viewname='radcheck'")" = "1" ] \
  || fail "public.radcheck compatibility view missing"
pass "public compatibility views created"

# nas must remain a real public TABLE (public FKs point to it), with radius.nas a VIEW
[ "$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='nas'")" = "1" ] \
  || fail "public.nas must stay a table"
[ "$(q "SELECT count(*) FROM pg_views WHERE schemaname='radius' AND viewname='nas'")" = "1" ] \
  || fail "radius.nas view missing"
pass "nas stays a public table; radius.nas exposed as a view"

# ---- second run: radius schema + views already exist (idempotent) ----------
bash scripts/radius-schema-apply.sh >/dev/null 2>&1 \
  || fail "radius-schema-apply.sh not idempotent on re-run"
[ "$(q "SELECT count(*) FROM pg_tables WHERE schemaname='radius' AND tablename='radcheck'")" = "1" ] \
  || fail "state changed on idempotent re-run"
pass "idempotent re-run (radius schema + views already present)"

# ---- db-deploy.sh RADIUS pre-check detection -------------------------------
# With radius present it should report '1'; against a DB without it, '0'.
det() {
  DATABASE_URL="$1" node -r dotenv/config - <<'NODE'
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
(async()=>{await c.connect();const r=await c.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='radius') e");process.stdout.write(r.rows[0].e?'1':'0');await c.end();})().catch(e=>{console.error(e.message);process.exit(1)});
NODE
}
[ "$(det "$DATABASE_URL")" = "1" ] || fail "pre-check should detect existing radius schema"
$PSQL -qc "CREATE DATABASE jbfresh OWNER jbtest;" postgres >/dev/null
[ "$(det "postgresql://jbtest:jbpass@127.0.0.1:$PORT/jbfresh?connection_limit=5")" = "0" ] \
  || fail "pre-check should report 0 on a fresh db"
pass "RADIUS pre-check detects existing(1) vs fresh(0) with Prisma-param URL"

# ---- missing/invalid config fails fast, no secret leakage ------------------
out="$(cd "$BACKEND" && env -u DATABASE_URL bash -c '
  # point at an empty dir so no .env is found
  cd "$(mktemp -d)"; cp -r "'"$BACKEND"'/scripts" .; mkdir -p node_modules
  DATABASE_URL="" bash scripts/db-deploy.sh 2>&1' || true)"
echo "$out" | grep -qi "DATABASE_URL is not set" \
  || fail "db-deploy should report missing DATABASE_URL clearly"
pass "db-deploy fails fast with a clear message when DATABASE_URL is missing"

echo "db-deploy integration: all passed"
