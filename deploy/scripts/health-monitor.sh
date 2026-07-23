#!/usr/bin/env bash
# ===================================================================
#  Jointbox — health monitor. Alerts when a core service is down or
#  disk is low. Know before your customers call.
#
#  Install:
#    sudo cp health-monitor.sh /usr/local/bin/jointbox-health && sudo chmod +x /usr/local/bin/jointbox-health
#    sudo crontab -e   ->   */2 * * * *  /usr/local/bin/jointbox-health
#
#  Set a Telegram bot (easiest) or an email command:
#    export TG_TOKEN=123:abc  TG_CHAT=456789
# ===================================================================
set -uo pipefail

DISK_WARN_PCT=85
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
TG_TOKEN="${TG_TOKEN:-}"
TG_CHAT="${TG_CHAT:-}"
HOST="$(hostname)"
problems=()

alert() {
  local msg="[$HOST] $1"
  echo "$msg"
  if [[ -n "$TG_TOKEN" && -n "$TG_CHAT" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d chat_id="${TG_CHAT}" -d text="$msg" >/dev/null || true
  fi
  # Or wire your own mail:  echo "$msg" | mail -s "Jointbox alert" you@example.com
}

# 1. PostgreSQL up?
if ! pg_isready -q 2>/dev/null; then problems+=("PostgreSQL is DOWN"); fi

# 2. FreeRADIUS running?
if ! systemctl is-active --quiet freeradius 2>/dev/null; then problems+=("FreeRADIUS is DOWN"); fi

# 3. Backend API answering?
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BACKEND_URL" || echo 000)"
if [[ "$code" == "000" ]]; then problems+=("Backend API not responding ($BACKEND_URL)"); fi

# 4. Redis (if used)
if command -v redis-cli >/dev/null && ! redis-cli ping >/dev/null 2>&1; then
  problems+=("Redis is DOWN"); fi

# 5. Disk space (a full disk stops accounting writes = outage)
pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if (( pct >= DISK_WARN_PCT )); then problems+=("Disk ${pct}% full on /"); fi

# 6. PgBouncer (if used)
if systemctl list-unit-files 2>/dev/null | grep -q pgbouncer; then
  systemctl is-active --quiet pgbouncer || problems+=("PgBouncer is DOWN")
fi

if (( ${#problems[@]} > 0 )); then
  for p in "${problems[@]}"; do alert "$p"; done
  exit 1
fi
echo "[$HOST] all healthy"
