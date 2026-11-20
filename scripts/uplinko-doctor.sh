#!/usr/bin/env bash
# Uplinko doctor — one command that explains why the panel is not working.
#
#   sudo bash /opt/jointbox/scripts/uplinko-doctor.sh
#
# Read-only: it changes nothing, and never prints passwords or secrets.
# Every problem it finds is printed with the exact command that fixes it.
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV="$APP_DIR/backend/.env"
G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
PROBLEMS=0
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
bad()  { echo "  ${R}✘${N} $*"; PROBLEMS=$((PROBLEMS+1)); }
fix()  { echo "      ${B}fix:${N} $*"; }
envv() { sed -n "s/^$1=//p" "$ENV" 2>/dev/null | head -1 | tr -d '"'; }

echo "${B}Uplinko doctor${N}  ($APP_DIR)"

echo "${B}1. Configuration${N}"
if [ ! -f "$ENV" ]; then bad "backend/.env is missing"; fix "re-run install.sh"; exit 1; fi
[ -n "$(envv JWT_SECRET)" ] && ok "JWT_SECRET set" || { bad "JWT_SECRET missing — the backend will not start"; fix "re-run install.sh (it keeps existing secrets)"; }
DBURL="$(envv DATABASE_URL)"; [ -n "$DBURL" ] && ok "DATABASE_URL set" || bad "DATABASE_URL missing"
PORT="$(envv PORT)"; PORT="${PORT:-3001}"
BI="$(envv BACKEND_INSTANCES)"; WI="$(envv WORKER_INSTANCES)"
CORES="$(nproc 2>/dev/null || echo 1)"
[ "$BI" = "max" ] && BI="$CORES"
PROCS=$(( ${BI:-1} + ${WI:-0} ))
LIMIT="$(echo "$DBURL" | sed -n 's/.*connection_limit=\([0-9]*\).*/\1/p')"; LIMIT="${LIMIT:-$(( CORES*2+1 ))}"
MAXC="$(envv POSTGRES_MAX_CONNECTIONS)"; MAXC="${MAXC:-100}"
AVAIL=$(( MAXC - 25 ))
if echo "$DBURL" | grep -q 'pgbouncer=true'; then ok "DB pool: behind PgBouncer"
elif [ $(( PROCS * LIMIT )) -le "$AVAIL" ]; then ok "DB pool: $PROCS process(es) × $LIMIT = $(( PROCS*LIMIT )) of ~$AVAIL connections"
else
  SAFE=$(( AVAIL / PROCS ))
  warn "DB pool: $PROCS × $LIMIT = $(( PROCS*LIMIT )) > ~$AVAIL available (the backend lowers it to $SAFE by itself)"
  fix "sed -i 's/connection_limit=[0-9]*/connection_limit=$SAFE/' $ENV && pm2 restart all --update-env"
fi
[ -z "$BI" ] && [ "$CORES" -ge 4 ] && warn "Process counts are not saved in .env — a plain 'pm2 start' runs 1 backend" && \
  fix "echo -e 'BACKEND_INSTANCES=$((CORES-1))\nWORKER_INSTANCES=1\nFRONTEND_INSTANCES=2' >> $ENV"

echo "${B}2. Services${N}"
for svc in postgresql redis-server freeradius; do
  systemctl is-active --quiet "$svc" 2>/dev/null && ok "$svc running" || { bad "$svc is not running"; fix "systemctl restart $svc && systemctl status $svc"; }
done
if command -v pm2 >/dev/null; then
  pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let a=[];try{a=JSON.parse(s)}catch{}
    const by={};for(const p of a){const k=p.name;by[k]=by[k]||{n:0,on:0,r:0};by[k].n++;if(p.pm2_env.status==="online")by[k].on++;by[k].r=Math.max(by[k].r,p.pm2_env.restart_time||0)}
    if(!a.length)console.log("BAD none");for(const[k,v]of Object.entries(by))console.log(`${v.on===v.n?"OK":"BAD"} ${k} ${v.on}/${v.n} online, restarts ${v.r}`)})' |
  while read -r st rest; do
    if [ "$st" = "OK" ]; then ok "pm2 $rest"; else bad "pm2 $rest"; fix "pm2 logs jointbox-backend --lines 60 --nostream --err"; fi
  done
  pm2 jlist 2>/dev/null | grep -q '"name":"jointbox-worker"' || { [ "${WI:-0}" -gt 0 ] && bad "jointbox-worker is not running (router polling / SNMP stop)" && fix "cd $APP_DIR && pm2 start ecosystem.config.js && pm2 save"; }
else bad "pm2 not installed"; fi

echo "${B}3. API${N}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/health")"
if [ "$CODE" = "200" ]; then ok "API healthy on port $PORT"
else
  bad "API not answering on port $PORT (HTTP $CODE) — every sign-in fails as 'invalid email or password' until this is fixed"
  echo "      last errors:"; pm2 logs jointbox-backend --lines 200 --nostream --err 2>/dev/null | grep -E "Error|CRITICAL|refuse|Unsafe" | tail -5 | sed 's/^/        /'
fi

echo "${B}4. Logins${N}"
if [ "$CODE" = "200" ] && [ -f "$APP_DIR/backend/scripts/reset-platform-password.js" ]; then
  (cd "$APP_DIR/backend" && node scripts/reset-platform-password.js 2>&1 | sed -n '2,6p' | sed 's/^/  /')
  echo "      forgot the password? cd $APP_DIR/backend && node scripts/reset-platform-password.js --email <email above>"
fi

echo
if [ "$PROBLEMS" -eq 0 ]; then echo "${G}${B}No problems found.${N}"; else echo "${R}${B}$PROBLEMS problem(s) found — run the fix lines above.${N}"; fi
exit 0
