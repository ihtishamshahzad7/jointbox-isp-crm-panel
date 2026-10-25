#!/usr/bin/env bash
set -Eeuo pipefail

# The whole script sits inside { … } so bash reads all of it before running
# any of it: `git reset --hard` below can replace this very file mid-run.
{

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="main"
LOCK_FILE="/tmp/jointbox-isp-update.lock"
STATUS_DIR="/var/lib/jointbox"
STATUS_FILE="${STATUS_DIR}/deployment-status.json"
FRONTEND_VERSION_FILE="${ROOT_DIR}/frontend/public/deployment-version.json"

log(){ printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

cd "$ROOT_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "ERROR: Jointbox directory is not a Git repository."; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { log "ERROR: Git origin is not configured."; exit 1; }
mkdir -p "$STATUS_DIR" "$(dirname "$FRONTEND_VERSION_FILE")"

BEFORE_SHA="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
DEPLOY_SHA="$BEFORE_SHA"
DEPLOY_SHORT="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
DEPLOY_MESSAGE="$(git log -1 --pretty=%s HEAD 2>/dev/null || printf 'unknown')"
DEPLOY_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

write_status(){
  local state="$1" text="$2"
  local safe_message safe_text
  safe_message="$(printf '%s' "$DEPLOY_MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  safe_text="$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  cat > "$STATUS_FILE" <<JSON
{"status":"${state}","commit":"${DEPLOY_SHA}","shortCommit":"${DEPLOY_SHORT}","message":${safe_message},"time":"${DEPLOY_TIME}","messageText":${safe_text}}
JSON
}

fail(){
  local line="$1"
  local text="Update failed at line ${line}. Check update.log for details."
  write_status "failed" "$text" || true
  log "ERROR: ${text}"
  exit 1
}
trap 'fail "$LINENO"' ERR

exec 9>"$LOCK_FILE"
flock -n 9 || { write_status "failed" "Another Jointbox update is already running." || true; log "ERROR: Another Jointbox update is already running."; exit 1; }

log "Starting Jointbox production update from origin/${BRANCH}"
write_status "running" "Update process started"

log "Fetching latest GitHub commit..."
git fetch --prune origin "$BRANCH"
REMOTE_SHA="$(git rev-parse "origin/${BRANCH}")"
REMOTE_SHORT="$(git rev-parse --short "origin/${BRANCH}")"

if [[ "$BEFORE_SHA" == "$REMOTE_SHA" ]]; then
  log "Already up to date at ${REMOTE_SHORT}. Rebuilding/reloading anyway."
else
  log "Deploying ${REMOTE_SHORT}: $(git log -1 --pretty=%s "origin/${BRANCH}")"
  git reset --hard "$REMOTE_SHA"
fi

DEPLOY_SHA="$(git rev-parse HEAD)"
DEPLOY_SHORT="$(git rev-parse --short HEAD)"
DEPLOY_MESSAGE="$(git log -1 --pretty=%s HEAD)"
DEPLOY_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
write_status "running" "Code synced; installing dependencies and building"

if [[ -f backend/package-lock.json ]]; then
  log "Installing backend dependencies with npm ci..."
  (cd backend && npm ci --include=dev)
else
  log "Installing backend dependencies with npm install..."
  (cd backend && npm install)
fi

log "Generating Prisma client..."
(cd backend && npx prisma generate)

# --- safety backup BEFORE any schema change ---------------------------------
# Back up config (.env) and the database before migrations run. Forward-only
# migrations should never need a rollback, but a client's billing data warrants
# a restore point regardless. Backups are best-effort: a backup-infra problem
# must not block a security update, but it is logged loudly. Files are 0600,
# directory 0700, and only the last 7 DB dumps are kept.
BACKUP_DIR="/var/backups/jointbox"
if mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  STAMP="$(date -u '+%Y%m%d-%H%M%S')"
  if [[ -f backend/.env ]]; then
    install -m 600 backend/.env "$BACKUP_DIR/env-${STAMP}.bak" 2>/dev/null \
      && log "Config backed up: $BACKUP_DIR/env-${STAMP}.bak (0600)" \
      || log "WARNING: could not back up backend/.env"
  fi
  # Derive a libpq-safe URL (drops Prisma-only params) for pg_dump.
  SAFE_DB_URL="$(cd backend && node -r dotenv/config scripts/lib/pg-url.js 2>/dev/null || true)"
  if command -v pg_dump >/dev/null 2>&1 && [[ -n "$SAFE_DB_URL" ]]; then
    DB_BACKUP="$BACKUP_DIR/db-${DEPLOY_SHORT}-${STAMP}.sql.gz"
    if ( umask 077; pg_dump "$SAFE_DB_URL" 2>/dev/null | gzip > "$DB_BACKUP" ) \
         && [[ -s "$DB_BACKUP" ]]; then
      chmod 600 "$DB_BACKUP" 2>/dev/null || true
      log "Database backed up: $DB_BACKUP (0600)"
      # retain only the 7 most recent dumps
      ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
    else
      rm -f "$DB_BACKUP" 2>/dev/null || true
      log "WARNING: database backup did not complete; continuing (migrations are forward-only)."
    fi
  else
    log "WARNING: pg_dump unavailable or DATABASE_URL unreadable; skipping DB backup."
  fi
else
  log "WARNING: could not create $BACKUP_DIR; skipping pre-update backups."
fi

log "Applying database migrations (safe, forward-only via db:deploy)..."
# A failed migration MUST fail the deployment. There is deliberately no
# schema-sync fallback here: bypassing the migration chain on a production
# database can silently destroy data. `npm run db:deploy` runs `prisma migrate
# deploy` (never db push, never --accept-data-loss) plus the idempotent RADIUS
# schema separation, and loads backend/.env so every child sees DATABASE_URL.
# If it fails, the ERR trap stops the update and leaves the previous build
# running (verification-phase Priority 1).
(cd backend && npm run db:deploy)

log "Building backend..."
(cd backend && npm run build)

if [[ -f frontend/package-lock.json ]]; then
  log "Installing frontend dependencies with npm ci..."
  (cd frontend && npm ci --include=dev)
else
  log "Installing frontend dependencies with npm install..."
  (cd frontend && npm install)
fi

log "Building frontend..."
(cd frontend && npm run build)

cat > "$FRONTEND_VERSION_FILE" <<JSON
{
  "application": "Jointbox ISP CRM",
  "commit": "${DEPLOY_SHA}",
  "shortCommit": "${DEPLOY_SHORT}",
  "message": $(printf '%s' "$DEPLOY_MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "deployedAt": "${DEPLOY_TIME}",
  "branch": "${BRANCH}"
}
JSON

write_status "running" "Build completed; reloading Jointbox services"

# Stored secrets (router RADIUS secrets, credentials) are encrypted with
# SECRETS_KEY, or with JWT_SECRET when SECRETS_KEY was never set. Pin that same
# value as SECRETS_KEY so changing JWT_SECRET later (e.g. to log everyone out)
# can never make the saved secrets unreadable. The key itself does not change;
# the pin is undone if the stored secrets would not decrypt with it.
ENV_FILE="backend/.env"
if [[ -f "$ENV_FILE" ]] && ! grep -qE '^[[:space:]]*SECRETS_KEY=' "$ENV_FILE" && grep -qE '^JWT_SECRET=' "$ENV_FILE"; then
  KEYPIN_BAK="${ENV_FILE}.bak-keypin-$(date +%Y%m%d-%H%M%S)"
  cp -a "$ENV_FILE" "$KEYPIN_BAK"
  {
    printf '\n# Encrypts stored secrets (router RADIUS secrets, credentials). Same value the\n'
    printf '# app has always used; pinned so a JWT_SECRET change cannot break them.\n'
    printf '# Never change or remove this line.\n'
    sed -n 's/^JWT_SECRET=/SECRETS_KEY=/p' "$ENV_FILE" | head -n 1
  } >> "$ENV_FILE"
  if (cd backend && node scripts/radius-clients.js keycheck >/dev/null 2>&1); then
    log "SECRETS_KEY pinned in backend/.env (same key as before; backup: ${KEYPIN_BAK})."
  else
    cp -a "$KEYPIN_BAK" "$ENV_FILE"
    log "NOTE: SECRETS_KEY not pinned — some stored router secrets do not decrypt with the current key (see the router check in Settings)."
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  if [[ -f ecosystem.config.js ]]; then
    log "Reloading Jointbox PM2 applications..."
    pm2 startOrReload ecosystem.config.js --update-env
    pm2 save
  else
    log "ecosystem.config.js not found; reloading only named Jointbox processes..."
    pm2 restart jointbox-backend --update-env
    pm2 restart jointbox-frontend --update-env
  fi
else
  fail "$LINENO"
fi

sleep 3

# On a failed check, show WHY instead of only a line number.
show_logs(){
  local app="$1"
  log "Last log lines from ${app}:"
  pm2 logs "$app" --lines 60 --nostream 2>&1 | tail -n 80 || true
}

# Start-up runs the platform-account check, RADIUS/NAS sync and cache checks
# before the port opens, which can take well over half a minute on a busy
# server. Wait up to 2 minutes before calling it a failure.
log "Checking backend health (up to 2 minutes)..."
BACKEND_OK=0
for i in {1..60}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/health >/dev/null 2>&1 || curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    BACKEND_OK=1
    log "Backend is answering (after ~$((i * 2))s)."
    break
  fi
  sleep 2
done
if [[ "$BACKEND_OK" != "1" ]]; then
  show_logs jointbox-backend
  fail "$LINENO"
fi

log "Checking frontend health (up to 1 minute)..."
FRONTEND_OK=0
for _ in {1..30}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    FRONTEND_OK=1
    break
  fi
  sleep 2
done
if [[ "$FRONTEND_OK" != "1" ]]; then
  show_logs jointbox-frontend
  fail "$LINENO"
fi

# Routers (NAS) → FreeRADIUS from the encrypted vault. Never fails the update:
# on any problem the script puts FreeRADIUS's previous configuration back.
if [[ -f backend/scripts/radius-vault-cutover.sh ]]; then
  log "Checking FreeRADIUS router list (encrypted vault)..."
  if bash backend/scripts/radius-vault-cutover.sh; then
    log "FreeRADIUS router list is up to date."
  else
    log "WARNING: FreeRADIUS router list was not switched; FreeRADIUS keeps its previous configuration. See the [radius-vault] lines above."
  fi
fi

# RADIUS tenancy policy: kept current where the operator installed it
# (radius-tenancy.sh --install). Never installed by an update on its own, and
# the mode (off / monitor / enforce) is not touched. See docs/RADIUS_TENANCY.md.
if [[ -f backend/scripts/radius-tenancy.sh ]] && compgen -G "/etc/freeradius/3.0/policy.d/jointbox-tenancy" >/dev/null; then
  if bash backend/scripts/radius-tenancy.sh --install; then
    log "FreeRADIUS tenancy policy is up to date."
  else
    log "WARNING: FreeRADIUS tenancy policy was not refreshed; FreeRADIUS keeps its previous configuration. See the [radius-tenancy] lines above."
  fi
fi

# Licence agent: install it if this server never got it, and make sure it is
# enabled at boot and running. Never fails the update; never activates.
if [[ -f scripts/install-licence-agent.sh && $EUID -eq 0 ]]; then
  log "Checking licence agent..."
  # shellcheck source=scripts/install-licence-agent.sh
  ( source scripts/install-licence-agent.sh; APP_DIR="$PWD" jbx_ensure_agent ) || \
    log "WARNING: licence agent check did not complete; the panel is unaffected."
fi

write_status "success" "Deployment completed successfully"

log "============================================================"
log "JOINTBOX UPDATE COMPLETE"
log "Commit : ${DEPLOY_SHA}"
log "Short  : ${DEPLOY_SHORT}"
log "Message: ${DEPLOY_MESSAGE}"
log "Branch : ${BRANCH}"
log "Time   : ${DEPLOY_TIME}"
log "Status : SUCCESS"
log "============================================================"
exit 0
}
