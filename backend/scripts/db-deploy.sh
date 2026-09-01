#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/fix-db-ownership.js || true

# Existing installations are already on the separated boundary, so protect
# RADIUS before any new application migration. A fresh database has no radius
# schema yet; the baseline migration creates the legacy RADIUS tables first,
# then this deployment moves them immediately afterward.
RADIUS_SCHEMA_EXISTS="$(node - <<'NODE'
const { Client } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) process.exit(2);
const c = new Client({ connectionString: url });
(async () => {
  await c.connect();
  const r = await c.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'radius') AS exists");
  process.stdout.write(r.rows[0].exists ? '1' : '0');
  await c.end();
})().catch(async e => { console.error(e.message); try { await c.end(); } catch {} process.exit(1); });
NODE
)"

if [[ "$RADIUS_SCHEMA_EXISTS" == "1" ]]; then
  bash scripts/radius-schema-apply.sh
fi

# Never use prisma db push here and never auto-resolve failed migrations as
# applied. A real migration error must stop deployment.
npx prisma migrate deploy

if [[ "$RADIUS_SCHEMA_EXISTS" == "0" ]]; then
  bash scripts/radius-schema-apply.sh
fi

npx prisma generate >/dev/null
echo "✓ application migrations deployed; RADIUS schema is separately owned"
