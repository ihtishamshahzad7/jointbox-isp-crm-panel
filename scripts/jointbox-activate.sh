#!/usr/bin/env bash
#
# Jointbox activation wizard.
#
# Call this from install.sh, and from the OVA's first-boot script. It is safe
# to re-run: if the panel is already activated it says so and exits.
#
# Design notes for whoever maintains this:
#
#  * It must never leave the server unusable. If the customer has no key and no
#    internet, it prints the hardware id and carries on — the panel still
#    installs, and they activate later.
#  * It must never block a non-interactive install. Set JBX_LICENSE_KEY in the
#    environment and it runs unattended.

set -uo pipefail

AGENT="${JBX_AGENT:-/usr/local/bin/jointbox-licensed}"
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'

if [[ ! -x "$AGENT" ]]; then
  echo "${RED}The licence agent is not installed at $AGENT${OFF}" >&2
  exit 1
fi

# Already activated? Nothing to do.
if "$AGENT" -status 2>/dev/null | grep -qE 'State +: (ACTIVE|GRACE)'; then
  echo
  echo "  ${GRN}This panel is already activated.${OFF}"
  "$AGENT" -status
  exit 0
fi

cat <<EOF

  ${BOLD}╔══════════════════════════════════════════════════════════╗${OFF}
  ${BOLD}║   Jointbox ISP Panel — Activation                        ║${OFF}
  ${BOLD}╚══════════════════════════════════════════════════════════╝${OFF}

EOF

# ---- unattended path -------------------------------------------------------
if [[ -n "${JBX_LICENSE_KEY:-}" ]]; then
  echo "  Activating with the key from JBX_LICENSE_KEY…"
  "$AGENT" -activate "$JBX_LICENSE_KEY" \
    -company "${JBX_COMPANY:-}" -website "${JBX_WEBSITE:-}" \
    -contact "${JBX_CONTACT:-}" -email "${JBX_EMAIL:-}" -phone "${JBX_PHONE:-}"
  exit $?
fi

# ---- non-interactive with no key: do not block the install -----------------
if [[ ! -t 0 ]]; then
  echo "  ${YEL}No licence key supplied and no terminal to ask on.${OFF}"
  echo "  The panel will install and run on a 24-hour trial."
  echo "  Activate later with:  jointbox-licensed -activate JBX-XXXXX-XXXXX-XXXXX-XXXXX"
  echo
  "$AGENT" -activate trial 2>/dev/null || true
  exit 0
fi

# ---- interactive -----------------------------------------------------------
echo "  Enter your licence key, or press Enter for a ${BOLD}24-hour trial${OFF}."
echo "  ${DIM}Format: JBX-XXXXX-XXXXX-XXXXX-XXXXX${OFF}"
echo
read -r -p "  Licence key: " KEY
KEY="${KEY//[[:space:]]/}"

echo
echo "  ${DIM}These details appear on your licence and help support identify you.${OFF}"
read -r -p "  Company name    : " COMPANY
read -r -p "  Website         : " WEBSITE
read -r -p "  Contact person  : " CONTACT
read -r -p "  Email           : " EMAIL
read -r -p "  Phone / WhatsApp: " PHONE
echo

if [[ -z "$KEY" ]]; then
  echo "  Starting a 24-hour trial…"
  echo
  if "$AGENT" -activate trial -company "$COMPANY" -website "$WEBSITE" \
       -contact "$CONTACT" -email "$EMAIL" -phone "$PHONE"; then
    cat <<EOF
  ${YEL}This trial lasts 24 hours and is tied to this server.${OFF}
  Reinstalling will not start a new one. Enter a licence key before it
  ends to keep the panel fully usable.

EOF
    exit 0
  fi
  # Trial refused (already used, or no internet). Fall through to the
  # offline instructions rather than failing the install.
else
  if "$AGENT" -activate "$KEY" -company "$COMPANY" -website "$WEBSITE" \
       -contact "$CONTACT" -email "$EMAIL" -phone "$PHONE"; then
    exit 0
  fi
fi

# ---- could not activate ----------------------------------------------------
cat <<EOF

  ${YEL}Activation did not complete.${OFF}

  The panel is still installed and will keep running. If this server has
  no internet access, send the hardware id below to support and they will
  issue a licence for it.

EOF

"$AGENT" -fingerprint

cat <<EOF
  When you have a key:

    sudo jointbox-licensed -activate JBX-XXXXX-XXXXX-XXXXX-XXXXX

  Check status any time:

    sudo jointbox-licensed -status

EOF
exit 0
