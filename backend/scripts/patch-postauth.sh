#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Extend FreeRADIUS post-auth logging so EVERY Access-Accept/Reject stores the
# device MAC, NAS IP, NAS port (VLAN) and Called-Station-Id directly on the
# radpostauth row — so the panel's "Login Logs" has those columns even for
# rejected attempts (which never open a radacct session).
#
# Idempotent + safe:
#   • adds the columns if missing (ALTER TABLE ... IF NOT EXISTS)
#   • rewrites the post-auth query only if not already patched
#   • validates the new config with `freeradius -XC` and rolls back on failure
#
# Run as root. Called automatically by install.sh and update-jointbox.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAD=/etc/freeradius/3.0
QCONF="$RAD/mods-config/sql/main/postgresql/queries.conf"
DB="${DB_NAME:-jointbox}"

log(){ echo "  • $*"; }

# 1) Ensure the columns exist (schema push may already have added them; this is
#    a belt-and-braces no-op if so).
if command -v psql >/dev/null 2>&1; then
  sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<'SQL'
ALTER TABLE radpostauth ADD COLUMN IF NOT EXISTS callingstationid varchar(64);
ALTER TABLE radpostauth ADD COLUMN IF NOT EXISTS calledstationid  varchar(64);
ALTER TABLE radpostauth ADD COLUMN IF NOT EXISTS nasipaddress     varchar(64);
ALTER TABLE radpostauth ADD COLUMN IF NOT EXISTS nasportid        varchar(64);
SQL
  log "radpostauth columns ensured"
fi

[ -f "$QCONF" ] || { echo "  ! $QCONF not found — is the postgresql SQL module installed?"; exit 0; }

# 2) Already patched? Then nothing to do.
if grep -q "callingstationid" "$QCONF"; then
  log "post-auth query already captures MAC/NAS — nothing to change"
  exit 0
fi

cp -a "$QCONF" "$QCONF.bak.$(date +%s)"

# 3) SURGICAL edit: keep the distro's existing (known-good) post-auth INSERT and
#    only add the 4 extra columns + values. Replacing the whole block with a
#    hardcoded query is what kept failing `freeradius -XC` — versions differ in
#    quoting and the password xlat. Appending to the real query preserves the
#    exact working syntax, so it validates.
python3 - "$QCONF" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()

# Isolate the post-auth { ... } block so we don't touch accounting queries.
m = re.search(r'(post-auth\s*\{.*?\n\})', src, re.DOTALL)
if not m:
    print("  ! could not locate post-auth block — left unchanged"); sys.exit(0)
block = m.group(1)
orig = block

# 3a) Add the columns after `authdate` in the column list (first occurrence).
if 'callingstationid' not in block:
    block = re.sub(
        r'(\(\s*username\s*,\s*pass\s*,\s*reply\s*,\s*authdate)(\s*\))',
        r'\1, callingstationid, calledstationid, nasipaddress, nasportid\2',
        block, count=1)

# 3b) Add the matching values right before the closing `)"` of the VALUES(...).
#     `'%S'` is the authdate value in every distro default; insert after it.
if "'%{Calling-Station-Id}'" not in block:
    block = re.sub(
        r"('%S')(\s*\)\s*\")",
        r"\1, \\\n\t\t\t'%{Calling-Station-Id}', \\\n\t\t\t'%{Called-Station-Id}', \\\n\t\t\t'%{NAS-IP-Address}', \\\n\t\t\t'%{NAS-Port-Id}'\2",
        block, count=1)

if block != orig and 'callingstationid' in block:
    src = src[:m.start()] + block + src[m.end():]
    open(path, 'w').write(src)
    print("  • post-auth query extended with MAC/NAS/port columns")
else:
    print("  ! post-auth query shape not recognised — left unchanged (accounting unaffected)")
    sys.exit(0)
PY

# 4) Validate; roll back if FreeRADIUS refuses the new config.
ERR_LOG="/var/log/jointbox-postauth-patch.err"
if freeradius -XC >/dev/null 2>&1 || radiusd -XC >/dev/null 2>&1; then
  systemctl restart freeradius 2>/dev/null || service freeradius restart 2>/dev/null || true
  log "post-auth capture enabled and FreeRADIUS reloaded"
else
  latest_bak=$(ls -t "$QCONF".bak.* 2>/dev/null | head -1)
  [ -n "$latest_bak" ] && cp -a "$latest_bak" "$QCONF"
  # Capture the ACTUAL parser error (not just "reverted") so it can be fixed.
  { freeradius -XC 2>&1 || radiusd -XC 2>&1; } | grep -iE "error|Failed|expand|unknown|Parse" | tail -8 > "$ERR_LOG" 2>/dev/null
  echo "  ! post-auth MAC/NAS capture could not be enabled (optional — accounting is unaffected)."
  echo "    Reverted safely. The exact parser error was saved to: $ERR_LOG"
  [ -s "$ERR_LOG" ] && sed 's/^/      /' "$ERR_LOG"
  exit 0   # optional enhancement — never fail the deploy over it
fi
