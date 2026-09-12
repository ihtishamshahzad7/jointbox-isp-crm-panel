#!/usr/bin/env bash
# =============================================================================
#  Jointbox OVA — first boot
# -----------------------------------------------------------------------------
#  Runs once, on the console, the first time a customer boots the appliance.
#  Regenerates the machine's identity, then walks them through activation.
#
#  Install into the image with:
#      sudo bash deploy/firstboot/install-firstboot.sh
#
#  WHY THE IDENTITY RESET MATTERS
#  An OVA is one disk image copied to every customer. Everything derived from
#  the template — machine-id, SSH host keys, the licence fingerprint — is
#  IDENTICAL on every install unless it is regenerated here. Ship without this
#  and every customer's panel looks like the same machine to the licence
#  server, so the second one to activate is told the licence is already in use
#  on someone else's server.
# =============================================================================
set -uo pipefail

MARKER=/var/lib/jointbox/.firstboot-done
LOG=/var/log/jointbox-firstboot.log

exec > >(tee -a "$LOG") 2>&1

[[ -f "$MARKER" ]] && exit 0

mkdir -p "$(dirname "$MARKER")"

B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'

echo
echo "${B}Jointbox — first boot${N}"
echo "  $(date -u +%FT%TZ)"
echo

# ---------------------------------------------------------------------------
# 1. Give this machine its own identity
# ---------------------------------------------------------------------------
echo "▶ Generating a unique identity for this server"

# machine-id: the licence fingerprint's strongest component.
if [[ -f /etc/machine-id ]]; then
  : > /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  systemd-machine-id-setup >/dev/null 2>&1 || true
  if [[ -d /var/lib/dbus ]]; then
    cp /etc/machine-id /var/lib/dbus/machine-id 2>/dev/null || true
  fi
  echo "  ✔ machine-id regenerated"
fi

# SSH host keys: not licensing, but shipping one image with one host key means
# every Jointbox appliance on earth shares a private key. Fix it here while we
# are already resetting identity.
if compgen -G "/etc/ssh/ssh_host_*" >/dev/null; then
  rm -f /etc/ssh/ssh_host_*
  dpkg-reconfigure openssh-server >/dev/null 2>&1 || ssh-keygen -A >/dev/null 2>&1 || true
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  echo "  ✔ SSH host keys regenerated"
fi

# Any licence state baked into the template must not be inherited.
if [[ -f /etc/jointbox/license.jws ]] || [[ -f /etc/jointbox/state.json ]]; then
  rm -f /etc/jointbox/license.jws /etc/jointbox/state.json
  echo "  ✔ cleared licence state inherited from the image"
fi

# ---------------------------------------------------------------------------
# 2. Wait for the network, briefly
# ---------------------------------------------------------------------------
echo "▶ Waiting for the network"
for _ in $(seq 1 30); do
  if getent hosts panel.jointbox.net >/dev/null 2>&1; then
    echo "  ✔ network up"
    break
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# 3. Activation
# ---------------------------------------------------------------------------
if [[ -x /usr/local/bin/jointbox-licensed ]]; then
  echo
  if [[ -f /opt/jointbox/scripts/install-licence-agent.sh ]]; then
    # shellcheck source=/dev/null
    source /opt/jointbox/scripts/install-licence-agent.sh
    jbx_write_unit >/dev/null 2>&1 || true
    systemctl start jointbox-licensed 2>/dev/null || true
    jbx_activate || true
  else
    /usr/local/bin/jointbox-licensed -activate trial >/dev/null 2>&1 || true
  fi
else
  echo "${Y}  ▲ Licence agent not present in this image${N}"
fi

# ---------------------------------------------------------------------------
# 4. Tell them where to go
# ---------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

${B}${G}════════════════ JOINTBOX READY ════════════════${N}

  Panel   http://${IP:-<this server>}:3000
  Login   admin@jointbox.com / admin123   ${Y}← change this immediately${N}

  Licence status:  sudo jointbox-licensed -status
  Activate later:  sudo jointbox-activate

EOF

touch "$MARKER"

# One-shot: never run again, even if the marker is deleted by accident.
systemctl disable jointbox-firstboot.service >/dev/null 2>&1 || true

exit 0
