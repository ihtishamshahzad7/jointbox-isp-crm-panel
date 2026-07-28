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

echo "🗄️  Syncing database schema..."
cd "$REPO/backend"
npm install --no-audit --no-fund
npm run db:push          # fix ownership + prisma db push + generate (idempotent)

echo "🔧 Building backend..."
npm run build            # produces backend/dist/main.js

echo "🎨 Building frontend..."
cd "$REPO/frontend"
npm install --no-audit --no-fund
npm run build

echo "🚀 (Re)starting via pm2 ecosystem (direct entrypoints, no npm wrappers)..."
cd "$REPO"
# startOrReload: starts if not running, cleanly reloads if running. Because pm2
# owns dist/main.js and the next binary directly, the old process is killed and
# the port freed before the new one binds — no EADDRINUSE loop.
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo ""
echo "✅ Done. Status:"
pm2 list
echo ""
echo "Health:"
curl -fsS http://localhost:3001/health >/dev/null 2>&1 && echo "  API OK (3001)" || echo "  ⚠ API not responding — pm2 logs jointbox-backend"
curl -fsS http://localhost:3000        >/dev/null 2>&1 && echo "  Web OK (3000)" || echo "  ⚠ Web not responding — pm2 logs jointbox-frontend"
