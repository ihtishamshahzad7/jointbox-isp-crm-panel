#!/usr/bin/env bash
# =============================================================================
#  Install the first-boot unit into an OVA image.
#
#  Run this on the template VM, LAST, immediately before you shut it down and
#  export the appliance.
#
#      sudo bash deploy/firstboot/install-firstboot.sh
#      sudo shutdown -h now      # then export the OVA
# =============================================================================
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "$SRC/jointbox-firstboot.sh" /usr/local/sbin/jointbox-firstboot

cat > /etc/systemd/system/jointbox-firstboot.service <<'EOF'
[Unit]
Description=Jointbox first boot (identity reset and activation)
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/lib/jointbox/.firstboot-done

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/jointbox-firstboot
RemainAfterExit=yes

# Runs on the console so the customer can be prompted for a licence key.
StandardInput=tty
StandardOutput=journal+console
StandardError=journal+console
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable jointbox-firstboot.service

# Remove any marker left by testing, so the real first boot runs.
rm -f /var/lib/jointbox/.firstboot-done

cat <<'EOF'

  First-boot unit installed and enabled.

  BEFORE EXPORTING THE OVA, also clear this template's own identity, or every
  appliance built from it starts life as the same machine:

    sudo bash -c '
      : > /etc/machine-id
      rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*
      rm -f /etc/jointbox/license.jws /etc/jointbox/state.json
      rm -f /var/lib/jointbox/.firstboot-done
      truncate -s 0 /var/log/*.log 2>/dev/null
      history -c
    '
    sudo shutdown -h now

  The first-boot script regenerates all of that anyway, but clearing it here
  means the image itself carries no identity and no licence — so a copy of the
  OVA that never boots cannot be traced to, or activated as, your test machine.

EOF
