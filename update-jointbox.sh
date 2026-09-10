#!/usr/bin/env bash
set -Eeuo pipefail

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
  (cd backend && npm ci --omit=dev=false)
else
  log "Installing backend dependencies with npm install..."
  (cd backend && npm install)
fi

log "Generating Prisma client..."
(cd backend && npx prisma generate)

log "Applying database migrations..."
if ! (cd backend && npx prisma migrate deploy); then
  log "No usable Prisma migration chain detected; attempting prisma db push..."
  (cd backend && npx prisma db push)
fi

log "Building backend..."
(cd backend && npm run build)

if [[ -f frontend/package-lock.json ]]; then
  log "Installing frontend dependencies with npm ci..."
  (cd frontend && npm ci --omit=dev=false)
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

log "Checking backend health..."
BACKEND_OK=0
for _ in {1..12}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/health >/dev/null 2>&1 || curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    BACKEND_OK=1
    break
  fi
  sleep 2
done
[[ "$BACKEND_OK" == "1" ]] || fail "$LINENO"

log "Checking frontend health..."
FRONTEND_OK=0
for _ in {1..12}; do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    FRONTEND_OK=1
    break
  fi
  sleep 2
done
[[ "$FRONTEND_OK" == "1" ]] || fail "$LINENO"

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