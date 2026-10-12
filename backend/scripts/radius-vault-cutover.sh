#!/usr/bin/env bash
# =============================================================================
# Switch FreeRADIUS to the encrypted Jointbox router vault — safely.
#
# Router (NAS) shared secrets are stored encrypted in the database. FreeRADIUS
# cannot read those, so the app renders them into clients.d/jointbox-nas.conf.
# This script makes FreeRADIUS use that file instead of reading plaintext
# secrets from SQL, and never leaves RADIUS worse than it found it:
#
#   1. back up clients.conf, the sql module and the current client file
#   2. render the client file from the vault (exit, unchanged, if any active
#      router's secret cannot be decrypted)
#   3. include the file by exact name (FreeRADIUS does NOT expand wildcards:
#      "$INCLUDE clients.d/*.conf", written by earlier installers, stops it
#      from starting) and set read_clients = no
#   4. check the configuration AS THE FREERADIUS USER (as systemd does)
#   5. restart and confirm FreeRADIUS is running
#   6. any failure in 4–5: restore the backups and restart the old config
#   7. only after success: clear the plaintext secrets from the database
#
# Idempotent: on a server already switched it just refreshes the file (and
# restarts only if it changed). Run as root from anywhere:
#     sudo bash backend/scripts/radius-vault-cutover.sh
# Exit 0 = FreeRADIUS reads the vault (or is not on this server).
# Exit 2 = client file could not be built (nothing changed), 3 = FreeRADIUS
# rejected the new config (old one restored), 4 = FreeRADIUS did not restart
# (old one restored), 5 = another update holds the lock.
# =============================================================================
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say()  { echo "[radius-vault] $*"; }
warn() { echo "[radius-vault] WARNING: $*" >&2; }

if [[ "$(id -u)" != "0" ]]; then warn "run as root (sudo)"; exit 1; fi

RAD=""
for d in /etc/freeradius/3.0 /etc/freeradius /etc/raddb; do
  [[ -f "$d/radiusd.conf" ]] && { RAD="$d"; break; }
done
if [[ -z "$RAD" ]]; then say "FreeRADIUS is not installed on this server — nothing to do."; exit 0; fi
BIN="$(command -v freeradius || command -v radiusd || true)"
[[ -z "$BIN" && -x /usr/sbin/freeradius ]] && BIN=/usr/sbin/freeradius
if [[ -z "$BIN" ]]; then say "FreeRADIUS binary not found — nothing to do."; exit 0; fi
if [[ ! -f "$BACKEND_DIR/dist/nas/radius-clients-render.js" ]]; then
  warn "the backend is not built yet (dist/ missing) — run this after the build."; exit 1
fi

# ── one writer at a time ───────────────────────────────────────────────────────
# The backend (every pm2 worker) rewrites the same file and restarts FreeRADIUS
# when a router changes. Same lock file and format as backend/src/nas/radius-host.ts:
# created exclusively, holding "<pid> <epoch-ms>"; a dead or 10-minute-old
# holder is cleared.
LOCK="${JOINTBOX_RADIUS_LOCK:-}"
if [[ -z "$LOCK" ]]; then
  for d in /run/lock /var/lock; do [[ -d "$d" && -w "$d" ]] && { LOCK="$d/jointbox-radius.lock"; break; }; done
  LOCK="${LOCK:-${TMPDIR:-/tmp}/jointbox-radius.lock}"
fi
now_ms() { date +%s%3N; }
got_lock=0
for _ in $(seq 1 300); do
  if ( set -o noclobber; printf '%s %s\n' "$$" "$(now_ms)" > "$LOCK" ) 2>/dev/null; then got_lock=1; break; fi
  held="$(cat "$LOCK" 2>/dev/null)"; lpid="${held%% *}"; lat="${held##* }"
  # just created, holder id not written yet
  if [[ -z "$held" ]] && (( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) < 5 )); then sleep 0.5; continue; fi
  if [[ ! "$lpid" =~ ^[0-9]+$ || ! "$lat" =~ ^[0-9]+$ ]] || ! kill -0 "$lpid" 2>/dev/null || (( $(now_ms) - lat > 600000 )); then
    # only clear it if it is still the same stale holder
    [[ "$(cat "$LOCK" 2>/dev/null)" == "$held" ]] && rm -f "$LOCK"
    continue
  fi
  sleep 0.5
done
if [[ $got_lock -ne 1 ]]; then warn "another FreeRADIUS update is still running (lock $LOCK) — try again in a minute."; exit 5; fi
trap 'rm -f "$LOCK"' EXIT

RUSER="$(awk '/^[[:space:]]*user[[:space:]]*=/{print $3; exit}' "$RAD/radiusd.conf" 2>/dev/null)"
RUSER="${RUSER:-freerad}"
RGROUP="$(stat -c %G "$RAD")"
CLIENTS_CONF="$RAD/clients.conf"
SQLMOD=""
[[ -e "$RAD/mods-enabled/sql" ]] && SQLMOD="$(readlink -f "$RAD/mods-enabled/sql")"
DIR="$RAD/clients.d"
FILE="$DIR/jointbox-nas.conf"
INCLUDE_LINE='$INCLUDE clients.d/jointbox-nas.conf'

# FreeRADIUS runs as $RUSER and cannot start if it cannot read its own config
# (e.g. clients.conf copied over as root:root 0640). Content is not changed.
for f in "$CLIENTS_CONF" "$SQLMOD"; do
  [[ -n "$f" && -f "$f" ]] || continue
  if command -v runuser >/dev/null 2>&1 && ! runuser -u "$RUSER" -- test -r "$f" 2>/dev/null; then
    chgrp "$RGROUP" "$f" && chmod g+r "$f" && say "made $(basename "$f") readable by FreeRADIUS ($RUSER)."
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BK="/var/backups/jointbox-radius/$STAMP"
mkdir -p "$BK" && chmod 700 /var/backups/jointbox-radius "$BK"
cp -a "$CLIENTS_CONF" "$BK/clients.conf"
[[ -n "$SQLMOD" && -f "$SQLMOD" ]] && cp -a "$SQLMOD" "$BK/sql"
[[ -f "$FILE" ]] && cp -a "$FILE" "$BK/jointbox-nas.conf"

check() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUSER" -- "$BIN" -d "$RAD" -Cx -lstdout >"$BK/check.log" 2>&1
  else
    "$BIN" -d "$RAD" -XC >"$BK/check.log" 2>&1
  fi
}
show_check() { grep -iE '\.conf\[[0-9]+\]|error|unable|failed|invalid|permission|duplicate|expect|unknown|missing|reached' "$BK/check.log" | sed -E 's/(secret[[:space:]]*=).*/\1 <hidden>/I' | tail -n 8 >&2; }

running() {
  for _ in $(seq 1 12); do
    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active --quiet freeradius && return 0
    else
      pgrep -x freeradius >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  return 1
}
restart() {
  if command -v systemctl >/dev/null 2>&1; then systemctl restart freeradius; else service freeradius restart; fi
}
rollback() {
  warn "restoring the previous FreeRADIUS configuration from $BK"
  cp -a "$BK/clients.conf" "$CLIENTS_CONF"
  [[ -f "$BK/sql" && -n "$SQLMOD" ]] && cp -a "$BK/sql" "$SQLMOD"
  if [[ -f "$BK/jointbox-nas.conf" ]]; then cp -a "$BK/jointbox-nas.conf" "$FILE"; fi
}

ALREADY=0
if grep -qxF "$INCLUDE_LINE" "$CLIENTS_CONF" \
   && ! grep -qE '^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d/\*\.conf' "$CLIENTS_CONF" \
   && { [[ -z "$SQLMOD" ]] || ! grep -qE '^[[:space:]]*read_clients[[:space:]]*=[[:space:]]*(yes|true)' "$SQLMOD"; }; then
  ALREADY=1
fi

# ── 2. render ─────────────────────────────────────────────────────────────────
mkdir -p "$DIR"
chown "root:$RGROUP" "$DIR" && chmod 0750 "$DIR"
NEW="$DIR/.jointbox-nas.conf.new"
RESULT="$(cd "$BACKEND_DIR" && node scripts/radius-clients.js render --out "$NEW" --clients-conf "$CLIENTS_CONF" --group-of "$RAD")"
RC=$?
if [[ $RC -ne 0 ]]; then
  rm -f "$NEW"
  warn "could not build the client file — FreeRADIUS left exactly as it was. ($RESULT)"
  [[ $RC -eq 3 ]] && warn "some router secrets cannot be decrypted: check SECRETS_KEY / JWT_SECRET in backend/.env did not change."
  exit 2
fi
CLIENTS="$(printf '%s' "$RESULT" | sed -n 's/.*"clients":\([0-9]*\).*/\1/p')"
ACTIVE="$(printf '%s' "$RESULT" | sed -n 's/.*"active":\([0-9]*\).*/\1/p')"
say "client file built: ${CLIENTS:-0} of ${ACTIVE:-0} active router(s)."
if printf '%s' "$RESULT" | grep -q '"skipped":\[{'; then
  warn "some routers were left out (no secret, invalid address, or duplicate): $(printf '%s' "$RESULT" | sed -n 's/.*"skipped":\(\[.*\]\).*/\1/p')"
fi

CHANGED=1
if [[ -f "$FILE" ]] && cmp -s "$NEW" "$FILE"; then CHANGED=0; fi
mv -f "$NEW" "$FILE"
chown "root:$RGROUP" "$FILE" && chmod 0640 "$FILE"

# ── 3. config ─────────────────────────────────────────────────────────────────
if [[ $ALREADY -eq 0 ]]; then
  # Drop the wildcard include (and its comment) earlier installers appended,
  # then include our file by name, once.
  sed -i -E '/^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d\/\*\.conf[[:space:]]*$/d; /^# Jointbox encrypted NAS clients/d' "$CLIENTS_CONF"
  if ! grep -qxF "$INCLUDE_LINE" "$CLIENTS_CONF"; then
    printf '\n# Jointbox routers (NAS) — generated from the encrypted vault by the app. Do not edit the file.\n%s\n' "$INCLUDE_LINE" >> "$CLIENTS_CONF"
  fi
  if [[ -n "$SQLMOD" && -f "$SQLMOD" ]]; then
    sed -i -E 's/^([[:space:]]*)read_clients[[:space:]]*=[[:space:]]*(yes|true)/\1read_clients = no/' "$SQLMOD"
  fi
fi

if [[ $ALREADY -eq 1 && $CHANGED -eq 0 ]]; then
  if running; then
    say "already using the vault and up to date — nothing to restart."
    (cd "$BACKEND_DIR" && node scripts/radius-clients.js finalize >/dev/null) || true
    exit 0
  fi
fi

# ── 4. check ──────────────────────────────────────────────────────────────────
if ! check; then
  warn "FreeRADIUS rejected the new configuration:"; show_check
  rollback
  if check; then say "previous configuration restored and valid."; else warn "the PREVIOUS configuration does not pass the check either:"; show_check; fi
  exit 3
fi

# ── 5. restart ────────────────────────────────────────────────────────────────
restart >/dev/null 2>&1
if ! running; then
  warn "FreeRADIUS did not come back up with the new configuration."
  rollback
  restart >/dev/null 2>&1
  if running; then say "previous configuration restored; FreeRADIUS is running."; else warn "FreeRADIUS is NOT running — see: journalctl -u freeradius -n 50"; fi
  exit 4
fi

# ── 7. finalize ───────────────────────────────────────────────────────────────
FIN="$(cd "$BACKEND_DIR" && node scripts/radius-clients.js finalize)" || FIN='{"ok":false}'
say "FreeRADIUS now reads ${CLIENTS:-0} router(s) from the encrypted vault (plaintext cleanup: $FIN)."
say "backup of the previous configuration: $BK"
exit 0
