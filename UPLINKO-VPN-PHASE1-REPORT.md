# Uplinko VPN rework — Phase 1 (backend: data + API + tests)

Architecture: **Uplinko panel = L2TP/IPsec client; NAS (public IP) = server.** Dial mechanism: **strongSwan + xl2tpd on the host** (your choice). Delivery: **phased** — this is backend; the UI rework is Phase 2. **No commit/push** (per instruction) — apply `uplinko-vpn-phase1.patch` with `git apply` on a clean `main`.

## Files (8)
| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | `NasL2tpConfig`: added panel-client fields; marked RADIUS-subscriber fields deprecated |
| `backend/prisma/migrations/20261101090000_nas_l2tp_client/migration.sql` | Additive, idempotent `ADD COLUMN IF NOT EXISTS` — no data altered/dropped |
| `backend/src/nas/l2tp-client-dialer.service.ts` | **New.** Host strongSwan+xl2tpd client dialer |
| `backend/src/nas/l2tp-client-dialer.spec.ts` | **New.** 8 dialer tests |
| `backend/src/nas/nas-l2tp-management.spec.ts` | **New.** 7 management-service tests |
| `backend/src/nas/nas-l2tp-config.service.ts` | Added management-VPN methods (apply/connect/disconnect/reconnect/status/client view) |
| `backend/src/nas/nas-l2tp-config.controller.ts` | Added `:id/l2tp-client*` endpoints |
| `backend/src/nas/nas.module.ts` | Registered `L2tpClientDialer` provider |

## What Phase 1 delivers
- **Schema**: `pppUsername`, `pppPasswordEnc`, `localAddress`, `remoteAddress`, `connectTimeoutSec`, `retryCount`, `retryDelaySec`, `clientState`, `tunnelInterface`, `lastDialAt/ConnectedAt/DisconnectedAt`, `lastTunnelState`, `lastClientError`. The central-RADIUS subscriber columns are retained for back-compat but marked deprecated and are **not used** by the management flow (no second source of truth — same model, same `SecretsService`, same `ScopeService`).
- **Host dialer** (`L2tpClientDialer`): writes strongSwan IKEv1-PSK + xl2tpd + pppd config to **0600** files, runs `ipsec up` / `xl2tpd-control connect` toward the **NAS public IP**, and reports **connected only when a real ppp interface + established IPsec SA are observed** — never because config was saved. PSK-mismatch and unreachable-NAS errors are classified from the tool output. All host commands go through an injectable runner (testable; a host without the tooling degrades to a clear error, not a false "connected"). Secrets are never logged.
- **Management service methods** (single source of truth on `NasL2tpConfig`):
  - `applyServerToNas` — over the RouterOS API: enable `/interface/l2tp-server/server` with `use-ipsec=required` + PSK, create/update the **dedicated PPP secret with `service=l2tp`**, then **read back** the server + secret and only mark applied when the NAS confirms. Partial failure records `lastError` and state `failed`.
  - `connectClient` / `disconnectClient` / `reconnectClient` / `clientStatus` — drive the dialer and persist verified lifecycle state.
  - `saveClientConfig` / `getClientView` — store encrypted creds; the view returns **has-flags only**, never secrets, and states the direction `Uplinko Panel → NAS Public IP`.
- **Endpoints** (`nas.read`/`nas.write` perms + owner check via `ensureAccess`): `GET/PUT :id/l2tp-client`, `POST :id/l2tp-client/{apply-nas,connect,disconnect,reconnect}`, `GET :id/l2tp-client/status`.
- **Not broken**: existing SSTP (`vpn.service.ts` + spec), the WireGuard management tunnel (`NasTunnel`/`tunnel.service`), and the existing authorized neighbour/ARP discovery (`nas.service.discoverNeighbors`) are untouched and will be reused by the Phase-2 UI.

## Tests — actually executed
- **Dialer: 8/8 PASS** — missing-stack → error (not connected); dials NAS public IP; connected only with real interface + SA; never connected on IPsec-up-but-no-interface; PSK mismatch classified; unreachable classified; PSK/PPP written only to 0600 files; hangup tears down L2TP then IPsec.
- **Management service: 7/7 PASS** — apply creates `service=l2tp` secret + enables server and confirms by read-back; does not claim applied without confirmation; missing PSK/PPP rejected; connect dials the public IP and persists verified state; incomplete creds rejected; `getClientView` leaks no secrets and states direction; disconnect tears down.
- Executed with ts-jest transpile-only because **this sandbox cannot download the Prisma native engine** (`binaries.prisma.sh` is firewalled: 403), which blocks full `prisma generate`, full `tsc`, and the whole Jest suite here. That is an environment limit, not a code issue — your server/CI already have engine access (the earlier install work proved RouterOS/DB connectivity there).

## What you must run on an engine-capable machine (server or CI)
1. `cd backend && npx prisma generate` then `npm run typecheck` — confirm full type-clean.
2. `npm test` — run the whole suite incl. the two new specs under normal config.
3. `npm run db:deploy` (or `prisma migrate deploy`) to apply the additive migration.
4. Install `strongswan` + `xl2tpd` + `ppp` on the Uplinko host and grant the backend privilege to control them (systemd/helper); set `L2TP_CLIENT_DIR` if not `/etc/uplinko/l2tp`.

## Phase 2 (next, on your go)
Full UI rework of the NAS VPN panel: rename to **"NAS Management VPN · L2TP/IPsec"**, remove subscriber/RADIUS terminology, sections **NAS Server Configuration / Panel L2TP Client / Connection Diagnostics / Discover Neighbors**, show the direction, wire the new `:id/l2tp-client*` endpoints and Connect/Disconnect/Reconnect with real status, and make discovery depend on the established tunnel.

## Remaining / honest gaps
- Full `tsc`/full Jest not run here (Prisma engine firewalled) — run on your server/CI.
- Real end-to-end tunnel to a live MikroTik not exercised (no device/VPN stack in sandbox); logic is covered by mocked tests.
- UI is Phase 2 (not started).
