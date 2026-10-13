#!/usr/bin/env bash
# =============================================================================
# Switch FreeRADIUS to the encrypted Jointbox router vault — safely.
#
# Router (NAS) shared secrets are stored encrypted in the database. FreeRADIUS
# cannot read those, so the app renders them into clients.d/jointbox-nas.conf.
# This script makes FreeRADIUS use that file instead of reading plaintext
# secrets from SQL, and never leaves RADIUS worse than it found it:
#
#   0. preflight: root, FreeRADIUS layout, built backend, encryption key can
#      decrypt every stored router secret, backend/.env not readable by others
#   1. back up clients.conf, the sql module and the current client file
#   2. render the client file from the vault (exit, unchanged, if any active
#      router's secret cannot be decrypted)
#   3. STAGE: apply the change to a private copy of the whole FreeRADIUS
#      config and validate THAT, as the FreeRADIUS user, including that every
#      router in the file is loaded as a client. Nothing live is touched yet.
#   4. apply to the live config: include the file by exact name (FreeRADIUS
#      does NOT expand wildcards: "$INCLUDE clients.d/*.conf", written by
#      earlier installers, stops it from starting), read_clients = no
#   5. validate the live config the same way
#   6. restart; confirm FreeRADIUS is running AND started after the file was
#      written (so the routers in it are the ones in effect)
#   7. any failure in 5–6: restore the backups and restart the old config
#   8. record the cutover time. Legacy plaintext secrets are NOT cleared here:
#      each is retired only once FreeRADIUS has accepted accounting from that
#      router through the file (the app does this), or by the operator with
#        node backend/scripts/radius-clients.js finalize --all
#      after testing logins.
#
# Idempotent: on a server already switched it refreshes the file and restarts
# only if it changed or the running FreeRADIUS has not loaded it yet.
#
#   sudo bash backend/scripts/radius-vault-cutover.sh             # switch / refresh
#   sudo bash backend/scripts/radius-vault-cutover.sh --dry-run   # steps 0–3 only
#   sudo bash backend/scripts/radius-vault-cutover.sh --status    # report, change nothing
#   sudo bash backend/scripts/radius-vault-cutover.sh --accept    # after testing logins:
#                                         retire every legacy plaintext copy
#   sudo bash backend/scripts/radius-vault-cutover.sh --rollback  # back to FreeRADIUS
#                                         reading routers from SQL (the newest
#                                         pre-vault backup), plaintext restored
#                                         from the vault first
#
# Exit 0 = FreeRADIUS reads the vault (or is not on this server; or dry run OK).
# Exit 1 = not root / backend not built.  2 = client file could not be built or
# a router secret cannot be decrypted (nothing changed).  3 = FreeRADIUS
# rejected the new config (live: old one restored).  4 = FreeRADIUS did not
# restart / did not load the routers (old one restored).  5 = another update
# holds the lock.  6 = --rollback / --accept not possible (nothing changed).
# =============================================================================
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-}"
case "$ACTION" in
  ""|--dry-run|--status|--accept|--rollback) ;;
  *) echo "usage: $0 [--dry-run | --status | --accept | --rollback]" >&2; exit 1 ;;
esac
DRY_RUN=0
[[ "$ACTION" == "--dry-run" ]] && DRY_RUN=1
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
STAGE=""
trap 'rm -f "$LOCK"; [[ -n "$STAGE" ]] && rm -rf "$STAGE"' EXIT

RUSER="$(awk '/^[[:space:]]*user[[:space:]]*=/{print $3; exit}' "$RAD/radiusd.conf" 2>/dev/null)"
RUSER="${RUSER:-freerad}"
RGROUP="$(stat -c %G "$RAD")"
CLIENTS_CONF="$RAD/clients.conf"
SQLMOD=""
[[ -e "$RAD/mods-enabled/sql" ]] && SQLMOD="$(readlink -f "$RAD/mods-enabled/sql")"
DIR="$RAD/clients.d"
FILE="$DIR/jointbox-nas.conf"
INCLUDE_LINE='$INCLUDE clients.d/jointbox-nas.conf'

# check <config dir> <log name>: FreeRADIUS's own check, as the FreeRADIUS
# user (as systemd's ExecStartPre does), with debug output so the clients it
# would load can be counted. Secrets are hidden in the saved log.
check() {
  local dir="$1" log="$BK/$2" rc
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUSER" -- "$BIN" -d "$dir" -XC 2>&1 | sed -E 's/(secret[[:space:]]*=).*/\1 <hidden>/I; s/(password[[:space:]]*=).*/\1 <hidden>/I' >"$log"
  else
    "$BIN" -d "$dir" -XC 2>&1 | sed -E 's/(secret[[:space:]]*=).*/\1 <hidden>/I; s/(password[[:space:]]*=).*/\1 <hidden>/I' >"$log"
  fi
  rc=${PIPESTATUS[0]}
  cp -f "$log" "$BK/check.log"
  [[ $rc -eq 0 ]] || return 1
  # every router in the file must be a client FreeRADIUS loads
  local loaded; loaded="$(grep -cE '^[[:space:]]*client jointbox-nas-[0-9]+ \{' "$log")"
  if [[ "$loaded" != "${CLIENTS:-0}" ]]; then
    echo "FreeRADIUS would load ${loaded} of the ${CLIENTS:-0} routers in the file (is the include line in effect?)" >>"$BK/check.log"
    return 1
  fi
  return 0
}
show_check() { grep -iE 'would load|\.conf\[[0-9]+\]|error|unable|failed|invalid|permission|duplicate|expect|unknown|missing|reached' "$BK/check.log" | grep -v 'Configuration appears to be OK' | sed -E 's/(secret[[:space:]]*=).*/\1 <hidden>/I' | tail -n 8 >&2; }

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
# FreeRADIUS reads clients only when it starts: it has the routers in the file
# only if it started after the file was last written.
loaded() {
  local pid etimes started mtime
  # the service's process (systemd MainPID), else the oldest one running as the
  # FreeRADIUS user — never a `freeradius -X` someone started by hand as root
  pid="$( (systemctl show -p MainPID --value freeradius 2>/dev/null) | grep -E '^[1-9][0-9]*$' || pgrep -o -u "$RUSER" -x freeradius)"
  [[ -n "$pid" ]] || return 1
  etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$etimes" ]] || return 1
  started=$(( $(date +%s) - etimes ))
  mtime="$(stat -c %Y "$FILE" 2>/dev/null || echo 0)"
  (( started + 2 >= mtime ))
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

edit_conf() { # edit_conf <clients.conf> <sql module or "">
  sed -i -E '/^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d\/\*\.conf[[:space:]]*$/d; /^# Jointbox encrypted NAS clients/d' "$1"
  if ! grep -qxF "$INCLUDE_LINE" "$1"; then
    printf '\n# Jointbox routers (NAS) — generated from the encrypted vault by the app. Do not edit the file.\n%s\n' "$INCLUDE_LINE" >> "$1"
  fi
  if [[ -n "$2" && -f "$2" ]]; then
    sed -i -E 's/^([[:space:]]*)read_clients[[:space:]]*=[[:space:]]*(yes|true)/\1read_clients = no/' "$2"
  fi
}


ALREADY=0
if grep -qxF "$INCLUDE_LINE" "$CLIENTS_CONF" \
   && ! grep -qE '^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d/\*\.conf' "$CLIENTS_CONF" \
   && { [[ -z "$SQLMOD" ]] || ! grep -qE '^[[:space:]]*read_clients[[:space:]]*=[[:space:]]*(yes|true)' "$SQLMOD"; }; then
  ALREADY=1
fi


node_cli() { (cd "$BACKEND_DIR" && node scripts/radius-clients.js "$@"); }

# ── --status: report only ─────────────────────────────────────────────────────
if [[ "$ACTION" == "--status" ]]; then
  say "FreeRADIUS config: $RAD (runs as $RUSER, group $RGROUP)"
  if [[ $ALREADY -eq 1 ]]; then say "routers come from: the encrypted vault file ($FILE)"; else say "routers come from: SQL (read_clients) — not switched to the vault yet"; fi
  grep -qE '^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d/\*\.conf' "$CLIENTS_CONF" && warn "clients.conf has the wildcard include that stops FreeRADIUS starting"
  if running; then say "FreeRADIUS: running$( [[ $ALREADY -eq 1 ]] && { loaded && echo ', router file loaded' || echo ', router file NOT loaded yet (changed after start)'; } )"; else warn "FreeRADIUS: NOT running"; fi
  [[ -f "$FILE" ]] && say "router file: $(stat -c '%a %U:%G' "$FILE"), $(grep -c '^client jointbox-nas-' "$FILE") router(s)"
  say "database: $(node_cli status 2>/dev/null || echo 'unreachable')"
  say "key: $(node_cli keycheck 2>/dev/null || echo 'some secrets do not decrypt')"
  exit 0
fi

# ── --accept: the operator has tested real logins through the vault file ─────
if [[ "$ACTION" == "--accept" ]]; then
  if [[ $ALREADY -ne 1 ]] || ! running || ! loaded; then
    warn "FreeRADIUS is not running on the vault file — nothing retired. Run the switch first."; exit 6
  fi
  R="$(node_cli finalize --all)" || { warn "could not retire the plaintext copies ($R)"; exit 6; }
  say "legacy plaintext copies retired: $R"
  say "the encrypted copies stay; --rollback can still rebuild plaintext from them while backend/.env keeps its key."
  exit 0
fi

# ── --rollback: back to FreeRADIUS reading routers from SQL ───────────────────
if [[ "$ACTION" == "--rollback" ]]; then
  if [[ $ALREADY -ne 1 ]] && ! grep -qE '^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d/\*\.conf' "$CLIENTS_CONF"; then
    say "FreeRADIUS already reads routers from SQL — nothing to roll back."; exit 6
  fi
  TARGET=""
  for d in $(ls -1d /var/backups/jointbox-radius/2*/ 2>/dev/null | sort -r); do
    d="${d%/}"
    [[ -f "$d/clients.conf" ]] || continue
    if [[ -f "$d/MODE" ]]; then
      [[ "$(cat "$d/MODE")" == "sql" ]] && { TARGET="$d"; break; }
    elif ! grep -qxF "$INCLUDE_LINE" "$d/clients.conf"; then
      TARGET="$d"; break   # backup from before MODE markers: pre-vault if no include
    fi
  done
  if [[ -z "$TARGET" ]]; then warn "no backup of the pre-vault configuration in /var/backups/jointbox-radius — nothing changed."; exit 6; fi
  say "rolling back to the configuration saved in $TARGET"
  BK="/var/backups/jointbox-radius/$(date +%Y%m%d-%H%M%S)-$$-before-rollback"
  mkdir -p "$BK" && chmod 700 "$BK"
  cp -a "$CLIENTS_CONF" "$BK/clients.conf"
  [[ -n "$SQLMOD" && -f "$SQLMOD" ]] && cp -a "$SQLMOD" "$BK/sql"
  [[ -f "$FILE" ]] && cp -a "$FILE" "$BK/jointbox-nas.conf"
  echo file > "$BK/MODE"
  CLIENTS=0   # the restored configuration loads no routers from the vault file
  # 1. validate the restored configuration in a private copy first
  STAGE="$(mktemp -d /run/jointbox-radius-stage.XXXXXX 2>/dev/null || mktemp -d)"
  chmod 0750 "$STAGE"; chgrp "$RGROUP" "$STAGE"
  cp -a "$RAD/." "$STAGE/"
  cat "$TARGET/clients.conf" > "$STAGE/clients.conf"
  STAGE_SQL=""; [[ -n "$SQLMOD" ]] && STAGE_SQL="$STAGE/${SQLMOD#"$RAD"/}"
  [[ -n "$STAGE_SQL" && -f "$STAGE_SQL" && -f "$TARGET/sql" ]] && cat "$TARGET/sql" > "$STAGE_SQL"
  # the wildcard include never worked (FreeRADIUS does not expand it): never restore it
  sed -i -E '/^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d\/\*\.conf[[:space:]]*$/d' "$STAGE/clients.conf"
  if ! check "$STAGE" check-rollback-staged.log; then
    warn "the saved pre-vault configuration does not pass FreeRADIUS's check — nothing changed:"; show_check; exit 6
  fi
  # 2. FreeRADIUS will read secrets from SQL again: put the plaintext back first
  R="$(node_cli restore-plaintext)" || { warn "could not restore router secrets for SQL ($R) — nothing changed."; exit 6; }
  say "router secrets restored for SQL: $R"
  # 3. live: contents only, so owner and permissions stay as they are
  cat "$TARGET/clients.conf" > "$CLIENTS_CONF"
  sed -i -E '/^[[:space:]]*\$INCLUDE[[:space:]]+clients\.d\/\*\.conf[[:space:]]*$/d' "$CLIENTS_CONF"
  [[ -n "$SQLMOD" && -f "$SQLMOD" && -f "$TARGET/sql" ]] && cat "$TARGET/sql" > "$SQLMOD"
  if ! check "$RAD" check-rollback-live.log; then
    warn "rollback configuration rejected live — putting the vault configuration back:"; show_check
    rollback; exit 3
  fi
  restart >/dev/null 2>&1
  if ! running; then
    warn "FreeRADIUS did not start on the restored configuration — putting the vault configuration back."
    rollback; restart >/dev/null 2>&1
    running && say "vault configuration restored; FreeRADIUS is running." || warn "FreeRADIUS is NOT running — see: journalctl -u freeradius -n 50"
    exit 4
  fi
  node_cli mark-rollback >/dev/null 2>&1 || true
  say "FreeRADIUS reads routers from SQL again (running). The vault file is kept but no longer included."
  say "to switch back later: sudo bash $0"
  say "configuration that was live before this rollback: $BK"
  exit 0
fi

# ── 0. preflight ──────────────────────────────────────────────────────────────
ENVF="$BACKEND_DIR/.env"
if [[ -f "$ENVF" ]] && [[ "$(stat -c %a "$ENVF")" != "600" && "$(stat -c %a "$ENVF")" != "400" ]]; then
  chmod 600 "$ENVF" && say "backend/.env holds the encryption key — permissions tightened to 600."
fi
KEYCHECK="$(cd "$BACKEND_DIR" && node scripts/radius-clients.js keycheck 2>/dev/null)"; KRC=$?
if [[ $KRC -eq 3 ]]; then
  warn "stored router secrets do not decrypt with the key in backend/.env ($KEYCHECK)."
  warn "SECRETS_KEY / JWT_SECRET must be the value they were encrypted with. Nothing was changed."
  exit 2
elif [[ $KRC -ne 0 ]]; then
  warn "could not read the routers from the database ($KEYCHECK). Nothing was changed."; exit 2
fi
say "encryption key OK: $KEYCHECK"

# FreeRADIUS runs as $RUSER and cannot start if it cannot read its own config
# (e.g. clients.conf copied over as root:root 0640). Content is not changed.
for f in "$CLIENTS_CONF" "$SQLMOD"; do
  [[ -n "$f" && -f "$f" ]] || continue
  if command -v runuser >/dev/null 2>&1 && ! runuser -u "$RUSER" -- test -r "$f" 2>/dev/null; then
    chgrp "$RGROUP" "$f" && chmod g+r "$f" && say "made $(basename "$f") readable by FreeRADIUS ($RUSER)."
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
BK="/var/backups/jointbox-radius/$STAMP"
mkdir -p "$BK" && chmod 700 /var/backups/jointbox-radius "$BK"
cp -a "$CLIENTS_CONF" "$BK/clients.conf"
[[ -n "$SQLMOD" && -f "$SQLMOD" ]] && cp -a "$SQLMOD" "$BK/sql"
[[ -f "$FILE" ]] && cp -a "$FILE" "$BK/jointbox-nas.conf"
# what this backup is, for --rollback: sql = FreeRADIUS still read routers from SQL
if [[ $ALREADY -eq 1 ]]; then echo file > "$BK/MODE"; else echo sql > "$BK/MODE"; fi
# keep the newest 30 backups
ls -1d /var/backups/jointbox-radius/2*/ 2>/dev/null | sort | head -n -30 | while read -r old; do rm -rf "${old%/}"; done

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

# ── 3. stage: the complete resulting configuration, validated in a private copy
STAGE="$(mktemp -d /run/jointbox-radius-stage.XXXXXX 2>/dev/null || mktemp -d)"
chmod 0750 "$STAGE"; chgrp "$RGROUP" "$STAGE"
cp -a "$RAD/." "$STAGE/"
cp -f "$NEW" "$STAGE/clients.d/jointbox-nas.conf"
chown "root:$RGROUP" "$STAGE/clients.d/jointbox-nas.conf"; chmod 0640 "$STAGE/clients.d/jointbox-nas.conf"
STAGE_SQL=""
[[ -n "$SQLMOD" ]] && STAGE_SQL="$STAGE/${SQLMOD#"$RAD"/}"
[[ -n "$STAGE_SQL" && ! -f "$STAGE_SQL" ]] && STAGE_SQL=""   # sql module outside the config dir
edit_conf "$STAGE/clients.conf" "$STAGE_SQL"
if ! check "$STAGE" check-staged.log; then
  rm -f "$NEW"
  warn "the new configuration does not pass FreeRADIUS's check (validated in a copy — the live configuration was NOT touched):"; show_check
  exit 3
fi
say "staged configuration validated: FreeRADIUS loads all ${CLIENTS:-0} router(s) from the file."
if [[ $DRY_RUN -eq 1 ]]; then
  rm -f "$NEW"
  say "dry run: nothing changed. Run without --dry-run to apply."
  exit 0
fi

mv -f "$NEW" "$FILE"
chown "root:$RGROUP" "$FILE" && chmod 0640 "$FILE"

# ── 3. config ─────────────────────────────────────────────────────────────────
# ── 4. live config ────────────────────────────────────────────────────────────
[[ $ALREADY -eq 0 ]] && edit_conf "$CLIENTS_CONF" "$SQLMOD"

if [[ $ALREADY -eq 1 && $CHANGED -eq 0 ]] && running && loaded; then
  say "already using the vault, up to date and loaded by FreeRADIUS — nothing to restart."
  (cd "$BACKEND_DIR" && node scripts/radius-clients.js mark-cutover >/dev/null) || true
  # retires only routers already proven by accounting through the file
  (cd "$BACKEND_DIR" && node scripts/radius-clients.js finalize >/dev/null) || true
  exit 0
fi

# ── 5. validate live ──────────────────────────────────────────────────────────
if ! check "$RAD" check-live.log; then
  warn "FreeRADIUS rejected the new configuration:"; show_check
  rollback
  if check "$RAD" check-restored.log || grep -q 'Configuration appears to be OK' "$BK/check-restored.log"; then say "previous configuration restored and valid."; else warn "the PREVIOUS configuration does not pass the check either:"; show_check; fi
  exit 3
fi

# ── 6. restart ────────────────────────────────────────────────────────────────
restart >/dev/null 2>&1
if ! running || ! loaded; then
  warn "FreeRADIUS did not come back up with the new configuration."
  rollback
  restart >/dev/null 2>&1
  if running; then say "previous configuration restored; FreeRADIUS is running."; else warn "FreeRADIUS is NOT running — see: journalctl -u freeradius -n 50"; fi
  exit 4
fi

# ── 8. record ─────────────────────────────────────────────────────────────────
(cd "$BACKEND_DIR" && node scripts/radius-clients.js mark-cutover >/dev/null) || true
STATUS="$(cd "$BACKEND_DIR" && node scripts/radius-clients.js status 2>/dev/null)"
say "FreeRADIUS now reads ${CLIENTS:-0} router(s) from the encrypted vault (running, loaded after the file was written)."
PLAIN="$(printf '%s' "$STATUS" | sed -n 's/.*"plaintext":\([0-9]*\).*/\1/p')"
if [[ "${PLAIN:-0}" != "0" ]]; then
  say "${PLAIN} legacy plaintext cop(ies) KEPT: each is retired once FreeRADIUS accepts accounting from that router through the file."
  say "after testing logins you may retire the rest: node $BACKEND_DIR/scripts/radius-clients.js finalize --all"
else
  say "no plaintext router secrets are stored."
fi
say "backup of the previous configuration: $BK"
exit 0
