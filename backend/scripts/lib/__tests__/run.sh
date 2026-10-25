#!/usr/bin/env bash
# Runs all database-script regression tests. Pure tests always run; the
# integration test self-skips when no PostgreSQL server is available.
#
# Run: bash scripts/lib/__tests__/run.sh   (or: npm run test:db-scripts)
set -euo pipefail
cd "$(dirname "$0")"
here="$PWD"

echo "== pg-url unit tests =="
node "$here/pg-url.test.js"
echo
echo "== load-env unit tests =="
bash "$here/load-env.test.sh"
echo
echo "== db-deploy integration test =="
bash "$here/db-deploy.integration.test.sh"
echo
echo "All database-script tests passed."
