#!/bin/bash
# =============================================================================
# firewall.sh — close everything that should not face the internet.
#
#   REVIEW FIRST:   bash scripts/firewall.sh --dry-run
#   THEN APPLY:     sudo bash scripts/firewall.sh --apply
#
# It refuses to do anything without an explicit flag, because a firewall script
# that runs by accident is how people lock themselves out of their own server.
#
# WHAT IS EXPOSED TODAY (before this runs)
#   22   SSH            → keep, but only this is meant to be open
#   80   Caddy          → keep (HTTPS redirect + certificate renewal)
#   443  Caddy          → keep (the panel)
#   3000 Next.js        → CLOSE: reachable directly, bypassing TLS entirely
#   3001 NestJS API     → CLOSE: the whole API without HTTPS, and no CORS in the way
#   5432 PostgreSQL     → CLOSE: every subscriber, password hash and invoice
#   1812 RADIUS auth    → restrict to your NAS routers only
#   1813 RADIUS acct    → restrict to your NAS routers only
#   3799 RADIUS CoA     → outbound to routers; no inbound rule needed
#
# The 3000/3001 ones matter more than they look. Anyone who knows the IP can
# open http://202.141.236.43:3001 and talk to the API over plain HTTP —
# unencrypted, and skipping every header and redirect Caddy adds.
# =============================================================================
set -e

MODE="${1:---help}"

# ── YOUR NAS ROUTERS ─────────────────────────────────────────────────────────
# Only these may send RADIUS. Add every router's PUBLIC IP here — if a router
# sits behind NAT, use the public address its packets arrive from.
# Leave the array empty to allow RADIUS from anywhere (NOT recommended: an open
# RADIUS port is a well-known reflection/amplification target).
NAS_IPS=(
  "192.168.88.17"     # example — replace with your real router IPs
)

# Optional: restrict SSH to your own address. Empty = SSH open to the world
# (still key/password protected). Set it once you are sure of your IP, or you
# risk locking yourself out from a different network.
SSH_ALLOW=()

rules() {
  echo "# Reset to a known state"
  echo "ufw --force reset"
  echo
  echo "# Default: block incoming, allow outgoing"
  echo "ufw default deny incoming"
  echo "ufw default allow outgoing"
  echo
  echo "# SSH — FIRST, so enabling the firewall cannot cut your session"
  if [ ${#SSH_ALLOW[@]} -eq 0 ]; then
    echo "ufw allow 22/tcp comment 'SSH'"
  else
    for ip in "${SSH_ALLOW[@]}"; do echo "ufw allow from $ip to any port 22 proto tcp comment 'SSH'"; done
  fi
  echo
  echo "# The panel"
  echo "ufw allow 80/tcp  comment 'HTTP - redirect + cert renewal'"
  echo "ufw allow 443/tcp comment 'HTTPS - the panel'"
  echo
  echo "# RADIUS — only from your routers"
  if [ ${#NAS_IPS[@]} -eq 0 ]; then
    echo "# (no NAS IPs configured — RADIUS left OPEN, which you should fix)"
    echo "ufw allow 1812/udp comment 'RADIUS auth'"
    echo "ufw allow 1813/udp comment 'RADIUS acct'"
  else
    for ip in "${NAS_IPS[@]}"; do
      echo "ufw allow from $ip to any port 1812 proto udp comment 'RADIUS auth $ip'"
      echo "ufw allow from $ip to any port 1813 proto udp comment 'RADIUS acct $ip'"
    done
  fi
  echo
  echo "# Everything else stays closed by the default-deny above:"
  echo "#   3000 Next.js, 3001 API, 5432 PostgreSQL, 6379 Redis"
  echo "# They keep working because Caddy reaches them over 127.0.0.1,"
  echo "# which the firewall does not filter."
  echo
  echo "ufw --force enable"
  echo "ufw status numbered"
}

case "$MODE" in
  --dry-run)
    echo "These are the commands that WOULD run. Nothing has been changed."
    echo "────────────────────────────────────────────────────────────────"
    rules
    echo "────────────────────────────────────────────────────────────────"
    echo
    echo "Before applying, check two things:"
    echo "  1. NAS_IPS at the top of this file lists every one of your routers."
    echo "     A missing router = its customers cannot authenticate."
    echo "  2. You can reconnect over SSH from a second terminal if something"
    echo "     goes wrong. Do NOT apply this from your only session."
    ;;
  --apply)
    [ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
    command -v ufw >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq ufw; }
    echo "🔥 Applying firewall rules..."
    rules | grep -v '^#' | grep -v '^$' | while read -r cmd; do
      echo "   $cmd"
      eval "$cmd"
    done
    echo
    echo "✅ Firewall active. Verify from ANOTHER machine that these are refused:"
    echo "     nc -zv <this-ip> 5432     # PostgreSQL — must fail"
    echo "     nc -zv <this-ip> 3001     # API        — must fail"
    echo "     curl -I https://<this-ip> # panel      — must work"
    ;;
  *)
    echo "Usage:"
    echo "  bash scripts/firewall.sh --dry-run    # show the rules, change nothing"
    echo "  sudo bash scripts/firewall.sh --apply # apply them"
    exit 1
    ;;
esac
