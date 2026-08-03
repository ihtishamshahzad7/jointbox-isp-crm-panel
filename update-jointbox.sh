#!/bin/bash
# One-command deploy/update for any Jointbox server.
#   Usage:  ./update-jointbox.sh
#
# Safe to run for both first install and every later update. It pulls the code,
# syncs the DB schema, rebuilds, and (re)starts both apps through the committed
# ecosystem.config.js so pm2 manages the REAL processes — never npm wrappers —
# which is what prevents the port-conflict crash loop from ever coming back.
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"   # the repo this script lives in
cd "$REPO"

echo "⬇️  Pulling latest code..."
git pull

echo "🗄️  Applying database migrations + reconcile..."
cd "$REPO/backend"
npm install --no-audit --no-fund
# migrate deploy (versioned) + idempotent db push safety net. Guarantees the DB
# always matches schema.prisma, on a fresh, drifted, or clean server. See
# scripts/db-deploy.sh and MIGRATIONS.md.
npm run db:deploy

echo "🔧 Building backend..."
npm run build            # produces backend/dist/main.js

echo "🎨 Building frontend..."
cd "$REPO/frontend"
npm install --no-audit --no-fund
# Always start from a CLEAN .next. A stale/half-old build (or one whose files
# were written by a different user in a mixed root/jointbox setup) makes
# `next start` return HTTP 500 for /_next/static chunks → the UI hangs with a
# ChunkLoadError. Wiping guarantees consistent, servable chunks every deploy.
rm -rf "$REPO/frontend/.next"
npm run build

# Make the build world-READABLE so it doesn't matter whether the build ran as
# root or the app user — pm2's next process can always read the chunks. (A
# root-only .next was what returned HTTP 500 on /_next/static and hung the UI.)
chmod -R a+rX "$REPO/frontend/.next" "$REPO/backend/dist" 2>/dev/null || true

# Kill any STRAY next/node listener that isn't managed by pm2 (e.g. a manual
# `npm run start` someone left running on 80/3000). An orphan bound to the port
# behind the proxy is what served the OLD broken build. pm2 owns the real one.
for P in 80 3000; do
  for PID in $(ss -lptn "sport = :$P" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u); do
    pm2 pid 2>/dev/null | grep -qw "$PID" || { echo "  ↳ killing stray listener on :$P (pid $PID)"; kill "$PID" 2>/dev/null || true; }
  done
done

# Slim down: the Next build cache and webpack cache are only needed DURING the
# build and can grow to several GB. Removing them after a successful build keeps
# the deployed footprint small without affecting the running app.
echo "🧹 Trimming build caches to save disk..."
rm -rf "$REPO/frontend/.next/cache" 2>/dev/null || true
rm -rf "$REPO/backend/tsconfig.build.tsbuildinfo" 2>/dev/null || true
npm cache clean --force >/dev/null 2>&1 || true

echo "🚀 (Re)starting via pm2 ecosystem (direct entrypoints, no npm wrappers)..."
cd "$REPO"
# startOrReload: starts if not running, cleanly reloads if running. Because pm2
# owns dist/main.js and the next binary directly, the old process is killed and
# the port freed before the new one binds — no EADDRINUSE loop.
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
# Make pm2 (and therefore both apps) come back automatically after any reboot or
# power loss. Idempotent — safe to run every deploy. Needs root for the systemd
# unit; falls back silently when not root (already configured on prior runs).
if [ "$(id -u)" -eq 0 ]; then
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
else
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true
fi
pm2 save >/dev/null 2>&1 || true

echo ""
echo "✅ Done. Status:"
pm2 list
echo ""
echo "Health:"
curl -fsS http://localhost:3001/health >/dev/null 2>&1 && echo "  API OK (3001)" || echo "  ⚠ API not responding — pm2 logs jointbox-backend"
curl -fsS http://localhost:3000        >/dev/null 2>&1 && echo "  Web OK (3000)" || echo "  ⚠ Web not responding — pm2 logs jointbox-frontend"
