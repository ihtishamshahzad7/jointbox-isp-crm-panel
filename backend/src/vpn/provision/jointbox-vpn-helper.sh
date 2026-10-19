#!/usr/bin/env bash
#
# Jointbox VPN privileged helper — root-owned, least-privilege.
#
# PURPOSE: let the unprivileged panel backend recover an ALREADY-INSTALLED VPN
# service (start/stop/restart/status) without granting it general sudo. It does
# NOT install packages, generate keys, write config, or take any argument that
# reaches a shell. Provisioning remains the operator-run installer.
#
# INSTALL (operator, once):
#   sudo install -o root -g root -m 0755 jointbox-vpn-helper.sh \
#        /opt/jointbox/vpn/jointbox-vpn-helper.sh
#   sudo install -o root -g root -m 0440 sudoers.jointbox-vpn \
#        /etc/sudoers.d/jointbox-vpn      # visudo -c first
# The file MUST be owned by root and NOT writable by the backend user, or the
# whole privilege boundary is void.
#
# CONTRACT: exactly two positional args, each from a fixed allow-list. Anything
# else exits non-zero without acting. No eval, no word-splitting of input, no
# variable reaches a command name.
set -euo pipefail

op="${1:-}"
type="${2:-}"

case "$op" in
  start|stop|restart|status) : ;;
  *) echo "jointbox-vpn-helper: invalid operation" >&2; exit 2 ;;
esac

# Map the VPN type to its FIXED systemd unit(s). The case label is the only way
# to select a unit; the input never becomes a unit string directly.
units=()
case "$type" in
  wireguard) units=("wg-quick@${JBX_WG_IFACE:-wg0}") ;;
  openvpn)   units=("openvpn-server@jointbox") ;;
  l2tp)      units=("strongswan" "xl2tpd") ;;
  *) echo "jointbox-vpn-helper: invalid type" >&2; exit 2 ;;
esac

# JBX_WG_IFACE, if set, must be a bare interface name — defend even though it is
# operator-set, not request-set.
if [[ "${JBX_WG_IFACE:-wg0}" =~ [^A-Za-z0-9@._-] ]]; then
  echo "jointbox-vpn-helper: bad interface name" >&2; exit 2
fi

SYSTEMCTL=/usr/bin/systemctl
[[ -x "$SYSTEMCTL" ]] || SYSTEMCTL=/bin/systemctl

rc=0
for u in "${units[@]}"; do
  if [[ "$op" == "status" ]]; then
    "$SYSTEMCTL" is-active "$u" || rc=$?
  else
    "$SYSTEMCTL" "$op" "$u" || rc=$?
  fi
done
exit "$rc"
