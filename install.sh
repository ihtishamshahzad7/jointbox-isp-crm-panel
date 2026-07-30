#!/usr/bin/env bash
# =============================================================================
#  Jointbox ISP CRM — one-command Ubuntu installer
# -----------------------------------------------------------------------------
#  Installs and configures the whole stack on a clean Ubuntu 22.04/24.04 server:
#    PostgreSQL · FreeRADIUS · Node.js · the backend (PM2 cluster) · the frontend
#
#  USAGE
#    wget -qO- https://raw.githubusercontent.com/<you>/<repo>/main/install.sh | sudo bash
#  or
#    sudo bash install.sh
#
#  Re-runnable: every step checks before it acts, so running it again upgrades
#  rather than duplicates.
# =============================================================================
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/ihtishamshahzad7/jointbox-isp-crm-panel.git}"
# If this script is already run from inside a cloned checkout (git clone … && cd …
# && sudo bash install.sh), install IN PLACE there instead of re-cloning to /opt.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/backend" ] && [ -d "$SCRIPT_DIR/frontend" ]; then
  APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
else
  APP_DIR="${APP_DIR:-/opt/jointbox}"
fi
DB_NAME="${DB_NAME:-jointbox}"
DB_USER="${DB_USER:-jointbox}"
DB_PASS="${DB_PASS:-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
ok(){ echo "${G}  ✔${N} $*"; }; warn(){ echo "${Y}  ▲${N} $*"; }
err(){ echo "${R}  ✖${N} $*"; }; step(){ echo; echo "${B}▶ $*${N}"; }

[ "$(id -u)" -eq 0 ] || { err "Run with sudo: sudo bash $0"; exit 1; }
SERVER_IP="$(hostname -I | awk '{print $1}')"
# Run from a world-accessible dir so `sudo -u postgres psql` doesn't print
# "could not change directory to <repo>: Permission denied" (the postgres user
# can't chdir into a 700 home checkout). All app paths below are absolute.
cd /tmp 2>/dev/null || true

# -----------------------------------------------------------------------------
step "1/9  System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git build-essential ca-certificates gnupg ufw >/dev/null
ok "Base packages"

# -----------------------------------------------------------------------------
step "2/9  Node.js 20 LTS"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ] 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v), npm $(npm -v)"
npm i -g pm2 >/dev/null 2>&1 && ok "PM2 installed"

# -----------------------------------------------------------------------------
step "3/9  PostgreSQL"
apt-get install -y -qq postgresql postgresql-contrib >/dev/null
systemctl enable --now postgresql >/dev/null 2>&1

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  ok "Role '$DB_USER' exists"
  sudo -u postgres psql -qc "ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
else
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';" >/dev/null
  ok "Role '$DB_USER' created"
fi

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  ok "Database '$DB_NAME' exists"
else
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  ok "Database '$DB_NAME' created"
fi
# The app owns its schema, so Prisma can migrate without permission errors.
sudo -u postgres psql -d "$DB_NAME" -qc "GRANT ALL ON SCHEMA public TO $DB_USER; ALTER SCHEMA public OWNER TO $DB_USER;" >/dev/null

# Allow the LAN in (routers/RADIUS live on the same network).
PGCONF="$(sudo -u postgres psql -tAc 'SHOW config_file')"
PGHBA="$(dirname "$PGCONF")/pg_hba.conf"
grep -q "listen_addresses = '\*'" "$PGCONF" || echo "listen_addresses = '*'" >> "$PGCONF"
grep -q "jointbox-lan" "$PGHBA" || {
  echo "# jointbox-lan" >> "$PGHBA"
  echo "host all all 192.168.0.0/16 scram-sha-256" >> "$PGHBA"
  echo "host all all 10.0.0.0/8     scram-sha-256" >> "$PGHBA"
}
systemctl restart postgresql
ok "PostgreSQL ready and reachable on the LAN"

# -----------------------------------------------------------------------------
step "4/9  FreeRADIUS"
apt-get install -y -qq freeradius freeradius-postgresql freeradius-utils >/dev/null
RAD=/etc/freeradius/3.0

[ -e "$RAD/mods-enabled/sql" ] || ln -s ../mods-available/sql "$RAD/mods-enabled/sql"
# COMPLETE sql module. Two things the old minimal version got wrong and that
# stopped FreeRADIUS from starting:
#   1) the connection pool MUST be multi-line — one `key = value` per line, or
#      the parser errors ("Expected comma after '16'");
#   2) queries.conf references ${client_table}, ${authcheck_table}, ${acct_table1}
#      etc, so those table-name variables MUST be defined here BEFORE the
#      $INCLUDE, or every one reads as "not found".
cat > "$RAD/mods-available/sql" <<EOF
sql {
    dialect = "postgresql"
    driver  = "rlm_sql_postgresql"

    server   = "localhost"
    port     = 5432
    login    = "$DB_USER"
    password = "$DB_PASS"
    radius_db = "$DB_NAME"

    # Read RADIUS clients (NAS) straight from the panel's own table.
    read_clients = yes
    client_table = "nas"
    client_query = "SELECT id, nasname, shortname, type, secret, server FROM nas"

    # Table names referenced by queries.conf — required, or parsing fails.
    sql_user_name    = "%{User-Name}"
    authcheck_table  = "radcheck"
    authreply_table  = "radreply"
    groupcheck_table = "radgroupcheck"
    groupreply_table = "radgroupreply"
    usergroup_table  = "radusergroup"
    acct_table1      = "radacct"
    acct_table2      = "radacct"
    postauth_table   = "radpostauth"

    read_groups   = yes
    read_profiles = yes
    delete_stale_sessions = yes

    pool {
        start       = 5
        min         = 3
        max         = 32
        spare       = 5
        uses        = 0
        lifetime    = 0
        idle_timeout = 60
    }

    \$INCLUDE \${modconfdir}/\${.:name}/main/\${dialect}/queries.conf
}
EOF

# Auth logging on, and one interim-update interval for EVERY user so live usage
# works without touching each router.
sed -i '0,/^\(\s*\)auth = no/s//\1auth = yes/' "$RAD/radiusd.conf"
grep -q 'Acct-Interim-Interval' "$RAD/sites-enabled/default" || \
  perl -0pi -e "s/^post-auth \{\n/post-auth \{\n\tupdate reply {\n\t\t&Acct-Interim-Interval = 60\n\t}\n\n/m" \
  "$RAD/sites-enabled/default"

# Enable the sql module in the default site so accounting writes to radacct and
# post-auth is logged (the stock site ships these commented out). Uncomment a
# standalone `sql` token wherever it appears; harmless if already active.
for SITE in "$RAD/sites-enabled/default" "$RAD/sites-enabled/inner-tunnel"; do
  [ -f "$SITE" ] && sed -i -E 's/^([[:space:]]*)#[[:space:]]*sql[[:space:]]*$/\1sql/' "$SITE"
done

chown -R freerad:freerad /var/log/freeradius /var/run/freeradius "$RAD" 2>/dev/null
systemctl enable freeradius >/dev/null 2>&1
ok "FreeRADIUS configured (SQL clients, auth logging, 60s interim updates)"

# -----------------------------------------------------------------------------
step "5/9  Application source"
if [ "$APP_DIR" = "$SCRIPT_DIR" ]; then
  ok "Using the checkout you ran this from: $APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only && ok "Repository updated"
else
  git clone --depth 1 "$REPO_URL" "$APP_DIR" && ok "Repository cloned to $APP_DIR"
fi
[ -d "$APP_DIR/backend" ] || { err "backend/ not found — check REPO_URL"; exit 1; }

# -----------------------------------------------------------------------------
step "6/9  Backend"
cd "$APP_DIR/backend"
cat > .env <<EOF
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME?connection_limit=25&pool_timeout=30"
RADIUS_DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
PORT=$API_PORT
JWT_SECRET="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
# Default web login created automatically on first boot. Change the password
# after logging in. (The backend refuses to start without ADMIN_PASSWORD set.)
ADMIN_EMAIL=admin@jointbox.com
ADMIN_PASSWORD=admin123
# Sessions re-authenticate against the panel on this interval (see docs).
RADIUS_SESSION_TIMEOUT=86400
# Scale tuning — see scripts/SCALING.md
NAS_POLL_CONCURRENCY=20
NAS_FAST_POLL_MS=30000
NAS_SLOW_POLL_MS=300000
RADACCT_RETAIN_DAYS=90
# REDIS_URL=redis://127.0.0.1:6379   # uncomment after installing Redis
EOF
chmod 600 .env

# Full install (dev deps included) — nest/swc/prisma CLI are devDependencies and
# are needed to migrate and build. Runtime is still lean because we build to dist.
npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1
# Ownership first — anything created earlier as the postgres superuser would
# otherwise make Prisma fail with "permission denied for table ...".
sudo -u postgres psql -d "$DB_NAME" -qc "REASSIGN OWNED BY postgres TO $DB_USER;" >/dev/null 2>&1
# Versioned migrations + idempotent reconcile. Same command every server runs,
# so a fresh clone ends up byte-identical to an updated one. See MIGRATIONS.md.
npm run db:deploy >/dev/null 2>&1 && ok "Schema migrated & in sync" || warn "db:deploy had warnings — run: cd $APP_DIR/backend && npm run db:deploy"
npm run build >/dev/null 2>&1 && ok "Backend built"

# -----------------------------------------------------------------------------
step "7/9  Frontend"
if [ -d "$APP_DIR/frontend" ]; then
  cd "$APP_DIR/frontend"
  echo "NEXT_PUBLIC_BACKEND_URL=http://$SERVER_IP:$API_PORT" > .env.local
  npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1
  npm run build >/dev/null 2>&1 && ok "Frontend built"
  # Assemble the standalone server bundle (output:'standalone').
  if [ -d "$APP_DIR/frontend/.next/standalone" ]; then
    mkdir -p "$APP_DIR/frontend/.next/standalone/.next"
    cp -r "$APP_DIR/frontend/.next/static" "$APP_DIR/frontend/.next/standalone/.next/static"
    [ -d "$APP_DIR/frontend/public" ] && cp -r "$APP_DIR/frontend/public" "$APP_DIR/frontend/.next/standalone/public"
    ok "Standalone frontend assembled"
  fi
else
  warn "frontend/ not found — skipped"
fi

# Start BOTH apps through the committed ecosystem.config.js — pm2 owns the real
# entrypoints (backend dist/main.js and the next binary) directly, never an
# `npm run start` wrapper. That wrapper is what orphaned the port and caused the
# EADDRINUSE restart loop; launching the real process means a restart cleanly
# frees the port. Cluster mode: set BACKEND_INSTANCES/FRONTEND_INSTANCES=max.
cd "$APP_DIR"
# retire any processes from older installs that used the buggy names/wrappers
pm2 delete jointbox-api jointbox-web >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.js --update-env >/dev/null 2>&1
ok "Backend + frontend running via ecosystem.config.js"

# Auto-start on every boot / power loss.
pm2 save >/dev/null 2>&1
pm2 startup systemd -u root --hp /root >/dev/null 2>&1
ok "PM2 will restart everything on boot"

# -----------------------------------------------------------------------------
step "8/9  Firewall"
if ufw status | grep -q inactive; then
  warn "ufw inactive — skipping (enable it yourself if you want a firewall)"
else
  ufw allow 22/tcp   >/dev/null 2>&1
  ufw allow $API_PORT/tcp >/dev/null 2>&1
  ufw allow $WEB_PORT/tcp >/dev/null 2>&1
  ufw allow 1812,1813/udp >/dev/null 2>&1
  ufw allow 3799/udp >/dev/null 2>&1
  ufw allow 514/udp  >/dev/null 2>&1   # syslog receiver (link tracing)
  ok "Ports opened (SSH, API, web, RADIUS, CoA, syslog)"
fi

# -----------------------------------------------------------------------------
step "9/9  Start services and verify"
systemctl restart freeradius && sleep 2
systemctl is-active --quiet freeradius && ok "FreeRADIUS running" || err "FreeRADIUS failed — run: freeradius -XC"
ss -ulnp 2>/dev/null | grep -q ':1812' && ok "Listening on 1812 (auth)" || warn "Not listening on 1812"
ss -ulnp 2>/dev/null | grep -q ':1813' && ok "Listening on 1813 (accounting)" || warn "Not listening on 1813"
curl -fsS "http://localhost:$API_PORT/health" >/dev/null 2>&1 && ok "API responding" || warn "API not responding yet — pm2 logs jointbox-backend"

cat <<EOF

${B}${G}════════════════ INSTALL COMPLETE ════════════════${N}

  Panel      http://$SERVER_IP:$WEB_PORT
  API        http://$SERVER_IP:$API_PORT
  Login      admin@jointbox.com / admin123   ${Y}← change this immediately${N}

  Database   $DB_NAME
  DB user    $DB_USER
  DB pass    $DB_PASS
  ${Y}Save that password — it is also written to $APP_DIR/backend/.env${N}

  Next, on each router:
    /radius add address=$SERVER_IP secret=<same as panel> service=ppp \\
        authentication-port=1812 accounting-port=1813 timeout=3s
    /ppp aaa set use-radius=yes accounting=yes
    /radius incoming set accept=yes port=3799
    /ip service enable api
  Then add the NAS in the panel using the router's IP and that same secret.

  Useful:
    pm2 status / pm2 logs jointbox-backend
    sudo systemctl stop freeradius && sudo freeradius -X    # debug a dial-up
    (afterwards: sudo systemctl start freeradius)

EOF
