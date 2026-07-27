#!/bin/bash
# One-command update for the Ubuntu server.
#   Usage:  ./update-jointbox.sh
# Pulls latest code, syncs the DB schema, rebuilds, and restarts both apps.
set -e

REPO="$HOME/jointbox-isp-crm-panel"
cd "$REPO"

echo "⬇️  Pulling latest code..."
git pull

echo "🗄️  Syncing database schema (creates any new tables/columns)..."
cd "$REPO/backend"
npm install
# db:push = fix ownership + prisma db push (--accept-data-loss) + prisma generate.
# This is what prevents "column does not exist" crashes after a schema change.
npm run db:push

echo "🔧 Rebuilding backend..."
npm run build
pm2 restart jointbox-backend --update-env

echo "🎨 Rebuilding frontend..."
cd "$REPO/frontend"
npm install
npm run build
pm2 restart jointbox-frontend --update-env

echo "✅ Done. Current status:"
pm2 list
echo ""
echo "Health check:"
curl -fsS http://localhost:3001/health && echo "  → API OK" || echo "  → API not responding, check: pm2 logs jointbox-backend"
