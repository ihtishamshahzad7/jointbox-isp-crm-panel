#!/bin/bash
# =============================================================================
# ensure-radius-accounting.sh — guarantee FreeRADIUS WRITES accounting to
# radacct, on every deploy, on every client.
#
# WHY THIS EXISTS
# Authentication and accounting are two separate flows. Auth (radcheck, port
# 1812) can work perfectly while accounting (radacct, port 1813) writes
# nothing — and the panel reads presence from radacct, so every user shows
# offline even while connected. This was configured once in install.sh, but
# `update-jointbox.sh` never re-asserted it, so any config drift or a
# FreeRADIUS package update that reset sites-enabled/default silently broke
# accounting on that client with nothing to repair it. This script makes the
# repair idempotent and part of every update.
#
# It is conservative: it only ADDS what is missing, validates the whole config
# with `freeradius -XC` before touching the running service, and restores its
# backup if validation fails. A healthy box is left byte-for-byte unchanged.
# =============================================================================
set -u

RAD=/etc/freeradius/3.0
SITE="$RAD/sites-enabled/default"
CHANGED=0

[ -d "$RAD" ] || { echo "   (FreeRADIUS not installed — skipping)"; exit 0; }
[ -f "$SITE" ] || { echo "   ⚠ $SITE missing — run install.sh"; exit 0; }

backup="$SITE.bak.$(date +%s)"
cp -a "$SITE" "$backup"

# ── 1. The sql module must be enabled ────────────────────────────────────────
if [ -e "$RAD/mods-available/sql" ] && [ ! -e "$RAD/mods-enabled/sql" ]; then
  ln -sf ../mods-available/sql "$RAD/mods-enabled/sql"
  echo "   • enabled the sql module"; CHANGED=1
fi

# ── 2. sql must be ACTIVE in the accounting {} section ───────────────────────
# This is the line that actually writes radacct. In a healthy config it is
# already there (as `sql` or `-sql`); we only act when the accounting block has
# neither. awk walks brace depth so we edit the RIGHT block, not a mention of
# "sql" somewhere else in the file.
if ! awk '
  /(^|[^a-zA-Z_])accounting[[:space:]]*\{/ { inacct=1 }
  inacct && /\{/ { depth++ }
  inacct && /\}/ { depth--; if (depth<=0) inacct=0 }
  inacct && /^[[:space:]]*-?sql([[:space:]]|$)/ { found=1 }
  END { exit(found?0:1) }
' "$SITE"; then
  # Insert `sql` as the first statement inside accounting { }.
  awk '
    !done && /(^|[^a-zA-Z_])accounting[[:space:]]*\{/ {
      print; print "\tsql"; done=1; next
    }
    { print }
  ' "$SITE" > "$SITE.tmp" && mv "$SITE.tmp" "$SITE"
  echo "   • added sql to the accounting section (was missing — this is the fix)"
  CHANGED=1
fi

# ── 3. sql should also be in post-auth (records radpostauth) ─────────────────
if ! awk '
  /(^|[^a-zA-Z_])post-auth[[:space:]]*\{/ { inpa=1 }
  inpa && /\{/ { depth++ }
  inpa && /\}/ { depth--; if (depth<=0) inpa=0 }
  inpa && /^[[:space:]]*-?sql([[:space:]]|$)/ { found=1 }
  END { exit(found?0:1) }
' "$SITE"; then
  awk '
    !done && /(^|[^a-zA-Z_])post-auth[[:space:]]*\{/ {
      print; print "\tsql"; done=1; next
    }
    { print }
  ' "$SITE" > "$SITE.tmp" && mv "$SITE.tmp" "$SITE"
  echo "   • added sql to the post-auth section"
  CHANGED=1
fi

if [ "$CHANGED" -eq 0 ]; then
  rm -f "$backup"
  echo "   ✓ accounting already configured correctly — no change"
  exit 0
fi

# ── 4. Validate before we let the service near it ────────────────────────────
chown -R freerad:freerad "$RAD" 2>/dev/null || true
if freeradius -XC >/dev/null 2>&1 || radiusd -XC >/dev/null 2>&1; then
  rm -f "$backup"
  echo "   ✓ config valid — accounting repair applied"
else
  mv "$backup" "$SITE"
  echo "   ✗ config check FAILED after edit — reverted, nothing changed."
  echo "     Run 'freeradius -XC' by hand to see the error."
  exit 1
fi
