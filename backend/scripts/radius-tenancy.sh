#!/usr/bin/env bash
# =============================================================================
# RADIUS tenancy policy: a subscriber may only log in on (and be accounted by)
# a router of its own company, or one explicitly shared into it.
# Policy, rollout and rollback: docs/RADIUS_TENANCY.md
#
# The decision is made in the database (migration
# 20261013130000_radius_tenancy_policy); this script wires FreeRADIUS to it and
# flips the switch. Staged rollout:
#
#   sudo bash backend/scripts/radius-tenancy.sh --report     # 1. who owns what; what enforcing would refuse
#   sudo bash backend/scripts/radius-tenancy.sh --install    # 2. hook FreeRADIUS up (in monitor mode nothing
#                                                            #    is refused; would-be refusals are counted)
#   sudo bash backend/scripts/radius-tenancy.sh --status     # 3. watch what monitor mode records
#   sudo bash backend/scripts/radius-tenancy.sh --enforce    # 4. refuse; stops while anything real would be refused
#   sudo bash backend/scripts/radius-tenancy.sh --monitor    # rollback, instant: count but never refuse
#   sudo bash backend/scripts/radius-tenancy.sh --off        # rollback, instant: no check at all
#   sudo bash backend/scripts/radius-tenancy.sh --uninstall  # take the hooks out of FreeRADIUS again
#
# --enforce --force overrides the "would refuse real subscribers" stop after
# an explicit confirmation: type ENFORCE at the prompt, or (no terminal) set
# JOINTBOX_TENANCY_CONFIRM=ENFORCE. --install --force installs even though
# another enabled virtual server processes logins or accounting (it is NOT
# covered by the policy — see the listing).
#
# --monitor / --enforce / --off change one database row: FreeRADIUS reads it on
# every request, so they take effect immediately with no restart. Every change
# is recorded in SystemLog (source radius-tenancy) and syslog. Only --install
# and --uninstall edit the FreeRADIUS configuration (policy.d/jointbox-tenancy;
# hooks in sites-enabled/default and, when enabled, sites-enabled/inner-tunnel);
# both validate a staged copy as the FreeRADIUS user first, back up what they
# change, and put the previous configuration back if FreeRADIUS rejects the
# new one or does not come back up.
#
# Never prints secrets: database passwords travel in the environment, not on a
# command line, and nothing from the router list is read.
#
# Exit 0 = done.  1 = usage / not root / no database / migration missing.
# 2 = FreeRADIUS layout or database access not as expected (nothing changed).
# 3 = FreeRADIUS rejected the new configuration (live: previous one restored).
# 4 = FreeRADIUS did not restart (previous one restored).  5 = another
# FreeRADIUS update holds the lock.  6 = --enforce stopped (see the listing;
# nothing changed).
# =============================================================================
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() { echo "usage: $0 --report | --status | --install [--force] | --uninstall | --monitor | --enforce [--force] | --off" >&2; exit 1; }
ACTION="${1:-}"
[[ $# -gt 0 ]] && shift
FORCE=0
for a in "$@"; do
  case "$a" in --force) FORCE=1 ;; *) usage ;; esac
done
case "$ACTION" in
  --report|--status|--install|--uninstall|--monitor|--enforce|--off) ;;
  *) usage ;;
esac
[[ $FORCE -eq 1 && "$ACTION" != "--enforce" && "$ACTION" != "--install" ]] && usage
say()  { echo "[radius-tenancy] $*"; }
warn() { echo "[radius-tenancy] WARNING: $*" >&2; }

if [[ "$(id -u)" != "0" ]]; then warn "run as root (sudo)"; exit 1; fi
command -v psql >/dev/null 2>&1 || { warn "psql not found (apt install postgresql-client)"; exit 1; }
command -v node >/dev/null 2>&1 || { warn "node not found"; exit 1; }

# ── database ──────────────────────────────────────────────────────────────────
# DATABASE_URL from the environment, else backend/.env.
DBURL="${DATABASE_URL:-}"
if [[ -z "$DBURL" && -f "$BACKEND_DIR/.env" ]]; then
  DBURL="$(sed -n -E 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' "$BACKEND_DIR/.env" | tail -1)"
fi
[[ -n "$DBURL" ]] || { warn "DATABASE_URL is not set and not in backend/.env"; exit 1; }
# The URL is turned into libpq environment variables (PGHOST, PGPASSWORD, …)
# so the password never appears on a command line (`ps` shows those to every
# user). Prisma-only URL options (schema=, connection_limit=, …) are ignored.
PGVARS="$(JBX_DBURL="$DBURL" node -e '
  const u = new URL(process.env.JBX_DBURL);
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const out = [];
  const put = (k, v) => { if (v) out.push("export " + k + "=" + q(v)); };
  put("PGHOST", u.searchParams.get("host") || decodeURIComponent(u.hostname).replace(/^\[|\]$/g, ""));
  put("PGPORT", u.searchParams.get("port") || u.port);
  put("PGUSER", decodeURIComponent(u.username));
  put("PGPASSWORD", decodeURIComponent(u.password));
  put("PGDATABASE", decodeURIComponent(u.pathname.replace(/^\//, "")));
  put("PGSSLMODE", u.searchParams.get("sslmode"));
  console.log(out.join("\n"));
' 2>/dev/null)" || { warn "DATABASE_URL is not a valid URL"; exit 1; }
eval "$PGVARS"; unset PGVARS DBURL
export PGCONNECT_TIMEOUT=10 PGAPPNAME=radius-tenancy
sqlq() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
sqlp() { psql -X -q -P pager=off -P footer=off -v ON_ERROR_STOP=1 "$@"; }

FN_AUTH='public.jointbox_radius_tenancy(text,text,text,text)'
FN_ONOFF='public.jointbox_radius_tenancy_onoff(text,text)'
if [[ "$(sqlq "SELECT to_regprocedure('$FN_AUTH') IS NOT NULL AND to_regprocedure('$FN_ONOFF') IS NOT NULL")" != "t" ]]; then
  warn "the database has no (current) tenancy policy — run the database migrations first (npm run db:deploy)."
  exit 1
fi
MODE="$(sqlq "SELECT public.jointbox_radius_tenancy_mode()")"

# Every mode change is recorded: syslog, and SystemLog (shown to the platform
# account in the panel's system log). Values reach SQL as psql variables.
audit() { # audit <level> <message> <metadata json>
  logger -t jointbox-radius-tenancy -- "$2" 2>/dev/null || true
  printf '%s\n' "INSERT INTO \"SystemLog\" (level, source, message, metadata) VALUES (:'lvl', 'radius-tenancy', :'msg', :'meta');" \
    | psql -X -q -v ON_ERROR_STOP=1 -v lvl="$1" -v msg="$2" -v meta="$3" >/dev/null 2>&1 \
    || warn "the change was made but could not be written to SystemLog"
}

# ── FreeRADIUS layout ─────────────────────────────────────────────────────────
RAD=""
for d in /etc/freeradius/3.0 /etc/freeradius /etc/raddb; do
  [[ -f "$d/radiusd.conf" ]] && { RAD="$d"; break; }
done
BIN="$(command -v freeradius || command -v radiusd || true)"
[[ -z "$BIN" && -x /usr/sbin/freeradius ]] && BIN=/usr/sbin/freeradius
SITE=""; INNER=""; POLICY=""; POLICY_SRC="$BACKEND_DIR/scripts/radius-tenancy.policy"; RUSER=freerad; RGROUP=freerad
if [[ -n "$RAD" ]]; then
  [[ -e "$RAD/sites-enabled/default" ]] && SITE="$(readlink -f "$RAD/sites-enabled/default")"
  [[ -e "$RAD/sites-enabled/inner-tunnel" ]] && INNER="$(readlink -f "$RAD/sites-enabled/inner-tunnel")"
  POLICY="$RAD/policy.d/jointbox-tenancy"
  RUSER="$(awk '/^[[:space:]]*user[[:space:]]*=/{print $3; exit}' "$RAD/radiusd.conf" 2>/dev/null)"; RUSER="${RUSER:-freerad}"
  RGROUP="$(stat -c %G "$RAD")"
fi
EDITOR_JS="$BACKEND_DIR/dist/nas/radius-tenancy-site.js"
# site check <file>                      -> "<authorize 0|1> <accounting 0|1>"
# site add <file> <authorize[,accounting]> / site remove <file>  (edit in place)
site() {
  node -e '
    const fs = require("fs"); const m = require(process.argv[1]);
    const [op, f, secs] = process.argv.slice(2); const text = fs.readFileSync(f, "utf8");
    if (op === "check") { const h = m.tenancyHooks(text); console.log(`${h.authorize ? 1 : 0} ${h.accounting ? 1 : 0}`); process.exit(0); }
    const r = op === "add" ? m.addTenancyHooks(text, (secs || "authorize,accounting").split(",")) : m.removeTenancyHooks(text);
    if (r.problem) { console.error(r.problem); process.exit(2); }
    if (r.changed) fs.writeFileSync(f, r.text);
    console.log(`${r.hooks.authorize ? 1 : 0} ${r.hooks.accounting ? 1 : 0}`);
  ' "$EDITOR_JS" "$@"
}
installed() { # 0 when the policy file and every hook are in place
  [[ -n "$SITE" && -f "$SITE" && -f "$POLICY" && -f "$EDITOR_JS" ]] || return 1
  [[ "$(site check "$SITE" 2>/dev/null)" == "1 1" ]] || return 1
  [[ -z "$INNER" ]] || [[ "$(site check "$INNER" 2>/dev/null)" == 1* ]]
}
running() {
  for _ in $(seq 1 12); do
    if command -v systemctl >/dev/null 2>&1; then systemctl is-active --quiet freeradius && return 0
    else pgrep -x freeradius >/dev/null 2>&1 && return 0; fi
    sleep 1
  done
  return 1
}
# FreeRADIUS reads its configuration at start: the policy is in effect only if
# it started after the site files and the policy were last written.
loaded() {
  local pid etimes started mtime
  pid="$( (systemctl show -p MainPID --value freeradius 2>/dev/null) | grep -E '^[1-9][0-9]*$' || pgrep -o -u "$RUSER" -x freeradius)"
  [[ -n "$pid" ]] || return 1
  etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"; [[ -n "$etimes" ]] || return 1
  started=$(( $(date +%s) - etimes ))
  mtime="$(stat -c %Y "$SITE" ${INNER:+"$INNER"} "$POLICY" 2>/dev/null | sort -n | tail -1)"
  (( started + 2 >= ${mtime:-0} ))
}
# Enabled virtual servers OTHER than default / inner-tunnel that process
# logins or accounting (their own listen sections, or a detail-file reader
# such as buffered-sql): the policy is not in them.
other_sites() {
  local f n body
  [[ -n "$RAD" && -d "$RAD/sites-enabled" ]] || return 0
  for f in "$RAD"/sites-enabled/*; do
    [[ -e "$f" ]] || continue
    n="$(basename "$f")"; [[ "$n" == "default" || "$n" == "inner-tunnel" ]] && continue
    body="$(grep -vE '^[[:space:]]*#' "$(readlink -f "$f")" 2>/dev/null)"
    if grep -qE '^[[:space:]]*(authorize|accounting)[[:space:]]*\{|^[[:space:]]*type[[:space:]]*=[[:space:]]*(auth|acct|auth\+acct|detail)([[:space:]]|$)' <<<"$body"; then
      echo "$n"
    fi
  done
}
# Can FreeRADIUS's OWN database account (the sql module's login) execute the
# functions the policy calls? If not, every request would be refused.
FRDB_PROBLEM=""
fr_db_check() {
  local sqlmod host port user db out
  FRDB_PROBLEM=""
  [[ -e "$RAD/mods-enabled/sql" ]] || { FRDB_PROBLEM="FreeRADIUS has no sql module enabled"; return 1; }
  sqlmod="$(readlink -f "$RAD/mods-enabled/sql")"
  val() { sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*$/\1/p" "$sqlmod" | head -1; }
  host="$(val server)"; port="$(val port)"; user="$(val login)"; db="$(val radius_db)"
  out="$(PGPASSWORD="$(val password)" psql -X -q -A -t -h "${host:-localhost}" -p "${port:-5432}" -U "$user" -d "$db" \
         -c "SELECT has_function_privilege('$FN_AUTH', 'EXECUTE') AND has_function_privilege('$FN_ONOFF', 'EXECUTE')" 2>&1 | head -1)"
  if [[ "$out" != "t" ]]; then
    FRDB_PROBLEM="FreeRADIUS's database account ($user@$db) cannot execute the tenancy functions (${out:0:120})"
    return 1
  fi
  return 0
}

# ── report ────────────────────────────────────────────────────────────────────
# One row of numbers; the same numbers decide whether --enforce may proceed.
#  1 would-be refusals of real subscribers recorded in the last 7 days
#  2 online sessions whose next login would be refused
#  3 active routers sharing one address (ambiguous)
#  4 subscribers in no company that were online / logged in in the last 30 days
#  5 subscribers in no company, no recent activity
#  6 active routers with no owner / owned outside any company
#  7 subscribers assigned (Subscriber.nasId) to a router the policy refuses them on
#  8 radcheck usernames with no subscriber
#  9 online sessions whose router cannot be predicted (address matches no router: NAT)
# 10 harmless records in the last 7 days (unknown usernames, unknown sources)
# 11 closed sessions in the last 30 days that enforce would have refused (history)
# 12 shares across companies that count / 13 that do not count
SUMMARY_SQL=$(cat <<'SQL'
WITH online AS (
  SELECT public.jointbox_radius_authz(a.username, host(a.nasipaddress)) AS d
    FROM radacct a WHERE a.acctstoptime IS NULL AND a.acctstarttime > now() - interval '7 days'),
orphans AS (
  SELECT s.username,
         (EXISTS (SELECT 1 FROM radacct a WHERE a.username = s.username AND a.acctstoptime IS NULL)
          OR EXISTS (SELECT 1 FROM radpostauth p WHERE p.username = s.username AND p.reply = 'Access-Accept'
                                                   AND p.authdate > now() - interval '30 days')) AS active
    FROM "Subscriber" s WHERE public.jointbox_company_root(s."userId") IS NULL),
hist AS (
  SELECT public.jointbox_radius_authz(x.username, host(x.nasipaddress)) AS d
    FROM (SELECT DISTINCT a.username, a.nasipaddress FROM radacct a
           WHERE a.acctstoptime IS NOT NULL AND a.acctstarttime > now() - interval '30 days') x),
shares AS (
  SELECT public.jointbox_radius_share_authorised(a."assignedById", public.jointbox_company_root(n."ownerId")) AS ok
    FROM "NasAssignment" a JOIN nas n ON n.id = a."nasId"
   WHERE public.jointbox_company_root(a."userId") IS DISTINCT FROM public.jointbox_company_root(n."ownerId"))
SELECT concat_ws(' ',
  (SELECT coalesce(sum(count), 0) FROM radius_tenancy_event WHERE last_at > now() - interval '7 days'
      AND kind IN ('auth', 'acct', 'acct-onoff') AND reason NOT IN ('subscriber-unknown', 'nas-unknown')),
  (SELECT count(*) FROM online WHERE d NOT IN ('allow', 'nas-unknown', 'subscriber-unknown')),
  (SELECT count(*) FROM (SELECT 1 FROM nas WHERE "isActive" AND "nasIp" IS NOT NULL GROUP BY host("nasIp") HAVING count(*) > 1) x),
  (SELECT count(*) FROM orphans WHERE active),
  (SELECT count(*) FROM orphans WHERE NOT active),
  (SELECT count(*) FROM nas WHERE "isActive" AND "nasIp" IS NOT NULL AND public.jointbox_company_root("ownerId") IS NULL),
  (SELECT count(*) FROM "Subscriber" s JOIN nas n ON n.id = s."nasId"
     WHERE n."nasIp" IS NOT NULL AND public.jointbox_radius_authz(s.username, host(n."nasIp")) <> 'allow'),
  (SELECT count(DISTINCT r.username) FROM radcheck r LEFT JOIN "Subscriber" s ON s.username = r.username WHERE s.id IS NULL),
  (SELECT count(*) FROM online WHERE d = 'nas-unknown'),
  (SELECT coalesce(sum(count), 0) FROM radius_tenancy_event WHERE last_at > now() - interval '7 days'
      AND reason IN ('subscriber-unknown', 'nas-unknown')),
  (SELECT count(*) FROM hist WHERE d NOT IN ('allow', 'nas-unknown', 'subscriber-unknown')),
  (SELECT count(*) FROM shares WHERE ok),
  (SELECT count(*) FROM shares WHERE NOT ok))
SQL
)
summary() { # sets S1..S13 and BLOCKING
  local row; row="$(sqlq "$SUMMARY_SQL")" || return 1
  read -r S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11 S12 S13 <<<"$row"
  [[ -n "${S13:-}" ]] || return 1
  BLOCKING=$(( S1 + S2 + S3 + S4 ))
}
print_summary() {
  echo
  echo "== Summary =="
  echo "  BLOCKS ENFORCEMENT (real subscribers would be refused):"
  echo "    $S1  would-be refusals recorded in the last 7 days (kind auth/acct/acct-onoff)"
  echo "    $S2  online sessions whose next login would be refused"
  echo "    $S3  addresses used by more than one ACTIVE router (ambiguous: refused)"
  echo "    $S4  subscribers in no company that were online or logged in within 30 days"
  echo "  FIX BEFORE OR SOON AFTER ENFORCING (refused at their next login; no recent activity):"
  echo "    $S5  subscribers in no company (no owner, deleted owner, platform-owned, parent loop)"
  echo "    $S6  active routers with no owner or owned outside any company"
  echo "    $S7  subscribers whose assigned router the policy refuses them on (no CoA / disconnect there)"
  echo "    $S8  RADIUS usernames (radcheck) with no subscriber"
  echo "  INFORMATIONAL (no action needed to enforce):"
  echo "    $S9  online sessions behind NAT (reported address matches no router; judged by real source at login)"
  echo "    $S10  harmless records in 7 days (unknown usernames, requests from non-router clients such as a local radtest)"
  echo "    $S11  closed sessions in 30 days that enforce would have refused (history; still visible in logs)"
  echo "    $S12  cross-company shares that count, $S13 that do NOT count (listed below)"
  if (( BLOCKING == 0 )); then echo "  VERDICT: nothing recorded or online would be refused."
  else echo "  VERDICT: $BLOCKING finding(s) above would refuse real subscribers — fix them before --enforce."; fi
}
report() {
  say "mode: $MODE   (off | monitor = count, never refuse | enforce = refuse)"
  summary || { warn "the summary could not be computed"; return 1; }
  print_summary
  sqlp <<'SQL'
\echo
\echo '== Companies (top account below the platform) =='
WITH nas_c AS (SELECT n.id, n."isActive", public.jointbox_company_root(n."ownerId") AS company FROM nas n),
     sub_c AS (SELECT public.jointbox_company_root(s."userId") AS company FROM "Subscriber" s)
SELECT c.company AS "company", u.name AS "name",
       (SELECT count(*) FROM nas_c WHERE nas_c.company = c.company AND nas_c."isActive") AS "active routers",
       (SELECT count(*) FROM sub_c WHERE sub_c.company = c.company) AS "subscribers"
  FROM (SELECT company FROM nas_c UNION SELECT company FROM sub_c) c
  JOIN "User" u ON u.id = c.company
 ORDER BY 1;

\echo
\echo '== Routers =='
SELECT n.id AS "router", host(n."nasIp") AS "address", n."isActive" AS "active",
       n."ownerId" AS "owner", public.jointbox_company_root(n."ownerId") AS "company",
       concat_ws(', ',
         CASE WHEN n."nasIp" IS NULL THEN 'NO ADDRESS (not a RADIUS client)' END,
         CASE WHEN n."ownerId" IS NULL THEN 'NO OWNER' END,
         CASE WHEN n."ownerId" IS NOT NULL AND public.jointbox_company_root(n."ownerId") IS NULL THEN 'OWNER IN NO COMPANY (platform account / broken chain)' END,
         CASE WHEN n."isActive" AND n."nasIp" IS NOT NULL AND (SELECT count(*) FROM nas o WHERE o."isActive" AND o."nasIp" IS NOT NULL AND host(o."nasIp") = host(n."nasIp")) > 1 THEN 'SAME ADDRESS AS ANOTHER ACTIVE ROUTER' END
       ) AS "problems"
  FROM nas n ORDER BY n.id;

\echo
\echo '== Shares across companies (NasAssignment) — only these let another company''s subscribers in =='
SELECT a."nasId" AS "router", public.jointbox_company_root(n."ownerId") AS "router company",
       a."userId" AS "shared to", public.jointbox_company_root(a."userId") AS "their company",
       a.propagate, a."assignedById" AS "shared by",
       CASE WHEN public.jointbox_radius_share_authorised(a."assignedById", public.jointbox_company_root(n."ownerId"))
            THEN 'counts' ELSE 'DOES NOT COUNT (no author, or author outside the router''s company)' END AS "policy"
  FROM "NasAssignment" a JOIN nas n ON n.id = a."nasId"
 WHERE public.jointbox_company_root(a."userId") IS DISTINCT FROM public.jointbox_company_root(n."ownerId")
 ORDER BY 1, 3;

\echo
\echo '== Subscribers in no company (ids; give them an owner inside a company) =='
SELECT CASE WHEN s."userId" IS NULL THEN 'no owner'
            WHEN NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = s."userId") THEN 'owner account missing'
            ELSE 'owner in no company (platform account / parent loop)' END AS "problem",
       count(*) AS "subscribers",
       (array_agg(s.id ORDER BY s.id))[1:20] AS "first ids"
  FROM "Subscriber" s
 WHERE public.jointbox_company_root(s."userId") IS NULL
 GROUP BY 1 ORDER BY 1;

\echo
\echo '== Subscribers whose assigned router (Subscriber.nasId) the policy refuses them on =='
\echo '   (enforced: the panel sends no CoA / disconnect / router-API call through it; their login depends on the router they dial)'
SELECT x.decision AS "decision", count(*) AS "subscribers", (array_agg(x.id ORDER BY x.id))[1:20] AS "first ids"
  FROM (SELECT s.id, public.jointbox_radius_authz(s.username, host(n."nasIp")) AS decision
          FROM "Subscriber" s JOIN nas n ON n.id = s."nasId" WHERE n."nasIp" IS NOT NULL) x
 WHERE x.decision <> 'allow'
 GROUP BY 1 ORDER BY 1;

\echo
\echo '== Accounts whose parent chain loops (no company can be determined) =='
WITH RECURSIVE walk(start, id, depth, path, cyc) AS (
  SELECT u.id, u."parentId", 1, ARRAY[u.id], false FROM "User" u WHERE u."parentId" IS NOT NULL
  UNION ALL
  SELECT w.start, p."parentId", w.depth + 1, w.path || p.id, p.id = ANY(w.path)
    FROM walk w JOIN "User" p ON p.id = w.id
   WHERE NOT w.cyc AND w.depth < 70 AND p."parentId" IS NOT NULL)
SELECT DISTINCT start AS "account" FROM walk WHERE cyc ORDER BY 1;

\echo
\echo '== Online now: what enforce would do at their NEXT login (by the router address they report) =='
SELECT public.jointbox_radius_authz(a.username, host(a.nasipaddress)) AS "decision", count(*) AS "sessions",
       count(DISTINCT a.nasipaddress) AS "routers"
  FROM radacct a WHERE a.acctstoptime IS NULL AND a.acctstarttime > now() - interval '7 days'
 GROUP BY 1 ORDER BY 1;

\echo
\echo '== Recorded by the policy, last 7 days (monitor: would have refused; enforce: refused) =='
SELECT e.kind, e.reason, e.mode, sum(e.count) AS "requests",
       count(DISTINCT nullif(e.username, '')) AS "subscribers", count(DISTINCT e.nas_ip) AS "routers",
       max(e.last_at) AS "last seen"
  FROM radius_tenancy_event e WHERE e.last_at > now() - interval '7 days'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SQL
}

set_mode() { # set_mode <mode> <extra metadata json fields>
  local m="$1" extra="${2:-}" who="${SUDO_USER:-root}" before="$MODE"
  sqlq "INSERT INTO radius_tenancy_setting (id, mode, updated_at, updated_by)
        VALUES (1, '$m', now(), 'radius-tenancy.sh ($who)')
        ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by" >/dev/null \
    || { warn "could not change the mode"; exit 1; }
  MODE="$(sqlq "SELECT public.jointbox_radius_tenancy_mode()")"
  [[ "$MODE" == "$m" ]] || { warn "the mode reads back as '$MODE', not '$m'"; exit 1; }
  local lvl=INFO; [[ "$m" != "monitor" ]] && lvl=WARN
  audit "$lvl" "RADIUS tenancy mode $before -> $m by $who on $(hostname)" "{\"from\":\"$before\",\"to\":\"$m\",\"by\":\"$who\"${extra}}"
  say "mode is now: $MODE (in effect for the next request; no restart needed)"
}

confirm_force() {
  echo
  warn "--force: enforcement will REFUSE the logins and accounting counted above (BLOCKING=$BLOCKING)."
  warn "Subscribers on those routers lose service at their next login / reconnect; their"
  warn "accounting stops being recorded. Rollback is instant: $0 --monitor"
  if [[ -t 0 ]]; then
    local ans; read -r -p "[radius-tenancy] Type ENFORCE to continue: " ans
    [[ "$ans" == "ENFORCE" ]] && return 0
  elif [[ "${JOINTBOX_TENANCY_CONFIRM:-}" == "ENFORCE" ]]; then
    return 0
  fi
  warn "not confirmed — nothing changed. (Without a terminal, set JOINTBOX_TENANCY_CONFIRM=ENFORCE.)"
  return 1
}

case "$ACTION" in
  --report) report; exit $? ;;
  --status)
    say "mode: $MODE   (set $(sqlq "SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI') || ' by ' || coalesce(updated_by, '?') FROM radius_tenancy_setting WHERE id = 1"))"
    if [[ -z "$RAD" ]]; then say "FreeRADIUS is not installed on this server: the mode applies to the panel's CoA / disconnect only."
    elif [[ ! -f "$EDITOR_JS" ]]; then warn "the backend is not built (dist/ missing): cannot inspect the site files"
    elif installed; then
      if running && loaded; then say "FreeRADIUS: policy installed and loaded (default${INNER:+ + inner-tunnel})"
      elif running; then warn "FreeRADIUS: policy installed but FreeRADIUS has not restarted since — not in effect yet"
      else warn "FreeRADIUS: NOT running"; fi
      cmp -s "$POLICY_SRC" "$POLICY" || warn "policy.d/jointbox-tenancy differs from this version — run --install to refresh it"
    else say "FreeRADIUS: policy NOT installed (run --install)"; fi
    if [[ -n "$RAD" ]]; then
      fr_db_check && say "FreeRADIUS database account: can execute the policy" || warn "$FRDB_PROBLEM — every request is refused while this lasts"
      o="$(other_sites | tr '\n' ' ')"; [[ -n "$o" ]] && warn "other enabled virtual servers handle RADIUS and are NOT covered: $o"
    fi
    sqlp -c "SELECT kind, reason, mode, sum(count) AS requests, count(DISTINCT nullif(username, '')) AS subscribers,
                    count(DISTINCT nas_ip) AS routers, max(last_at) AS last_seen
               FROM radius_tenancy_event WHERE last_at > now() - interval '24 hours' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"
    exit 0 ;;
  --monitor) set_mode monitor; exit 0 ;;
  --off) set_mode off; exit 0 ;;
  --enforce)
    if [[ -n "$RAD" ]]; then
      # Fixed preconditions (--force does not override): enforcing a policy
      # FreeRADIUS does not run protects nothing, and one FreeRADIUS cannot
      # execute refuses everybody.
      if ! installed; then warn "the policy is not installed in FreeRADIUS — run --install (monitor mode) first and watch --status."; exit 6; fi
      if ! running || ! loaded; then warn "FreeRADIUS is not running with the installed policy — run --install (or restart FreeRADIUS) first."; exit 6; fi
      if ! fr_db_check; then warn "$FRDB_PROBLEM"; exit 6; fi
    fi
    summary || { warn "the impact could not be computed — nothing changed"; exit 6; }
    if (( BLOCKING > 0 )); then
      report
      if [[ $FORCE -ne 1 ]]; then
        warn "$BLOCKING finding(s) would refuse real subscribers (BLOCKS ENFORCEMENT above)."
        warn "fix them, or re-run with --enforce --force once you have reviewed them."
        exit 6
      fi
      confirm_force || exit 6
    fi
    set_mode enforce ",\"forced\":$( [[ $FORCE -eq 1 && $BLOCKING -gt 0 ]] && echo true || echo false ),\"blocking\":$BLOCKING"
    say "rollback at any time: $0 --monitor"
    exit 0 ;;
esac

# ── --install / --uninstall: edit FreeRADIUS ──────────────────────────────────
if [[ -z "$RAD" || -z "$BIN" ]]; then say "FreeRADIUS is not installed on this server — nothing to do."; exit 0; fi
if [[ ! -f "$EDITOR_JS" ]]; then warn "the backend is not built yet (dist/ missing) — run this after the build."; exit 1; fi
if [[ -z "$SITE" || ! -f "$SITE" ]]; then warn "$RAD/sites-enabled/default not found"; exit 2; fi
[[ "$ACTION" == "--install" && ! -f "$POLICY_SRC" ]] && { warn "$POLICY_SRC missing"; exit 1; }

if [[ "$ACTION" == "--install" ]]; then
  if ! fr_db_check; then warn "$FRDB_PROBLEM — nothing changed."; exit 2; fi
  OTHERS="$(other_sites | tr '\n' ' ')"
  if [[ -n "$OTHERS" ]]; then
    warn "these enabled virtual servers also process logins or accounting and will NOT be covered: $OTHERS"
    if [[ $FORCE -ne 1 ]]; then warn "review them (docs/RADIUS_TENANCY.md), then re-run with --install --force — nothing changed."; exit 2; fi
  fi
fi

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
  if [[ -z "$held" ]] && (( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) < 5 )); then sleep 0.5; continue; fi
  if [[ ! "$lpid" =~ ^[0-9]+$ || ! "$lat" =~ ^[0-9]+$ ]] || ! kill -0 "$lpid" 2>/dev/null || (( $(now_ms) - lat > 600000 )); then
    [[ "$(cat "$LOCK" 2>/dev/null)" == "$held" ]] && rm -f "$LOCK"
    continue
  fi
  sleep 0.5
done
if [[ $got_lock -ne 1 ]]; then warn "another FreeRADIUS update is still running (lock $LOCK) — try again in a minute."; exit 5; fi
STAGE=""
trap 'rm -f "$LOCK"; [[ -n "$STAGE" ]] && rm -rf "$STAGE"' EXIT

# Own folder: the router-vault script keeps only its newest 30 folders directly
# under /var/backups/jointbox-radius, and must never lose its pre-vault backup
# to these.
BK="/var/backups/jointbox-radius/tenancy/$(date +%Y%m%d-%H%M%S)-$$-${ACTION#--}"
mkdir -p "$BK" && chmod 700 /var/backups/jointbox-radius /var/backups/jointbox-radius/tenancy "$BK"
ls -1d /var/backups/jointbox-radius/tenancy/2*/ 2>/dev/null | sort | head -n -30 | while read -r old; do rm -rf "${old%/}"; done
cp -a "$SITE" "$BK/site"
[[ -n "$INNER" ]] && cp -a "$INNER" "$BK/inner-tunnel"
[[ -f "$POLICY" ]] && cp -a "$POLICY" "$BK/policy"
RELSITE="${SITE#"$RAD"/}"; RELINNER="${INNER#"$RAD"/}"

check() { # check <config dir>: FreeRADIUS's own check, as the FreeRADIUS user
  local rc
  if command -v runuser >/dev/null 2>&1; then runuser -u "$RUSER" -- "$BIN" -d "$1" -XC >"$BK/check.log" 2>&1; rc=$?
  else "$BIN" -d "$1" -XC >"$BK/check.log" 2>&1; rc=$?; fi
  sed -i -E 's/(secret[[:space:]]*=).*/\1 <hidden>/I; s/(password[[:space:]]*=).*/\1 <hidden>/I' "$BK/check.log"
  [[ $rc -eq 0 ]] || return 1
  if [[ "$ACTION" == "--install" ]]; then
    grep -q "policy.d/jointbox-tenancy" "$BK/check.log" || { echo "policy file not loaded" >>"$BK/check.log"; return 1; }
  fi
  return 0
}
show_check() { grep -iE '\.conf\[[0-9]+\]|jointbox|error|failed|unknown|invalid|expect|missing' "$BK/check.log" | grep -v 'Configuration appears to be OK' | tail -n 8 >&2; }
restore() {
  warn "restoring the previous FreeRADIUS configuration from $BK"
  cp -a "$BK/site" "$SITE"
  [[ -n "$INNER" && -f "$BK/inner-tunnel" ]] && cp -a "$BK/inner-tunnel" "$INNER"
  if [[ -f "$BK/policy" ]]; then cp -a "$BK/policy" "$POLICY"; else rm -f "$POLICY"; fi
}
apply() { # apply <config dir> <default site file> <inner-tunnel file or "">
  if [[ "$ACTION" == "--install" ]]; then
    cp -f "$POLICY_SRC" "$1/policy.d/jointbox-tenancy"
    chown "root:$RGROUP" "$1/policy.d/jointbox-tenancy"; chmod 0640 "$1/policy.d/jointbox-tenancy"
    site add "$2" authorize,accounting >/dev/null || return 1
    if [[ -n "$3" ]]; then site add "$3" authorize >/dev/null || return 1; fi
  else
    site remove "$2" >/dev/null || return 1
    if [[ -n "$3" ]]; then site remove "$3" >/dev/null || return 1; fi
    rm -f "$1/policy.d/jointbox-tenancy"
  fi
}

# 1. stage: the whole configuration, changed, validated as the FreeRADIUS user
STAGE="$(mktemp -d /run/jointbox-radius-stage.XXXXXX 2>/dev/null || mktemp -d)"
chmod 0750 "$STAGE"; chgrp "$RGROUP" "$STAGE"
cp -a "$RAD/." "$STAGE/"
# the staged sites must be files of their own, not links back into the live tree
rm -f "$STAGE/sites-enabled/default"; cp -a "$SITE" "$STAGE/sites-enabled/default"
SINNER=""
if [[ -n "$INNER" ]]; then rm -f "$STAGE/sites-enabled/inner-tunnel"; cp -a "$INNER" "$STAGE/sites-enabled/inner-tunnel"; SINNER="$STAGE/sites-enabled/inner-tunnel"; fi
if ! apply "$STAGE" "$STAGE/sites-enabled/default" "$SINNER"; then
  warn "the site files could not be changed (see the message above) — nothing changed."; exit 2
fi
if ! check "$STAGE"; then
  warn "FreeRADIUS rejects the staged configuration — nothing live was changed:"; show_check; exit 3
fi
same_sites=0
cmp -s "$STAGE/sites-enabled/default" "$SITE" && { [[ -z "$INNER" ]] || cmp -s "$SINNER" "$INNER"; } && same_sites=1
if [[ $same_sites -eq 1 ]] && { [[ "$ACTION" == "--install" ]] && cmp -s "$POLICY_SRC" "$POLICY" || [[ "$ACTION" == "--uninstall" && ! -f "$POLICY" ]]; }; then
  if running && { [[ "$ACTION" == "--uninstall" ]] || loaded; }; then
    say "already $( [[ "$ACTION" == "--install" ]] && echo installed || echo removed ); FreeRADIUS is running with it. mode: $MODE"
    rm -rf "$BK"; exit 0
  fi
fi

# 2. live
apply "$RAD" "$SITE" "$INNER" || { restore; warn "could not change the live site files"; exit 2; }
if ! check "$RAD"; then
  warn "FreeRADIUS rejects the new configuration:"; show_check; restore; exit 3
fi
if command -v systemctl >/dev/null 2>&1; then systemctl restart freeradius; else service freeradius restart; fi
if ! running || { [[ "$ACTION" == "--install" ]] && ! loaded; }; then
  warn "FreeRADIUS did not come back with the new configuration."
  restore
  if command -v systemctl >/dev/null 2>&1; then systemctl restart freeradius; else service freeradius restart; fi
  running && say "previous configuration restored; FreeRADIUS is running." || warn "FreeRADIUS is NOT running — see: journalctl -u freeradius -n 50"
  exit 4
fi

if [[ "$ACTION" == "--install" ]]; then
  audit INFO "RADIUS tenancy policy installed in FreeRADIUS by ${SUDO_USER:-root} on $(hostname) (mode $MODE)" "{\"action\":\"install\",\"mode\":\"$MODE\"}"
  say "installed: $RELSITE (authorize + accounting)${INNER:+, $RELINNER (authorize)} and policy.d/jointbox-tenancy; FreeRADIUS restarted. Backup: $BK"
  say "mode: $MODE"
  case "$MODE" in
    monitor) say "nothing is refused yet. Watch: $0 --status   then: $0 --report and $0 --enforce" ;;
    off)     say "the check is switched off. Next: $0 --monitor" ;;
    enforce) say "refusing what the policy does not allow. Rollback (instant): $0 --monitor" ;;
  esac
else
  audit WARN "RADIUS tenancy policy removed from FreeRADIUS by ${SUDO_USER:-root} on $(hostname)" "{\"action\":\"uninstall\",\"mode\":\"$MODE\"}"
  say "removed from $RELSITE${INNER:+ and $RELINNER} and policy.d; FreeRADIUS restarted. Backup: $BK"
fi
exit 0
