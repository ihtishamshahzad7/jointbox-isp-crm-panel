#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Jointbox — one-line installer entrypoint.
# On a fresh Ubuntu 22.04/24.04, the end user runs ONE command:
#
#   curl -fsSL https://raw.githubusercontent.com/<YOU>/<REPO>/main/deploy/bootstrap.sh | sudo bash
#
# It installs git, clones the repo to /opt/jointbox, and runs the full
# installer (Node, PostgreSQL, Redis, FreeRADIUS, Nginx, the app).
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# EDIT THIS to your public repo before publishing:
REPO_URL="${JOINTBOX_REPO:-https://github.com/CHANGE-ME/jointbox.git}"
BRANCH="${JOINTBOX_BRANCH:-main}"
APP_DIR="/opt/jointbox"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo:  curl ... | sudo bash"; exit 1; fi

echo "==> Jointbox bootstrap"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git

if [[ -d "$APP_DIR/.git" ]]; then
  echo "==> Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  echo "==> Cloning $REPO_URL"
  rm -rf "$APP_DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

chmod +x "$APP_DIR/deploy/install-ubuntu.sh"
bash "$APP_DIR/deploy/install-ubuntu.sh"
