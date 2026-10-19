# Panel VPN Servers — Runbook

How a remote MikroTik (typically behind CGNAT) reaches this panel over a
tunnel so its PPPoE users authenticate here and the panel can run RADIUS / CoA
/ API toward the router. Three server types: **WireGuard**, **OpenVPN**,
**L2TP/IPsec**. Several can run at once; many routers can connect to each.

> **Provisioning model — read this first.** The panel backend is an
> **unprivileged** service. It does **not** create interfaces or start daemons
> itself. For each VPN type it *generates* a one-time install script you run on
> the panel host **as root**, plus the per-router config to paste on each
> device. The panel then **observes and reports** real status. A privileged
> auto-provisioning helper is **not** implemented yet (see "Not done").

## Prerequisites on the panel host
- Debian/Ubuntu with `systemd`, `ss` (iproute2), and `ip`.
- Per type, installed by the generated script:
  - WireGuard: `wireguard-tools` (`wg`, `wg-quick`).
  - OpenVPN: `openvpn`, `easy-rsa`.
  - L2TP/IPsec: `strongswan` (`swanctl`/`ipsec`), `xl2tpd`.
- A public hostname or IP for the panel (set it in the GUI as **Panel public
  address** — required for every type; routers dial it).

## Ports / firewall (open inbound on the panel host)
| Type         | Port(s)                    |
|--------------|----------------------------|
| WireGuard    | `51820/udp` (configurable) |
| OpenVPN      | `1194/udp` or `/tcp` (configurable) |
| L2TP/IPsec   | `500/udp`, `4500/udp`, `1701/udp` |

The install scripts add `ufw` rules best-effort; verify with your actual
firewall. If the panel is behind NAT, forward these ports to it.

## Routing / forwarding / MTU
- Enable IP forwarding on the panel host (`net.ipv4.ip_forward=1`) so overlay
  traffic can reach RADIUS/services.
- Overlay subnets default to `10.66.0.0/24` (WG), `10.67.0.0/24` (OVPN),
  `10.68.0.0/24` (L2TP); the panel takes `.1`. Keep them disjoint and off your
  LAN ranges.
- **MTU/MSS:** tunnels add overhead. WireGuard ≈ 1420 MTU; if PPPoE rides the
  tunnel, clamp MSS on the router (`/ip firewall mangle … change-mss` or
  `mss=clamp-to-pmtu`) to avoid black-holing large packets. Symptoms of a bad
  MTU: handshake succeeds, small pings work, web/large transfers stall.

## Install → verify (per type)
1. In the panel: **Network → VPN Servers**, set the public address.
2. Open a type's **Setup**, copy the install script, run it **once on the panel
   host as root**. It is idempotent — re-running is safe.
3. Paste the generated MikroTik config on the router. For WireGuard, issue the
   per-router keys from that router's **Tunnel** tab, then **Reconcile**.
4. Click **Re-check** (status) and **Verify** (end-to-end checks).

## What the status means (truthful states)
`unconfigured` · `install_required` · `starting` · `online` · `degraded` ·
`offline` · `error` · `unknown`. A port being open is **never** reported as
"connected". Specifically:
- **WireGuard** `online` = `wg` present, interface up, overlay IP assigned.
  "Connected routers" counts peers whose last handshake is within 180s.
- **OpenVPN** reads `systemctl is-active openvpn-server@jointbox` + listening
  socket + tun IP.
- **L2TP/IPsec** requires **both** `xl2tpd` and strongSwan active, and counts
  established IKE SAs (`swanctl --list-sas` / `ipsec status`).
- `unknown` (a probe tool missing or a timeout) is **not** treated as healthy
  or broken.

**Verify** (`GET /vpn/:type/verify`) additionally pings the panel's *own*
overlay IP (a filtered ICMP is reported inconclusive, never a failure) and
checks the local RADIUS path (1812/udp) is present. It sends **no** credentials
and cannot disconnect subscribers. Note: a local overlay IP or an open RADIUS
port proves the *panel side*, not that a given remote NAS is reachable through
the tunnel — that is shown only by a real peer handshake / established SA.

## Service diagnostics
- WireGuard: `wg show wg0`, `systemctl status wg-quick@wg0`, `journalctl -u wg-quick@wg0`.
- OpenVPN: `systemctl status openvpn-server@jointbox`, `journalctl -u openvpn-server@jointbox`.
- L2TP/IPsec: `swanctl --list-sas`, `ipsec statusall`, `systemctl status xl2tpd strongswan`.

## Config & backup / recovery
- Desired config: `vpn-servers.json`; observed state: `vpn-state.json`
  (both `0600`, in the backend working dir / `$JBX_VPN_CONFIG` / `$JBX_VPN_STATE`,
  **outside** any public web root).
- Writes are atomic (temp + fsync + rename) and keep a single rolling `.bak`.
  To recover a bad edit: `cp vpn-servers.json.bak vpn-servers.json` and restart
  the backend. A corrupt/missing file loads safe defaults rather than crashing.
- **Concurrency limitation:** writes are serialised **in-process**. With
  multiple backend workers the atomic rename prevents torn reads, but
  cross-process writes are last-writer-wins. Treat VPN config edits as
  low-frequency / single-admin.

## Rollback
- Backend: the feature is contained to `src/vpn/*`; reverting the commit on this
  branch removes the hardening without touching the base VPN feature on `main`.
- Host: the install scripts don't uninstall. To roll back a server:
  `systemctl disable --now wg-quick@wg0` (or `openvpn-server@jointbox`,
  `xl2tpd`/`strongswan`) and remove the generated config under `/etc/...`.

## MikroTik (RouterOS 7) quick reference
Use the **Client config** generator in the GUI (per vendor + overlay IP). It
emits placeholders (`<panel-public-key>`, `<shared-secret>`, `<password>`) —
fill them from the install output; **no secret is ever embedded** by the panel.

## Testing reality — IMPORTANT
The unit tests (`vpn.service.spec.ts`, 18 cases) cover config validation,
atomic persistence + backup, the WireGuard dump parser, the health state
machine, the honest-verify contract, and the monitor's dedup/cooldown — all
against **stubbed** host output. **They do NOT prove interoperability with real
WireGuard/OpenVPN/L2TP daemons or a real MikroTik router.** A lab acceptance
run against at least one live server + one router is required before claiming
production readiness.

## Not done (still open)
- Privileged root-owned provisioning helper + least-privilege sudoers.
- Deeper installer hardening: rollback, MTU/MSS auto-clamp, post-install self-test.
- Explicit VPN ↔ NAS ↔ RADIUS/CoA binding with tenant isolation surfaced in UI.
- Real-router / live-daemon acceptance tests.
