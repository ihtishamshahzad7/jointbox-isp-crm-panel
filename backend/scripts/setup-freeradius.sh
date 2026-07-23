#!/usr/bin/env bash
# ============================================================================
#  Jointbox — one-time FreeRADIUS production setup
# ----------------------------------------------------------------------------
#  Makes a FreeRADIUS + PostgreSQL server correct ONCE, for ALL current and
#  future subscribers. Safe to re-run (idempotent) — run it again any time you
#  suspect drift, or on every new server you deploy.
#
#  Fixes/【prevents】every failure class hit in production:
#    1.  NAS ignored  -> "RADIUS timeout" with no logs   (read_clients + nasname)
#    2.  No sessions recorded                            (missing radacct columns)
#    3.  Live TX/RX stuck at 0                           (no Acct-Interim-Interval)
#    4.  Users "online" forever                          (stale session cleanup)
#    5.  Wrong uptime / negative durations               (clock not synced)
#    6.  RADIUS only works while running `freeradius -X` (log dir owned by root)
#    7.  Auth attempts not logged                        (log auth = no)
#    8.  Dies on reboot                                  (service not enabled)
#
#  USAGE:
#     sudo bash setup-freeradius.sh
#
#  Override DB settings if yours differ:
#     sudo DB_NAME=jointbox DB_USER=jointbox bash setup-freeradius.sh
# ============================================================================
set -uo pipefail

DB_NAME="${DB_NAME:-jointbox}"
DB_USER="${DB_USER:-jointbox}"
INTERIM_SECONDS="${INTERIM_SECONDS:-60}"   # live counter refresh interval
RAD_DIR="${RAD_DIR:-/etc/freeradius/3.0}"

GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ok()   { echo "${GREEN}  ✔${RESET} $*"; }
warn() { echo "${YELLOW}  ▲${RESET} $*"; }
err()  { echo "${RED}  ✖${RESET} $*"; }
step() { echo; echo "${BOLD}▶ $*${RESET}"; }

[ "$(id -u)" -eq 0 ] || { err "Run with sudo: sudo bash $0"; exit 1; }
[ -d "$RAD_DIR" ] || { err "FreeRADIUS config not found at $RAD_DIR"; exit 1; }

psql_do() { sudo -u postgres psql -d "$DB_NAME" -qtAc "$1" 2>/dev/null; }

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/freeradius-backup-$STAMP"
mkdir -p "$BACKUP"

# ---------------------------------------------------------------------------
step "1/9  Backing up current config -> $BACKUP"
cp -a "$RAD_DIR/radiusd.conf"            "$BACKUP/" 2>/dev/null && ok "radiusd.conf"
cp -a "$RAD_DIR/mods-enabled/sql"        "$BACKUP/" 2>/dev/null && ok "mods-enabled/sql"
cp -a "$RAD_DIR/sites-enabled/default"   "$BACKUP/" 2>/dev/null && ok "sites-enabled/default"

# ---------------------------------------------------------------------------
step "2/9  System clock (NTP)"
# Every session duration, staleness check and billing timestamp depends on this.
# A skewed clock makes sessions look like they started in the future.
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl set-ntp true >/dev/null 2>&1
  sleep 1
  if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
    ok "NTP synchronised ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))"
  else
    warn "NTP enabled but not yet synchronised — recheck with: timedatectl status"
  fi
else
  warn "timedatectl unavailable; ensure NTP is running by other means"
fi

# ---------------------------------------------------------------------------
step "3/9  Database schema (accounting columns + nasreload)"
# The stock FreeRADIUS accounting queries INSERT into columns that a
# Prisma-generated radacct does not have. A single missing column makes EVERY
# accounting write fail -> zero sessions recorded, silently.
psql_do "
ALTER TABLE radacct
  ADD COLUMN IF NOT EXISTS acctupdatetime      TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS acctinterval        BIGINT,
  ADD COLUMN IF NOT EXISTS framedipv6address   INET,
  ADD COLUMN IF NOT EXISTS framedipv6prefix    INET,
  ADD COLUMN IF NOT EXISTS framedinterfaceid   VARCHAR(44),
  ADD COLUMN IF NOT EXISTS delegatedipv6prefix INET;
CREATE TABLE IF NOT EXISTS nasreload (
  nasipaddress INET PRIMARY KEY,
  reloadtime   TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS radacct_open_idx  ON radacct (username) WHERE acctstoptime IS NULL;
CREATE INDEX IF NOT EXISTS radacct_start_idx ON radacct (acctstarttime DESC);
" >/dev/null && ok "radacct columns + nasreload + indexes ensured" \
             || err "Schema update failed — check DB_NAME/DB_USER"

# Anything created while connected as 'postgres' is owned by postgres, which
# later makes `prisma db push` fail with "permission denied for table ...".
# Hand every public table to the app user.
psql_do "
DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname='public' AND tableowner <> '$DB_USER'
  LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO $DB_USER', r.tablename); END LOOP;
END \$\$;" >/dev/null && ok "Table ownership normalised to '$DB_USER'"

COLS=$(psql_do "SELECT count(*) FROM information_schema.columns
                WHERE table_name='radacct' AND column_name IN
                ('acctupdatetime','acctinterval','framedipv6address',
                 'framedipv6prefix','framedinterfaceid','delegatedipv6prefix');")
[ "${COLS:-0}" = "6" ] && ok "All 6 accounting columns present" \
                       || err "Only ${COLS:-0}/6 columns present — accounting WILL fail"

# Grants: FreeRADIUS connects as $DB_USER and must write these tables.
psql_do "
GRANT SELECT, INSERT, UPDATE, DELETE ON radacct, radpostauth, radcheck, radreply,
      radgroupcheck, radgroupreply, radusergroup, nas, nasreload TO \"$DB_USER\";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";
" >/dev/null && ok "Grants applied to '$DB_USER'"

# ---------------------------------------------------------------------------
step "4/9  NAS clients loaded from the database"
# FreeRADIUS matches an incoming request on nas.nasname, which MUST be the NAS
# IP. Anything else and the packet is dropped silently -> "RADIUS timeout".
SQLMOD="$RAD_DIR/mods-enabled/sql"
if [ -f "$SQLMOD" ]; then
  if grep -qE '^\s*read_clients\s*=\s*no' "$SQLMOD"; then
    sed -i 's/^\(\s*\)read_clients\s*=\s*no/\1read_clients = yes/' "$SQLMOD"
    ok "read_clients: no -> yes"
  elif grep -qE '^\s*read_clients\s*=\s*yes' "$SQLMOD"; then
    ok "read_clients already yes"
  else
    warn "read_clients not found in $SQLMOD — check the sql module manually"
  fi
else
  err "$SQLMOD missing — is the SQL module enabled? (ln -s ../mods-available/sql $SQLMOD)"
fi

FIXED=$(psql_do "UPDATE nas SET nasname = \"nasIp\"
                 WHERE \"nasIp\" IS NOT NULL AND nasname IS DISTINCT FROM \"nasIp\";
                 SELECT 1;" )
ok "NAS records normalised (nasname = IP)"
psql_do "SELECT '    - ' || nasname || '  (' || COALESCE(shortname,'') || ')' FROM nas ORDER BY id;" \
  | while read -r l; do [ -n "$l" ] && echo "$l"; done

# ---------------------------------------------------------------------------
step "5/9  Global Acct-Interim-Interval (live usage for ALL users)"
# Returned in every Access-Accept, so every NAS reports usage periodically.
# Applies to users created later or imported in bulk — nothing per-user needed.
# "=" means a per-user radreply value still wins.
SITE="$RAD_DIR/sites-enabled/default"
if grep -q 'Acct-Interim-Interval' "$SITE"; then
  ok "Interim-interval default already configured"
else
  perl -0pi -e "s/^post-auth \{\n/post-auth \{\n\t#  Jointbox: make every NAS report usage periodically.\n\tupdate reply {\n\t\t&Acct-Interim-Interval = ${INTERIM_SECONDS}\n\t}\n\n/m" "$SITE"
  grep -q 'Acct-Interim-Interval' "$SITE" \
    && ok "Added Acct-Interim-Interval = ${INTERIM_SECONDS}s for all users" \
    || err "Could not patch post-auth — add it manually in $SITE"
fi

# ---------------------------------------------------------------------------
step "6/9  Authentication logging"
CONF="$RAD_DIR/radiusd.conf"
if grep -qE '^\s*auth\s*=\s*no' "$CONF"; then
  sed -i '0,/^\(\s*\)auth\s*=\s*no/s//\1auth = yes/' "$CONF"
  ok "log { auth } : no -> yes"
else
  ok "Auth logging already enabled"
fi

# ---------------------------------------------------------------------------
step "7/9  File ownership (service runs as freerad, not root)"
# Running `freeradius -X` as root leaves root-owned logs; the service then
# cannot write them and refuses to start — the classic "only works in debug".
RADUSER=$(grep -oP '^\s*user\s*=\s*"?\K[^"\s]+' "$CONF" | head -1); RADUSER="${RADUSER:-freerad}"
RADGROUP=$(grep -oP '^\s*group\s*=\s*"?\K[^"\s]+' "$CONF" | head -1); RADGROUP="${RADGROUP:-freerad}"
chown -R "$RADUSER:$RADGROUP" /var/log/freeradius /var/run/freeradius 2>/dev/null
chown -R "$RADUSER:$RADGROUP" "$RAD_DIR" 2>/dev/null
ok "Ownership set to $RADUSER:$RADGROUP"

# ---------------------------------------------------------------------------
step "8/9  Firewall (auth 1812, accounting 1813, CoA 3799)"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 1812/udp >/dev/null 2>&1
  ufw allow 1813/udp >/dev/null 2>&1
  ufw allow 3799/udp >/dev/null 2>&1
  ok "UDP 1812/1813/3799 allowed"
else
  ok "ufw inactive — no firewall changes needed"
fi

# ---------------------------------------------------------------------------
step "9/9  Validate config and start the service"
pkill -9 -f 'freeradius -X' 2>/dev/null
if freeradius -XC >/tmp/fr-check.log 2>&1; then
  ok "Configuration valid"
else
  err "Configuration INVALID — not restarting. Details:"
  tail -20 /tmp/fr-check.log | sed 's/^/      /'
  echo; err "Restore with: cp $BACKUP/* $RAD_DIR/ (and subdirs) then re-run"
  exit 1
fi

systemctl enable freeradius >/dev/null 2>&1 && ok "Enabled at boot"
systemctl restart freeradius
sleep 2
if systemctl is-active --quiet freeradius; then
  ok "FreeRADIUS is running"
else
  err "Service failed to start:"; journalctl -u freeradius -n 15 --no-pager | sed 's/^/      /'; exit 1
fi

# ---------------------------------------------------------------------------
echo
echo "${BOLD}──────────── VERIFICATION ────────────${RESET}"
ss -ulnp 2>/dev/null | grep -qE ':1812' && ok "Listening on 1812 (auth)"       || err "NOT listening on 1812"
ss -ulnp 2>/dev/null | grep -qE ':1813' && ok "Listening on 1813 (accounting)" || err "NOT listening on 1813"
CLIENTS=$(psql_do "SELECT count(*) FROM nas;")
ok "NAS clients in database: ${CLIENTS:-0}"
OPEN=$(psql_do "SELECT count(*) FROM radacct WHERE acctstoptime IS NULL;")
ok "Open sessions: ${OPEN:-0}"

# Close anything left dangling from before this run.
psql_do "UPDATE radacct
            SET acctstoptime = COALESCE(acctupdatetime, acctstarttime),
                acctterminatecause = 'Stale-Session'
          WHERE acctstoptime IS NULL
            AND COALESCE(acctupdatetime, acctstarttime) <= NOW() - INTERVAL '15 minutes';" >/dev/null
ok "Stale sessions closed"

cat <<EOF

${BOLD}${GREEN}Setup complete.${RESET}  Backup: $BACKUP

This server is now configured for ALL users — current, future and imported.
Nothing per-subscriber needs doing for accounting to work.

Remaining, on each router (once per NAS):
  /radius add address=<THIS_SERVER_IP> secret=<same as panel> service=ppp \\
      authentication-port=1812 accounting-port=1813 timeout=3s
  /ppp aaa set use-radius=yes accounting=yes
  /radius incoming set accept=yes port=3799
  /ip service enable api

Add the NAS in the panel with the router's real IP and the same secret.

Watch live traffic:   sudo tail -f /var/log/freeradius/radius.log
Debug a dial-up:      sudo systemctl stop freeradius && sudo freeradius -X
  (afterwards ALWAYS: sudo systemctl start freeradius)
EOF
