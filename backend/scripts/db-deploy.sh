#!/usr/bin/env bash
#
# db-deploy.sh — deploy application schema safely on a client database.
#
# GUARANTEES (see also docs/INSTALL.md):
#   * Loads backend/.env so EVERY child (node heredoc, psql, radius-schema-apply)
#     sees DATABASE_URL — not just node scripts that call require('dotenv').
#   * Runs forward-only `prisma migrate deploy`. Never `prisma db push`, never
#     auto-resolves a failed migration, never resets/drops a client database.
#   * Keeps application Prisma migrations and the separately-managed RADIUS
#     schema apart; `nas` stays in public (public FKs point to it).
#   * Idempotent: safe to re-run on an already-installed client.
#   * Fails fast with a clear message and nonzero exit on any genuine error.
#   * Never prints DATABASE_URL or any secret.
set -euo pipefail

cd "$(dirname "$0")/.."
SCRIPT_DIR="scripts"

# --- load environment for all child processes -------------------------------
# shellcheck source=scripts/lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
load_env_file ".env"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ db-deploy: DATABASE_URL is not set (checked environment and backend/.env)" >&2
  echo "  Set it in backend/.env, then re-run: npm run db:deploy" >&2
  exit 1
fi
export DATABASE_URL

# --- normalise object ownership (safe no-op if already correct) --------------
node "$SCRIPT_DIR/fix-db-ownership.js" || true

# --- detect whether the separately-managed RADIUS schema already exists ------
# Existing installations are already on the separated boundary, so RADIUS must
# be protected BEFORE any new application migration. A fresh database has no
# radius schema yet; the baseline migration creates the legacy RADIUS tables
# first, then this deployment moves them immediately afterward.
#
# This runs via `node -r dotenv/config` AND with env already exported, so it is
# robust whether or not dotenv is present. A genuine connection/query error
# here must stop the deploy (we cannot know which order is safe), so we fail
# with a clear message instead of guessing.
set +e
RADIUS_SCHEMA_EXISTS="$(node -r dotenv/config - <<'NODE'
const { Client } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL missing in RADIUS pre-check'); process.exit(2); }
const c = new Client({ connectionString: url });
(async () => {
  await c.connect();
  const r = await c.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'radius') AS exists");
  process.stdout.write(r.rows[0].exists ? '1' : '0');
  await c.end();
})().catch(async (e) => {
  console.error('RADIUS pre-check failed:', e.message);
  try { await c.end(); } catch {}
  process.exit(1);
});
NODE
)"
radius_check_rc=$?
set -e
if [ "$radius_check_rc" -ne 0 ] || { [ "$RADIUS_SCHEMA_EXISTS" != "0" ] && [ "$RADIUS_SCHEMA_EXISTS" != "1" ]; }; then
  echo "✗ db-deploy: could not determine RADIUS schema state (database unreachable or query failed)." >&2
  echo "  Deployment stopped before any migration. Fix connectivity/credentials and re-run." >&2
  exit 1
fi

# Existing install: separate RADIUS out of the way BEFORE migrating.
if [ "$RADIUS_SCHEMA_EXISTS" = "1" ]; then
  bash "$SCRIPT_DIR/radius-schema-apply.sh"
fi

# --- forward-only application migrations -------------------------------------
# Never use `prisma db push` here and never auto-resolve failed migrations as
# applied. A real migration error must stop deployment with a nonzero exit.
npx prisma migrate deploy

# Fresh install: the baseline migration just created the legacy RADIUS tables
# in public; move them into the radius schema now.
if [ "$RADIUS_SCHEMA_EXISTS" = "0" ]; then
  bash "$SCRIPT_DIR/radius-schema-apply.sh"
fi

npx prisma generate >/dev/null
echo "✓ application migrations deployed; RADIUS schema is separately owned"
