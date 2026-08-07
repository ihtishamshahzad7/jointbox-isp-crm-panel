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

# 3) Replace the whole post-auth { ... } block with an extended INSERT. Uses
#    Python for a reliable multi-line replace (sed struggles with the block).
python3 - "$QCONF" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()

new_block = '''post-auth {
	query = "\\
		INSERT INTO ${..postauth_table} \\
			(username, pass, reply, authdate, callingstationid, calledstationid, nasipaddress, nasportid) \\
		VALUES ( \\
			'%{User-Name}', \\
			'%{%{User-Password}:-%{Chap-Password}}', \\
			'%{reply:Packet-Type}', \\
			'%S', \\
			'%{Calling-Station-Id}', \\
			'%{Called-Station-Id}', \\
			'%{NAS-IP-Address}', \\
			'%{NAS-Port-Id}')"
}'''

# Match the first top-level post-auth { ... } block.
pat = re.compile(r'post-auth\s*\{.*?\n\}', re.DOTALL)
if pat.search(src):
    src = pat.sub(new_block, src, count=1)
    open(path, 'w').write(src)
    print("  • post-auth query rewritten to capture MAC/NAS/port")
else:
    print("  ! could not locate post-auth block — left unchanged")
PY

# 4) Validate; roll back if FreeRADIUS refuses the new config.
if freeradius -XC >/dev/null 2>&1; then
  systemctl restart freeradius 2>/dev/null || service freeradius restart 2>/dev/null || true
  log "post-auth capture enabled and FreeRADIUS reloaded"
else
  latest_bak=$(ls -t "$QCONF".bak.* 2>/dev/null | head -1)
  [ -n "$latest_bak" ] && cp -a "$latest_bak" "$QCONF"
  echo "  ! new config failed validation — reverted. Run 'freeradius -XC' to see why."
  exit 1
fi
