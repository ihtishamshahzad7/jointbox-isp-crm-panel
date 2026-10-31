# Uplinko VPN — Phase 1 correction + Phase 2 UI

Architecture: **panel = L2TP/IPsec client, NAS = server**, panel dials the NAS public IP via strongSwan + xl2tpd + pppd on the host. Management tunnel, not subscriber auth. WireGuard + SSTP left intact. **No commit/push** — apply `uplinko-vpn-phase1-2.patch` (`git apply`) on a clean `main`.

## Stage 1 integration check
Phase 1 was already present in the working tree (not merely in the patch file): the migration, dialer, specs, and the service/controller/module edits were all in place. This pass **corrected** them in the tree.

## Changed files (9)
`backend/prisma/schema.prisma` · `backend/prisma/migrations/20261101090000_nas_l2tp_client/migration.sql` · `backend/src/nas/l2tp-client-dialer.service.ts` · `backend/src/nas/l2tp-client-dialer.spec.ts` · `backend/src/nas/nas-l2tp-management.spec.ts` · `backend/src/nas/nas-l2tp-config.service.ts` · `backend/src/nas/nas-l2tp-config.controller.ts` · `backend/src/nas/nas.module.ts` · `frontend/app/nas/nas-vpn-panel.tsx`

## Phase 1 defects corrected
1. **strongSwan loads the config** — per-NAS connection + PSK written to a swanctl `conf.d` dir, loaded with `swanctl --load-all`, dialed with `swanctl --initiate`. (Was: `ipsec.conf` files never loaded.)
2. **xl2tpd operates the LAC** — `xl2tpd-control add <lac>` into the running daemon, then `connect`; removed on teardown. (Was: unused config file.)
3. **Status is connection-specific** — IPsec via `swanctl --list-sas --ike <name>` (scoped to this connection) and the ppp interface read from `xl2tpd-control status <name>` for THIS lac. Never an arbitrary ppp device.
4. **PPP + IPsec both verified** — "connected" requires the matching IPsec SA ESTABLISHED **and** the lac's own ppp interface operationally UP (`ip link … state UP`), not merely present.
5. **`use-ipsec=required` enforced** — apply confirms the read-back value is exactly `required` (plus server enabled + PPP secret) before reporting applied.
6. **Cleanup on error/timeout** — every failed/again path runs `teardown` (`xl2tpd-control disconnect`+`remove`, `swanctl --terminate`).
7. **Input validation** — host/IP, PPP username, profile, addresses, PSK and password validated (char-whitelist, no newlines/config-breakers) before any file write or RouterOS command.
8. **Secret file permissions** — 0700 dir, 0600 files, re-asserted with `chmod` on every write including overwrites.
9. **Bounded retry** — saved `retryCount`/`retryDelaySec`/`timeout` are clamped (≤10 retries, ≤60s delay, ≤120s timeout).
10. **Idempotent + conflict-safe apply** — our PPP secret is stamped with an `uplinko-mgmt-vpn` comment marker; repeated apply updates that secret, and a pre-existing secret of the same name that is **not** ours (different service / no marker) is refused instead of overwritten.
11. **Tunnel-side API + bootstrap** — `nasApi()` takes the NAS public IP for the initial (bootstrap) apply and prefers the tunnel-side `routerManagementIp` once connected.
12. **Schema/migration/PG consistency** — client columns verified identical across schema and migration (types + defaults); `prisma validate` is the only step blocked here (engine download).
13. **Tenant/permissions/encryption preserved** — every method calls `ensureAccess` (scope + owner); secrets encrypted via `SecretsService`; views return has-flags only.

## Phase 2 UI (`nas-vpn-panel.tsx`)
Reworked into four sections, subscriber/RADIUS presentation removed, wired to the real endpoints (`GET/PUT :id/l2tp-client`, `POST :id/l2tp-client/{apply-nas,connect,disconnect,reconnect}`, `GET :id/l2tp-client/status`, existing `POST :id/vpn/discover-neighbors`):
1. **NAS Server Configuration** — public endpoint, dedicated PPP username/password, masked IPsec PSK (required), PPP profile, local/remote tunnel addresses; **Apply to NAS** shows the real verified result (server enabled / IPsec required / PPP secret present).
2. **Panel L2TP Client** — direction banner "Uplinko Panel → NAS Public IP", Connect/Disconnect/Reconnect/Refresh, status from the backend only (never "connected" from a save), tunnel interface + assigned addresses + last connected.
3. **Connection Diagnostics** — host tooling, IPsec SA, L2TP session, PPP interface state, last error+time, a plain-language result that distinguishes confirmed facts from possible causes.
4. **Discover Neighbors** — reuses the existing authorized `discoverNeighbors` (neighbor + ARP), no scanning.
Branding/colors/design-system/app-shell preserved; WireGuard tunnel kept as a separate section.

## Tests — actually executed
- **Backend dialer + management specs: 22/22 PASS** (ts-jest transpile-only). Covers: config loaded by the daemons, IPsec-required verification, wrong-ppp-interface rejection, ppp-present-but-down, IPsec-without-L2TP, L2TP-start-failure + cleanup, missing tools/socket, secret 0600 + redaction, multiple independent NAS tunnels, PPP-secret conflict + safe repeat apply, tenant isolation, input validation, bounded retry.
- **Frontend typecheck: PASS** · **Frontend production build: PASS** · **ESLint: no new errors** (base==now).
- **Browser verification** (built app, Chromium, l2tp-client mocked): `/nas/1?tab=vpn` renders all four sections inside the real shell; **0 horizontal overflow at 1280px and 375px**.

## Could NOT run here (environment limit — Prisma engine download firewalled: `binaries.prisma.sh` 403)
`prisma validate/generate`, full backend `tsc`, the full backend Jest suite, and backend `npm run build`. These run normally on your server/CI (which have engine access). Steps for you:
1. `cd backend && npx prisma generate && npm run typecheck && npm test && npm run build`
2. `npm run db:deploy` (applies the additive migration).

## Deployment prerequisites
- Install `strongswan` (with `swanctl`), `xl2tpd`, `ppp` on the Uplinko host; run xl2tpd so its control socket exists (`XL2TPD_CONTROL_SOCKET`, default `/var/run/xl2tpd/l2tp-control`). Optional `L2TP_CLIENT_DIR` (default `/etc/uplinko/l2tp`). The backend needs privilege to run `swanctl`/`xl2tpd-control`/`ip` (systemd unit or sudo helper).

## Still requires a live MikroTik lab test (not done here)
End-to-end: real `swanctl --load-all`/`--initiate` against a MikroTik L2TP/IPsec server, real `xl2tpd-control` session bring-up, PPP interface UP, and `apply-nas` writing+confirming on a real RouterOS device. **Not production-ready until that passes.**
