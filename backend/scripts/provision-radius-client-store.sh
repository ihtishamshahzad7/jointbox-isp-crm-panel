#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/backend/.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a
. "$ENV_FILE"
set +a

python3 - "$DATABASE_URL" <<'PY' >/tmp/jointbox-db-values
import sys
from urllib.parse import urlparse
u=urlparse(sys.argv[1])
print(u.hostname or "127.0.0.1")
print(u.port or 5432)
print(u.path.lstrip("/").split("?")[0])
PY
mapfile -t DBV < /tmp/jointbox-db-values
DB_HOST="${DBV[0]}"; DB_PORT="${DBV[1]}"; DB_NAME="${DBV[2]}"
rm -f /tmp/jointbox-db-values

RADIUS_USER="${RADIUS_DB_USER:-jointbox_radius}"
RADIUS_ENV="/etc/jointbox/radius-client.env"
mkdir -p /etc/jointbox
chmod 700 /etc/jointbox

if [ -f "$RADIUS_ENV" ]; then
  . "$RADIUS_ENV"
else
  RADIUS_DB_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  umask 077
  cat > "$RADIUS_ENV" <<EOF
RADIUS_DB_USER=$RADIUS_USER
RADIUS_DB_PASSWORD=$RADIUS_DB_PASSWORD
EOF
  chmod 600 "$RADIUS_ENV"
fi

export RADIUS_DB_USER="$RADIUS_USER" RADIUS_DB_PASSWORD
EPASS="$(printf "%s" "$RADIUS_DB_PASSWORD" | sed "s/'/''/g")"
EDB="$(printf "%s" "$DB_NAME" | sed "s/'/''/g")"

sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres <<SQL
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$RADIUS_USER') THEN
    CREATE ROLE "$RADIUS_USER" LOGIN PASSWORD '$EPASS';
  ELSE
    ALTER ROLE "$RADIUS_USER" WITH LOGIN PASSWORD '$EPASS';
  END IF;
END
$$;
GRANT CONNECT ON DATABASE "$EDB" TO "$RADIUS_USER";
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
CREATE TABLE IF NOT EXISTS public.radius_nas_clients (
  id BIGSERIAL PRIMARY KEY,
  nasname VARCHAR(128) NOT NULL UNIQUE,
  shortname VARCHAR(32),
  type VARCHAR(30) DEFAULT 'other',
  ports INTEGER,
  secret VARCHAR(512) NOT NULL,
  server VARCHAR(64),
  description VARCHAR(200),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.radius_nas_clients OWNER TO postgres;
REVOKE ALL ON public.radius_nas_clients FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.radius_nas_clients TO "$RADIUS_USER";
GRANT USAGE, SELECT ON SEQUENCE public.radius_nas_clients_id_seq TO "$RADIUS_USER";
GRANT USAGE ON SCHEMA public TO "$RADIUS_USER";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radcheck, public.radreply, public.radusergroup, public.radgroupcheck, public.radgroupreply, public.radacct, public.radpostauth TO "$RADIUS_USER";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$RADIUS_USER";

INSERT INTO public.radius_nas_clients (nasname, shortname, type, ports, secret, server, description)
SELECT nasname, shortname, COALESCE(type, 'other'), ports, secret, server, description
FROM public.nas
WHERE secret IS NOT NULL AND btrim(secret) <> ''
ON CONFLICT (nasname) DO NOTHING;
SQL

python3 - "$ENV_FILE" "$DB_HOST" "$DB_PORT" "$DB_NAME" "$RADIUS_USER" "$RADIUS_DB_PASSWORD" <<'PY'
import sys, re
from pathlib import Path
p=Path(sys.argv[1])
host,port,db,user,pw=sys.argv[2:]
url=f'postgresql://{user}:{pw}@{host}:{port}/{db}'
text=p.read_text()
line=f'RADIUS_DATABASE_URL="{url}"'
if re.search(r'^RADIUS_DATABASE_URL=.*$', text, re.M):
    text=re.sub(r'^RADIUS_DATABASE_URL=.*$', line, text, flags=re.M)
else:
    text += "\n"+line+"\n"
p.write_text(text)
PY
chmod 600 "$ENV_FILE"

RAD="/etc/freeradius/3.0"
SQL="$RAD/mods-available/sql"
if [ -f "$SQL" ]; then
  cp -a "$SQL" "$SQL.bak.jointbox-radius-vault"
  sed -i -E "s/^([[:space:]]*login[[:space:]]*=).*/\1 \"$RADIUS_USER\"/" "$SQL"
  sed -i -E "s/^([[:space:]]*password[[:space:]]*=).*/\1 \"$RADIUS_DB_PASSWORD\"/" "$SQL"
  sed -i -E 's/^([[:space:]]*client_table[[:space:]]*=).*/\1 "radius_nas_clients"/' "$SQL"
fi
chown -R freerad:freerad "$RAD" 2>/dev/null || true
if freeradius -XC >/dev/null 2>&1 || radiusd -XC >/dev/null 2>&1; then
  echo "Protected FreeRADIUS NAS client store provisioned."
else
  echo "FreeRADIUS configuration validation failed; previous SQL config was backed up." >&2
  exit 1
fi
