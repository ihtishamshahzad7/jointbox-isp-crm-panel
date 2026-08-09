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

# git can refuse to operate on a repo owned by another user ("dubious ownership")
# — mark it safe so root/jointbox both work.
git config --global --add safe.directory "$REPO" 2>/dev/null || true

echo "⬇️  Pulling latest code..."
# A deployment checkout should have NO local edits — anything there is a stray
# manual change (e.g. someone edited install.sh on the box) that makes `git pull`
# abort with "local changes would be overwritten", so the Update button silently
# does nothing. Hard-reset to the remote so the pull ALWAYS applies.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
git fetch origin "$BRANCH" 2>/dev/null || git fetch origin || true
git reset --hard "origin/$BRANCH" 2>/dev/null || git reset --hard origin/main || true
git pull --ff-only 2>/dev/null || true

# -----------------------------------------------------------------------------
# ENV MIGRATION — keep every existing install's .env up to date automatically.
#
# New releases sometimes need a new setting (e.g. SECRETS_KEY, which encrypts
# saved Discord/WhatsApp credentials). Clients must never have to hand-edit
# .env on their server, so we add anything missing here. Idempotent: an existing
# key is left exactly as-is, so nothing is ever overwritten or rotated.
# -----------------------------------------------------------------------------
ENVF="$REPO/backend/.env"
if [ -f "$ENVF" ]; then
  add_env() {  # add_env KEY "value"   → only if KEY is absent
    local key="$1" val="$2"
    if ! grep -qE "^[[:space:]]*${key}=" "$ENVF"; then
      # Ensure the file ends with a newline before appending.
      [ -n "$(tail -c1 "$ENVF")" ] && echo "" >> "$ENVF"
      echo "${key}=${val}" >> "$ENVF"
      echo "  • added missing ${key} to backend/.env"
    fi
  }
  gen48() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48; }

  # Encrypts operator-managed secrets at rest. Generated once, then never
  # changed — rotating it would make already-saved secrets undecryptable.
  add_env SECRETS_KEY "\"$(gen48)\""
  # Interim accounting interval — required for accurate live/online detection.
  add_env RADIUS_INTERIM_INTERVAL "300"

  chmod 600 "$ENVF" 2>/dev/null || true
fi

# Teach the assistant about any features shipped in this update: regenerate its
# knowledge from the code (every screen + every backend action). Best-effort —
# a missing python must never block a deploy.
if command -v python3 >/dev/null 2>&1 && [ -f "$REPO/tools/build_ai_knowledge.py" ]; then
  python3 "$REPO/tools/build_ai_knowledge.py" >/dev/null 2>&1 \
    && echo "🧠 Assistant knowledge regenerated from the codebase" \
    || echo "⚠ Assistant knowledge not regenerated (non-fatal)"
fi

# -----------------------------------------------------------------------------
# BUILD TOOLS MUST BE INSTALLED — even in production.
#
# `npm install` silently SKIPS devDependencies whenever NODE_ENV=production, and
# this server sets exactly that (ecosystem.config.js, and the panel's Update
# button runs this script as a child of the pm2 backend process, inheriting it).
# The Nest CLI and TypeScript live in devDependencies, so the install quietly
# removed them and the build died with:
#
#     sh: 1: nest: not found
#
# `set -e` then aborted the deploy, leaving the OLD dist running — which is why
# a fix could be pushed, pulled and "deployed" without ever taking effect.
# --include=dev overrides NODE_ENV and is safe on every install.
# -----------------------------------------------------------------------------
NPM_INSTALL="npm install --no-audit --no-fund --include=dev"

echo "🗄️  Applying database migrations + reconcile..."
cd "$REPO/backend"
$NPM_INSTALL

# Belt and braces: if the CLI is still absent (older npm ignores --include=dev,
# or a half-pruned node_modules), fetch it rather than failing the deploy.
if [ ! -x "$REPO/backend/node_modules/.bin/nest" ]; then
  echo "⚠ Nest CLI missing — installing build tools explicitly..."
  npm install --no-audit --no-fund --no-save @nestjs/cli@^11 || true
fi
# migrate deploy (versioned) + idempotent db push safety net. Guarantees the DB
# always matches schema.prisma, on a fresh, drifted, or clean server. See
# scripts/db-deploy.sh and MIGRATIONS.md.
npm run db:deploy

echo "🔧 Building backend..."
# A failed build must be UNMISSABLE. Previously `set -e` just ended the script
# mid-scroll, so the last thing on screen was a compiler message and it looked
# like the deploy had finished — while pm2 happily kept serving the old dist.
if ! npm run build; then   # produces backend/dist/main.js
  echo ""
  echo "❌ BACKEND BUILD FAILED — nothing was deployed."
  echo "   The previous version is still running, so the panel stays up."
  echo "   Fix the error above, then run this script again."
  exit 1
fi

echo "🎨 Building frontend..."
cd "$REPO/frontend"
# Same reason as the backend: `next build` needs TypeScript, which is a
# devDependency and therefore skipped under NODE_ENV=production.
$NPM_INSTALL
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

# --- Serve the domain on port 80 with NO nginx, PERMANENTLY. ---
# The frontend runs on 3000 (stable, unprivileged). We bridge port 80 → 3000 at
# the kernel and RE-APPLY it on every deploy so it can never be lost (the old
# approach of binding the frontend to :80 via FRONTEND_PORT was fragile because
# --update-env dropped the env each deploy). Idempotent + persisted.
if [ "$(id -u)" -eq 0 ]; then
  WEBPORT="$(pm2 jlist 2>/dev/null | grep -o '"PORT":"[0-9]*"' | head -1 | grep -o '[0-9]*')"; WEBPORT="${WEBPORT:-3000}"
  if [ "$WEBPORT" != "80" ]; then
    iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$WEBPORT" 2>/dev/null || {
      iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$WEBPORT" 2>/dev/null || true
      iptables -t nat -A OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports "$WEBPORT" 2>/dev/null || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    }
    netfilter-persistent save >/dev/null 2>&1 || true
    echo "🌐 Port 80 → $WEBPORT bridge active (http://<domain> works, no nginx)"
  fi
fi

# -----------------------------------------------------------------------------
# FreeRADIUS runs as the "freerad" service user, but config files edited by hand
# as root (clients.conf, mods-enabled/sql, etc.) become root-owned and unreadable
# to that user — which makes the service silently drop packets ("radius timeout")
# even though "freeradius -X" (run as root) works fine. Re-assert correct
# ownership every deploy so the service always behaves like -X. Harmless if the
# perms are already right.
if [ -d /etc/freeradius/3.0 ]; then
  # Capture MAC/NAS/port on every auth attempt (idempotent, self-validating).
  if [ -f backend/scripts/patch-postauth.sh ]; then
    bash backend/scripts/patch-postauth.sh || echo "⚠ post-auth capture patch skipped"
  fi
  chown -R freerad:freerad /etc/freeradius/3.0 /var/log/freeradius /var/run/freeradius 2>/dev/null || true
  systemctl restart freeradius 2>/dev/null || true
  systemctl is-active --quiet freeradius \
    && echo "📡 FreeRADIUS running (config owned by freerad — service matches -X)" \
    || echo "⚠ FreeRADIUS not active — run: journalctl -u freeradius -n 40 --no-pager"
fi

echo ""
echo "✅ Done. Status:"
pm2 list
echo ""
echo "Health:"
# Give the freshly-reloaded processes a few seconds to bind before checking, and
# retry — otherwise the check races the boot and prints a false "not responding".
check() { # $1=url $2=label
  for i in 1 2 3 4 5 6 7 8; do curl -fsS "$1" >/dev/null 2>&1 && { echo "  $2 OK"; return; }; sleep 2; done
  echo "  ⚠ $2 not responding after 16s — check: pm2 logs"
}
check http://localhost:3001/health "API (3001)"
# The web UI may be on 3000 (default) or 80 (FRONTEND_PORT=80 for a domain), so
# accept either — otherwise a port change reads as a false "not responding".
webok=""
for i in 1 2 3 4 5 6 7 8; do
  if curl -fsS http://localhost:3000 >/dev/null 2>&1; then webok="3000"; break; fi
  if curl -fsS http://localhost:80   >/dev/null 2>&1; then webok="80";   break; fi
  sleep 2
done
[ -n "$webok" ] && echo "  Web OK (:$webok)" || echo "  ⚠ Web not responding on :3000 or :80 — pm2 logs jointbox-frontend"
