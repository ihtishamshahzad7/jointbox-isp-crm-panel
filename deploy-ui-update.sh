#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Jointbox Panel - Deployment Script
# ═══════════════════════════════════════════════════════════════════════
# This script automates deploying the modernized UI to your Ubuntu server
# Usage: bash deploy-ui-update.sh

set -e

echo "🚀 Jointbox Panel - UI Update Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="${1:-https://github.com/YOUR-USERNAME/jointbox-panel.git}"
DEPLOY_DIR="/opt/jointbox"
BRANCH="${2:-main}"

# Check if running on Ubuntu server
if [ ! -d "$DEPLOY_DIR" ]; then
    echo -e "${YELLOW}⚠️  $DEPLOY_DIR not found${NC}"
    echo "This script should run on your Ubuntu server where Jointbox is installed."
    echo "Installation path should be: $DEPLOY_DIR"
    exit 1
fi

# Step 1: Pull latest code
echo ""
echo -e "${BLUE}📥 Step 1: Pulling latest code from GitHub...${NC}"
cd "$DEPLOY_DIR"
git fetch origin
git checkout $BRANCH
git pull origin $BRANCH

# Step 2: Build frontend
echo ""
echo -e "${BLUE}🔨 Step 2: Building frontend with new UI...${NC}"
cd frontend
npm install --legacy-peer-deps 2>/dev/null || npm install
npm run build

# Step 3: Stop existing services
echo ""
echo -e "${BLUE}⏹️  Step 3: Stopping services...${NC}"
pm2 stop frontend 2>/dev/null || true
sleep 2

# Step 4: Start frontend
echo ""
echo -e "${BLUE}▶️  Step 4: Starting frontend service...${NC}"
pm2 start ecosystem.config.js --only frontend 2>/dev/null || pm2 start "npm start -- -H 0.0.0.0 -p 3000" --name frontend
pm2 save

# Step 5: Verify deployment
echo ""
echo -e "${BLUE}✅ Step 5: Verifying deployment...${NC}"
sleep 3

if curl -s http://localhost:3000 > /dev/null; then
    echo -e "${GREEN}✅ Frontend is running on http://localhost:3000${NC}"
else
    echo -e "${YELLOW}⚠️  Frontend health check timed out. Check logs: pm2 logs frontend${NC}"
fi

echo ""
echo -e "${GREEN}✨ UI Update Deployment Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 What was updated:"
echo "  ✅ Modern animations and transitions"
echo "  ✅ Enhanced component styling"
echo "  ✅ Responsive grid layouts"
echo "  ✅ Improved dashboard cards"
echo "  ✅ Better form and table styling"
echo "  ✅ Glass morphism effects"
echo "  ✅ Dark/light theme support"
echo ""
echo "🔗 Access your panel at:"
echo "   http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "📊 Monitor services with:"
echo "   pm2 monit"
echo "   pm2 logs"
echo ""
