#!/usr/bin/env bash
# Unit tests for load-env.sh — proves the missing-DATABASE_URL failure cannot
# recur: a standard .env with a quoted Prisma URL is loaded into the shell and
# available to child processes (psql, node heredocs).
#
# Run: bash scripts/lib/__tests__/load-env.test.sh
set -euo pipefail

cd "$(dirname "$0")/../../.."   # -> backend/
LIB="scripts/lib/load-env.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "  ✗ $1" >&2; exit 1; }
pass() { echo "  ✓ $1"; }

echo "load-env.sh:"

# 1. quoted URL with & and query params survives intact
cat >"$tmp/a.env" <<'EOF'
# a comment
DATABASE_URL="postgresql://u:p@localhost:5432/db?connection_limit=20&pool_timeout=30"
JWT_SECRET='has#hash and spaces'
PLAIN=bare value
EOF
out="$(bash -c 'source '"$LIB"'; load_env_file "'"$tmp/a.env"'"; printf "%s\n%s\n%s\n" "$DATABASE_URL" "$JWT_SECRET" "$PLAIN"')"
[ "$(sed -n 1p <<<"$out")" = 'postgresql://u:p@localhost:5432/db?connection_limit=20&pool_timeout=30' ] \
  || fail "DATABASE_URL not loaded intact (got: $(sed -n 1p <<<"$out"))"
pass "quoted Prisma URL with & loaded intact"
[ "$(sed -n 2p <<<"$out")" = 'has#hash and spaces' ] || fail "hash/space value mangled"
pass "single-quoted value with # and spaces preserved"
[ "$(sed -n 3p <<<"$out")" = 'bare value' ] || fail "bare value mangled"
pass "unquoted value with space preserved"

# 2. child process (simulating the node heredoc / psql) inherits the export
got="$(bash -c 'source '"$LIB"'; load_env_file "'"$tmp/a.env"'"; node -e "process.stdout.write(process.env.DATABASE_URL||\"MISSING\")"')"
[ "$got" != "MISSING" ] && [[ "$got" == postgresql://* ]] \
  || fail "child node process did not inherit DATABASE_URL"
pass "child process inherits DATABASE_URL (the exact bug that broke the heredoc)"

# 3. missing file is a safe no-op
bash -c 'source '"$LIB"'; load_env_file "'"$tmp/does-not-exist.env"'"' \
  || fail "missing env file should not error"
pass "missing .env is a safe no-op"

# 4. no value is echoed to stdout by the loader itself
noise="$(bash -c 'source '"$LIB"'; load_env_file "'"$tmp/a.env"'"' 2>&1)"
[ -z "$noise" ] || fail "loader printed to stdout/stderr: $noise"
pass "loader is silent (no secret leakage to logs)"

echo "load-env.sh: all passed"
