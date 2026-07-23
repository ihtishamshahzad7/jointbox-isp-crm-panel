#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Jointbox — one-shot installer for Ubuntu 22.04 / 24.04 LTS
# Installs: Node 20, PostgreSQL, Redis, Nginx, PM2, the app,
# runs migrations, and sets everything to start on boot.
# Run as root:  sudo bash install-ubuntu.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/jointbox"
DB_NAME="jointbox"
DB_USER="jointbox"
DB_PASS="jointbox123"         # change in production
JWT_SECRET="$(openssl rand -hex 32)"
NODE_MAJOR=20

echo "==> Jointbox installer starting"
if [[ $EUID -ne 0 ]]; then echo "Run with sudo/root"; exit 1; fi

# ── 1. system packages ──────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential nginx postgresql postgresql-contrib redis-server \
                   freeradius freeradius-postgresql freeradius-utils openssl ca-certificates

# ── 2. Node.js 20 (NodeSource) ──────────────────────────────
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

# ── 3. PostgreSQL: database + user ──────────────────────────
systemctl enable --now postgresql
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

# ── 4. Redis (cache + queues) ───────────────────────────────
systemctl enable --now redis-server

# ── 5. app code ─────────────────────────────────────────────
# If this script sits next to the repo, copy it; else clone your git repo here.
if [[ ! -d "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  if [[ -d "$(dirname "$0")/../backend" ]]; then
    cp -r "$(dirname "$0")/.."/* "$APP_DIR"/
  else
    echo "Place the Jointbox source in $APP_DIR (backend/ and frontend/) then re-run, or edit this script to 'git clone'."
    exit 1
  fi
fi

# ── 6. backend env ──────────────────────────────────────────
SERVER_IP="$(hostname -I | awk '{print $1}')"
cat > "$APP_DIR/backend/.env" <<ENV
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?connection_limit=10&pool_timeout=15"
RADIUS_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
REDIS_URL="redis://localhost:6379"
JWT_SECRET=${JWT_SECRET}
PORT=3001
NODE_ENV=production
# RADIUS runs on this same box — advertise the LAN IP so the panel + MikroTik use it
RADIUS_SERVER_IP="${SERVER_IP}"
RADIUS_AUTH_PORT=1812
RADIUS_ACCT_PORT=1813
# First-boot admin (auto-created if the DB has no users). Change after first login.
ADMIN_EMAIL="admin@jointbox.com"
ADMIN_PASSWORD="admin123"
BACKEND_PUBLIC_URL="http://localhost:3001"
FRONTEND_PUBLIC_URL="http://localhost"
ENV

# ── 7. build backend ────────────────────────────────────────
cd "$APP_DIR/backend"
npm install
npx prisma generate
npx prisma migrate deploy
npm run build

# ── 8. build frontend ───────────────────────────────────────
cd "$APP_DIR/frontend"
npm install
npm run build

# ── 9. PM2 process manager (both apps, boot on startup) ─────
cd "$APP_DIR"
pm2 delete jointbox-backend jointbox-frontend 2>/dev/null || true
pm2 start "node dist/main.js"      --name jointbox-backend  --cwd "$APP_DIR/backend"
pm2 start "npm run start -- -p 3000 -H 0.0.0.0" --name jointbox-frontend --cwd "$APP_DIR/frontend"
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

# ── 9b. FreeRADIUS 3 → PostgreSQL (same jointbox DB the app uses) ─
# The app's Prisma migrations already created the rad* tables (radcheck, radreply,
# radacct, radpostauth, nas...). So we wire FreeRADIUS's SQL module to that DB and
# do NOT reload its own schema (would clash). This makes CoA/auth/accounting live.
RADDIR=""
for d in /etc/freeradius/3.0 /etc/freeradius; do [[ -d "$d/mods-available" ]] && RADDIR="$d" && break; done
if [[ -n "$RADDIR" ]]; then
  echo "==> Configuring FreeRADIUS at $RADDIR"
  # a) enable the sql module
  ln -sf "$RADDIR/mods-available/sql" "$RADDIR/mods-enabled/sql" 2>/dev/null || true
  # b) point the sql module at PostgreSQL / jointbox
  SQLCONF="$RADDIR/mods-available/sql"
  if [[ -f "$SQLCONF" ]]; then
    # Match the exact default strings FreeRADIUS ships with (sqlite / rlm_sql_null /
    # radius, with server/login/password commented out) — most reliable.
    sed -i \
      -e 's/dialect = "sqlite"/dialect = "postgresql"/' \
      -e 's/driver = "rlm_sql_null"/driver = "rlm_sql_postgresql"/' \
      -e 's/#[[:space:]]*server = "localhost"/server = "localhost"/' \
      -e "s/#[[:space:]]*login = \"radius\"/login = \"${DB_USER}\"/" \
      -e "s/#[[:space:]]*password = \"radpass\"/password = \"${DB_PASS}\"/" \
      -e "s/radius_db = \"radius\"/radius_db = \"${DB_NAME}\"/" \
      "$SQLCONF"
    # let FreeRADIUS read NAS clients from the nas table the app created
    sed -i 's/^\s*#\?\s*read_clients\s*=.*/\tread_clients = yes/' "$SQLCONF"
    echo "==> sql module now set to:"
    grep -nE 'dialect =|driver =|^\s*server =|^\s*login =|^\s*password =|radius_db =' "$SQLCONF" || true
  fi
  # c) enable sql in the default site (authorize + accounting + post-auth + session)
  SITE="$RADDIR/sites-available/default"
  [[ -f "$SITE" ]] && sed -i 's/^\s*#\?\s*-sql/\t\tsql/; ' "$SITE" 2>/dev/null || true
  # d) permissions + restart
  chown -R freerad:freerad "$RADDIR" 2>/dev/null || true
  systemctl enable freeradius 2>/dev/null || true
  systemctl restart freeradius 2>/dev/null || \
    echo "   NOTE: FreeRADIUS didn't restart cleanly — run 'freeradius -X' to debug the SQL wiring."
  echo "   FreeRADIUS pointed at ${DB_NAME}. Auth 1812/udp, Acct 1813/udp, CoA 3799/udp."
else
  echo "==> FreeRADIUS config dir not found — skipping (install freeradius manually if needed)."
fi

# ── 10. Nginx reverse proxy (port 80 → frontend + /api → backend) ─
cat > /etc/nginx/sites-available/jointbox <<'NGINX'
server {
    listen 80 default_server;
    server_name _;

    # Frontend (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # Backend API (everything the app calls on :3001) — expose as /api-backend if you like,
    # but the app talks to :3001 directly, so also proxy that port through if needed.
    location /backend/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/jointbox /etc/nginx/sites-enabled/jointbox
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx

# ── 11. firewall ────────────────────────────────────────────
if command -v ufw >/dev/null; then
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 3000/tcp; ufw allow 3001/tcp
  ufw allow 1812/udp; ufw allow 1813/udp; ufw allow 3799/udp   # RADIUS auth/acct/CoA
  ufw --force enable || true
fi

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "════════════════════════════════════════════════"
echo " Jointbox installed."
echo "   Admin panel : http://${IP}/        (or :3000)"
echo "   Portal      : http://${IP}/portal"
echo "   Backend API : http://${IP}:3001"
echo "   DB: ${DB_NAME}  user: ${DB_USER}"
echo "   Manage: pm2 status | pm2 logs | pm2 restart all"
echo "════════════════════════════════════════════════"
