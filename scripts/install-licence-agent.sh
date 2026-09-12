#!/usr/bin/env bash
# =============================================================================
#  Jointbox licence agent — installer
# -----------------------------------------------------------------------------
#  Fetches the agent, installs the systemd unit, and runs activation.
#
#  Called by install.sh (step 10) and by the OVA's first-boot unit. Can also be
#  run on its own to add licensing to an existing box:
#
#      sudo bash scripts/install-licence-agent.sh
#
#  DESIGN RULES
#   * It must NEVER abort an install. A licensing problem is a licensing
#     problem; it is not a reason to leave an ISP with a half-built panel.
#     Every failure path here warns and returns 0.
#   * It must work under `curl … | sudo bash`, where stdin is the script
#     itself. Prompts therefore read from /dev/tty, never stdin.
#   * It must be re-runnable.
# =============================================================================
# Only set shell options when RUN directly. This file is also *sourced* by
# install.sh and update-jointbox.sh, and changing the caller's shell options
# out from under it is a nasty side effect — `set -u` in particular turns any
# later unset variable in the caller into a fatal error, which is how a
# licensing tweak ends up aborting somebody's update halfway through.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -uo pipefail
fi

LICENCE_SERVER="${JBX_LICENCE_SERVER:-https://panel.jointbox.net}"
AGENT_BIN="/usr/local/bin/jointbox-licensed"
WIZARD_BIN="/usr/local/bin/jointbox-activate"
UNIT="/etc/systemd/system/jointbox-licensed.service"

# Reuse install.sh's helpers when sourced from it; define them otherwise.
if ! declare -f ok >/dev/null 2>&1; then
  G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
  ok(){   echo "${G}  ✔${N} $*"; }
  warn(){ echo "${Y}  ▲${N} $*"; }
  err(){  echo "${R}  ✖${N} $*"; }
  step(){ echo; echo "${B}▶ $*${N}"; }
fi

jbx_arch() {
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64|x86_64)  echo amd64 ;;
    arm64|aarch64) echo arm64 ;;
    *) echo unsupported ;;
  esac
}

# ---------------------------------------------------------------------------
# Fetch the binary
# ---------------------------------------------------------------------------
jbx_install_agent() {
  local arch; arch="$(jbx_arch)"
  if [[ "$arch" == unsupported ]]; then
    warn "Licence agent: unsupported CPU architecture; skipping"
    return 0
  fi

  # A locally shipped binary (OVA image, offline install) wins over the network.
  local local_bin=""
  for c in \
      "$(dirname "${BASH_SOURCE[0]}")/../dist/jointbox-licensed-linux-$arch" \
      "$(dirname "${BASH_SOURCE[0]}")/jointbox-licensed-linux-$arch" \
      "/opt/jointbox/dist/jointbox-licensed-linux-$arch"; do
    [[ -f "$c" ]] && { local_bin="$c"; break; }
  done

  if [[ -n "$local_bin" ]]; then
    install -m 0755 "$local_bin" "$AGENT_BIN" && ok "Licence agent installed (bundled)"
  else
    local url="$LICENCE_SERVER/download/jointbox-licensed-linux-$arch"
    local tmp; tmp="$(mktemp)"
    if curl -fsSL --max-time 60 "$url" -o "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      # A proxy or captive portal returning an HTML error page would otherwise
      # be installed as an executable and fail confusingly later.
      if head -c 4 "$tmp" | grep -q $'\x7fELF'; then
        install -m 0755 "$tmp" "$AGENT_BIN" && ok "Licence agent installed ($arch)"
      else
        warn "Licence agent: download was not a binary; skipping"
        rm -f "$tmp"; return 0
      fi
    else
      warn "Licence agent: could not download from $LICENCE_SERVER"
      warn "  The panel will run unrestricted. Install it later with:"
      warn "    sudo bash ${APP_DIR:-/opt/jointbox}/scripts/install-licence-agent.sh"
      rm -f "$tmp"; return 0
    fi
    rm -f "$tmp"
  fi

  # The activation wizard ships beside this script.
  local wiz; wiz="$(dirname "${BASH_SOURCE[0]}")/jointbox-activate.sh"
  [[ -f "$wiz" ]] && install -m 0755 "$wiz" "$WIZARD_BIN"

  install -d -m 0750 /etc/jointbox
  install -d -m 0755 /run/jointbox
  [[ -f /run/jointbox/counts.json ]] || echo '{"subscribers":0,"nas":0}' > /run/jointbox/counts.json

  jbx_write_unit
  return 0
}

jbx_write_unit() {
  cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=Jointbox licence agent
After=network-online.target
Wants=network-online.target

# Deliberately NOT ordered before freeradius. If this unit fails to start,
# subscriber authentication must be entirely unaffected.

[Service]
Type=simple
ExecStart=/usr/local/bin/jointbox-licensed
Restart=always
RestartSec=15
User=root
Group=root
RuntimeDirectory=jointbox
RuntimeDirectoryMode=0755

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/etc/jointbox /run/jointbox
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
MemoryMax=128M
CPUQuota=10%

StandardOutput=journal
StandardError=journal
SyslogIdentifier=jointbox-licensed

[Install]
WantedBy=multi-user.target
UNITEOF

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable jointbox-licensed >/dev/null 2>&1 || true
  ok "Licence agent service enabled"
}

# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------

# Can we actually open a terminal to ask on?
#
# `[[ -r /dev/tty ]]` is NOT the test: the device node exists with readable
# permissions even when the process has no controlling terminal, so that check
# passes and the subsequent read fails with "No such device or address" —
# printed to the customer's screen mid-install. The only reliable test is to
# open it.
jbx_have_tty() {
  { true >/dev/tty; } 2>/dev/null
}

# Is this licence already good? Used to make the whole step a no-op on re-runs.
jbx_already_activated() {
  [[ -x "$AGENT_BIN" ]] || return 1
  "$AGENT_BIN" -status 2>/dev/null | grep -qE 'State +: (ACTIVE|GRACE)'
}

jbx_activate() {
  [[ -x "$AGENT_BIN" ]] || return 0

  if jbx_already_activated; then
    ok "Already activated"
    systemctl restart jointbox-licensed 2>/dev/null || true
    return 0
  fi

  # --- unattended: a key in the environment ------------------------------
  if [[ -n "${JBX_LICENSE_KEY:-}" ]]; then
    if "$AGENT_BIN" -activate "$JBX_LICENSE_KEY" \
         -company "${JBX_COMPANY:-}" -website "${JBX_WEBSITE:-}" \
         -contact "${JBX_CONTACT:-}" -email "${JBX_EMAIL:-}" -phone "${JBX_PHONE:-}"; then
      systemctl restart jointbox-licensed 2>/dev/null || true
      return 0
    fi
    warn "Activation with JBX_LICENSE_KEY failed — see the message above"
    return 0
  fi

  # --- interactive, if there is a terminal to ask on ----------------------
  #
  # Read from /dev/tty rather than stdin. Under `curl … | sudo bash` stdin IS
  # the script, so a plain `read` would silently swallow the rest of the
  # installer — a genuinely nasty failure mode.
  if jbx_have_tty; then
    jbx_prompt_and_activate && { systemctl restart jointbox-licensed 2>/dev/null || true; return 0; }
  fi

  # --- no key, no terminal: start a trial and carry on --------------------
  if "$AGENT_BIN" -activate trial >/dev/null 2>&1; then
    warn "Started a 24-hour trial. Activate with a licence key before it ends:"
    warn "    sudo jointbox-activate"
  else
    warn "Not activated. The panel will run unrestricted until a licence agent"
    warn "is activated. Run:  sudo jointbox-activate"
  fi
  systemctl restart jointbox-licensed 2>/dev/null || true
  return 0
}

jbx_prompt_and_activate() {
  local key company website contact email phone

  {
    echo
    echo "  Enter your licence key, or press Enter for a 24-hour trial."
    echo "  Format: JBX-XXXXX-XXXXX-XXXXX-XXXXX"
    echo
  } > /dev/tty

  read -r -p "  Licence key: " key < /dev/tty || return 1
  key="${key//[[:space:]]/}"

  { echo; echo "  These details appear on your licence and help support identify you."; } > /dev/tty
  read -r -p "  Company name    : " company < /dev/tty || true
  read -r -p "  Website         : " website < /dev/tty || true
  read -r -p "  Contact person  : " contact < /dev/tty || true
  read -r -p "  Email           : " email   < /dev/tty || true
  read -r -p "  Phone / WhatsApp: " phone   < /dev/tty || true
  echo > /dev/tty

  local target="${key:-trial}"
  if "$AGENT_BIN" -activate "$target" \
       -company "$company" -website "$website" -contact "$contact" \
       -email "$email" -phone "$phone"; then
    return 0
  fi

  # Activation refused or unreachable. Show the hardware id so support can
  # issue an offline licence, then let the install finish.
  {
    echo
    echo "  Activation did not complete. The panel is still installed and running."
    echo "  If this server has no internet access, send the hardware id below to"
    echo "  support and they will issue a licence for it."
    echo
  } > /dev/tty
  "$AGENT_BIN" -fingerprint > /dev/tty 2>&1 || true
  return 1
}

# ---------------------------------------------------------------------------
# Entry point when run directly
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  [[ $EUID -eq 0 ]] || { err "Run with sudo."; exit 1; }
  : "${APP_DIR:=/opt/jointbox}"
  step "Licence agent"
  jbx_install_agent
  jbx_activate
  "$AGENT_BIN" -status 2>/dev/null || true
fi
