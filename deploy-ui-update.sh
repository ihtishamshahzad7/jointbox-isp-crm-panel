#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Jointbox — deployment (compatibility wrapper)
# ═══════════════════════════════════════════════════════════════════════
# This script is kept only so old habits/bookmarks keep working. The real,
# single source of truth is ./update-jointbox.sh, which pulls, migrates the
# DB, builds, and (re)starts BOTH apps through ecosystem.config.js — starting
# the real entrypoints directly so pm2 never orphans a port (the old crash
# loop). Do not add deploy steps here; edit update-jointbox.sh instead.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
echo "→ Delegating to update-jointbox.sh (the current deploy script)…"
exec bash "$DIR/update-jointbox.sh"
