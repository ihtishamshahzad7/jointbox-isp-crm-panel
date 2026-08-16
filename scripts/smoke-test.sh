#!/usr/bin/env bash
#
# Jointbox production smoke test — verifies the full stack after a deploy:
#   frontend → backend → PostgreSQL → FreeRADIUS → MikroTik.
#
# It is READ-ONLY (only SELECTs + service status checks) — it never changes data.
# Run it ON THE SERVER after `bash update-jointbox.sh`.
#
#   Usage:  bash scripts/smoke-test.sh <subscriber_username>
#   e.g.    bash scripts/smoke-test.sh b
#
# What it checks, in order:
#   1. The NEW backend build is actually live (BUILD MARKER).
#   2. Database migrations are applied (no failed/pending).
#   3. FreeRADIUS is running and its config is valid.
#   4. The subscriber exists in RADIUS (radcheck + radreply).
#   5. Their money is consistent (latest invoice + wallet debit + expiry).
#   6. Their live/last RADIUS session + termination cause.
#   7. Duplicate-session and stale-session health.
#
# Anything it can't check automatically (the MikroTik itself) is listed at the
# end as a short manual checklist.

set -uo pipefail
USER_ARG="${1:-}"
REPO="${REPO:-/opt/jointbox}"
BACKEND="$REPO/backend"
PM2_APP="${PM2_APP:-jointbox-backend}"

c_g(){ printf '\033[0;32m%s\033[0m\n' "$*"; }
c_r(){ printf '\033[0;31m%s\033[0m\n' "$*"; }
c_y(){ printf '\033[0;33m%s\033[0m\n' "$*"; }
hdr(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

# ── Load DB connection from the backend .env ─────────────────────────────────
if [ -f "$BACKEND/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
PSQL(){ psql "${DATABASE_URL:-}" -Atqc "$1" 2>/dev/null; }

if ! command -v psql >/dev/null 2>&1; then c_r "psql not found — install postgresql-client to run DB checks."; fi
if [ -z "${DATABASE_URL:-}" ]; then c_y "DATABASE_URL not found in $BACKEND/.env — DB checks will be skipped."; fi

# ── 1. Is the new build live? ────────────────────────────────────────────────
hdr "1. Backend build is live"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 logs "$PM2_APP" --lines 300 --nostream 2>/dev/null | grep -q "BUILD MARKER"; then
    pm2 logs "$PM2_APP" --lines 300 --nostream 2>/dev/null | grep "BUILD MARKER" | tail -1
    c_g "OK — BUILD MARKER found, the new code is running."
  else
    c_r "NOT FOUND — the deploy may have failed and pm2 is serving the OLD build."
    c_y "  Check: cd $REPO && bash update-jointbox.sh   (look for a red migration/build error)"
  fi
else
  c_y "pm2 not found — skipping (check your process manager manually)."
fi

# ── 2. Migrations ────────────────────────────────────────────────────────────
hdr "2. Database migrations"
if [ -n "${DATABASE_URL:-}" ]; then
  FAILED="$(PSQL "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;")"
  if [ "${FAILED:-0}" = "0" ]; then c_g "OK — no failed/pending migrations."
  else c_r "$FAILED migration(s) not finished — run: cd $BACKEND && npx prisma migrate status"; fi
fi

# ── 3. FreeRADIUS health ─────────────────────────────────────────────────────
hdr "3. FreeRADIUS"
if systemctl is-active --quiet freeradius 2>/dev/null || systemctl is-active --quiet radiusd 2>/dev/null; then
  c_g "OK — FreeRADIUS service is active."
else
  c_r "FreeRADIUS service is NOT active."
fi
if command -v freeradius >/dev/null 2>&1; then
  if freeradius -XC >/dev/null 2>&1; then c_g "OK — freeradius -XC: configuration is valid."
  else c_r "freeradius -XC reports a config error — run it directly to see the line."; fi
fi

# ── Per-subscriber checks (need a username) ──────────────────────────────────
if [ -z "$USER_ARG" ]; then
  c_y "\nNo username given — skipping per-subscriber checks."
  c_y "Re-run with:  bash scripts/smoke-test.sh <username>"
else
  U="$USER_ARG"
  hdr "4. RADIUS credentials for '$U'"
  if [ -n "${DATABASE_URL:-}" ]; then
    RC="$(PSQL "SELECT count(*) FROM radcheck WHERE username='$U';")"
    RR="$(PSQL "SELECT count(*) FROM radreply WHERE username='$U';")"
    echo "  radcheck rows: ${RC:-0}   radreply rows: ${RR:-0}"
    [ "${RC:-0}" -ge 1 ] && c_g "OK — has RADIUS auth credentials." || c_r "MISSING from radcheck — they cannot authenticate. Use 'Sync to RADIUS'."

    hdr "5. Money consistency for '$U'"
    PSQL "SELECT 'expiry='||COALESCE(ss.\"expiryDate\"::text,'(none)')||'  status='||s.status||'  sell='||COALESCE(s.\"sellPrice\"::text,'-')||'  cost='||COALESCE(s.\"costPrice\"::text,'-')
          FROM \"Subscriber\" s LEFT JOIN \"ServiceSettings\" ss ON ss.\"subscriberId\"=s.id WHERE s.username='$U';"
    echo "  Latest invoice:"; PSQL "SELECT '   #'||i.\"invoiceNo\"||'  total='||i.total||'  paid='||i.\"paidAmount\"||'  status='||i.status||'  '||i.\"createdAt\"
          FROM \"Invoice\" i JOIN \"Subscriber\" s ON s.id=i.\"subscriberId\" WHERE s.username='$U' ORDER BY i.id DESC LIMIT 1;"
    echo "  Last wallet moves on the owner (activation should show a DEDUCT):"
    PSQL "SELECT '   '||t.type||'  '||t.amount||'  '||COALESCE(t.notes,'')||'  '||t.\"createdAt\"
          FROM \"UserBalanceTransaction\" t JOIN \"Subscriber\" s ON s.\"userId\"=t.\"userId\"
          WHERE s.username='$U' ORDER BY t.id DESC LIMIT 3;"

    hdr "6. RADIUS session + termination cause for '$U'"
    PSQL "SELECT '   start='||COALESCE(acctstarttime::text,'-')||'  stop='||COALESCE(acctstoptime::text,'OPEN')||'  ip='||COALESCE(framedipaddress::text,'-')||'  cause='||COALESCE(acctterminatecause,'-')
          FROM radacct WHERE username='$U' ORDER BY radacctid DESC LIMIT 3;"

    hdr "7. Session health"
    DUP="$(PSQL "SELECT count(*) FROM radacct WHERE username='$U' AND acctstoptime IS NULL;")"
    [ "${DUP:-0}" -le 1 ] && c_g "OK — ${DUP:-0} open session (no duplicate)." || c_r "$DUP OPEN sessions for '$U' — duplicate login; the sweep should cut them within 2 min."
  fi
fi

# ── Manual (MikroTik) checklist ──────────────────────────────────────────────
hdr "Manual checks (do these on the router / browser)"
cat <<'EOF'
  [ ] Activate a subscriber in the panel → an invoice appears, the owner's
      wallet drops by their cost, and the header balance updates.
  [ ] The subscriber can dial in on the MikroTik and shows ONLINE in the list
      and in Logs → RADIUS Sessions.
  [ ] Deactivate → the live PPPoE session drops on the MikroTik within seconds
      and the radcheck rows are gone (re-run this script to confirm).
  [ ] Dial the same username from 2 devices → within ~2 min both drop and a
      "Simultaneous-Use" entry appears in Logs → System Logs.
  [ ] Act as a reseller → Billing/Invoices/Vouchers/Tickets totals show ONLY
      their own numbers (not the whole ISP's).
EOF
echo
c_g "Smoke test finished."
