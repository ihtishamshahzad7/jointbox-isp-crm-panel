# Uplinko VPN — Architecture Assessment (inspection before change)

## Verdict
The existing L2TP/IPsec implementation assumes the **wrong direction and the wrong purpose**. It is built as **panel-as-server + subscriber VPN + central FreeRADIUS**, not **panel-as-client dialing a NAS L2TP/IPsec server for management**.

## Where the wrong architecture lives

### 1. `backend/src/vpn/vpn.service.ts` — reversed direction (panel = server)
Its own header documents the model: *"Several [VPN servers] can run at once, and many routers can connect to each … the exact MikroTik **client** config to paste on each router."*
- `VpnType = 'wireguard' | 'openvpn' | 'l2tp' | 'sstp'` with panel-side server **subnets** (`l2tp.subnet 10.68.0.0/24`, `sstp.subnet`) — the panel hands out addresses to routers that connect **to it**.
- This is **router → panel**. The spec requires **panel → NAS public IP**.

### 2. `NasL2tpConfig` model + `backend/src/nas/nas-l2tp-config.service.ts` — subscriber/RADIUS framing, and only a simulation
- Model fields that encode central-RADIUS **subscriber** auth (spec forbids these): `radiusServer`, `radiusAuthPort`, `radiusAcctPort`, `nasIdentifier`, `radiusSourceIp`, `radiusSharedSecretEnc`.
- "Server-for-many-clients" fields: `clientPool`, `maxSessions`, `dnsServers`, `mtu`, `mru`, `idleTimeout`, `sessionTimeout`.
- Service helpers prove it: `radiusSettings()`, `publicRadius()`, `useCentralRadius()`, `getRadiusForNas()`, and literals `subscriberStore: 'central'`, `provider: 'FreeRADIUS'`.
- It is **preview-only**: the code returns *"Preview-only simulation — no live RouterOS command was executed"*, *"No live RouterOS rollback was executed"*, *"No live RouterOS capability check was performed."* So today it **never** applies to a NAS, **never** creates a PPP secret, **never** dials, and **never** verifies a tunnel.
- **Missing entirely** for the correct design: a **dedicated panel PPP Secret** (username + encrypted password, `service=l2tp`), panel-side **client dial** credentials/lifecycle, and **real tunnel/interface verification**.

### 3. `frontend/app/nas/nas-vpn-panel.tsx` — subscriber terminology in the UI
- Types/state: `RadiusInfo`, `subscriberStore`, `radiusSourceIp`, `clientPool`, `dnsServers`; calls `/nas/{id}/vpn/radius`.
- Presents L2TP as "configure this NAS as a subscriber L2TP server against central RADIUS" — the wrong mental model.

### 4. `frontend/app/vpn/page.tsx`
- Just `redirect("/nas")`. The VPN UI actually lives in the NAS detail page (`nas-vpn-panel.tsx` + `tunnel-panel.tsx`).

## What is correct and MUST NOT be broken
- **SSTP** (`vpn-sstp.spec.ts`, `vpn.service.ts`): config generation + tests. Keep working.
- **WireGuard management tunnel** (`NasTunnel` model, `tunnel-panel.tsx`): this is a **separate, legitimate** path for **CGNAT routers that dial the panel** (no public IP). It is intentionally the opposite direction and is the right tool for CGNAT. The new L2TP/IPsec management VPN is the complement for **public-IP** NAS (panel dials the NAS). Both should coexist; do not merge or remove WireGuard.
- Encryption at rest via `SecretsService`, scope/tenant checks via `ScopeService`, `ensureAccess()` — reuse these; they are correct.

## Correction plan (no second source of truth; reuse NAS + SecretsService + Scope)
1. **Schema** `NasL2tpConfig`: add panel-client fields — `pppUsername`, `pppPasswordEnc`, `localAddress`, `remoteAddress`, `connectTimeoutSec`, `retry*`, and client lifecycle columns (`clientState`, `lastDialAt`, `lastConnectedAt`, `lastTunnelState`, `lastError`+ts). Deprecate/stop centering on the RADIUS-subscriber fields (keep columns for back-compat but remove from the flow). `lastAppliedAt/lastVerifiedAt/state/revision` already exist — reuse.
2. **NAS-side apply** (RouterOS, real, confirmed): enable `/interface/l2tp-server/server`, set IPsec + PSK, create the **dedicated PPP secret** (`/ppp/secret add name=<panel-user> password=<…> service=l2tp profile=<…> local-address remote-address`). Confirm each setting by reading it back; never claim applied without confirmation; preview + validate before apply; partial-failure rollback.
3. **Panel-side client**: store NAS public host, IPsec PSK, PPP user/pass (encrypted), timeouts; **dial out** to the NAS public IP; **verify the real tunnel/interface** before showing Connected; expose Connect/Disconnect/Reconnect; states from real evidence only.
4. **Neighbor discovery**: over the established tunnel, read RouterOS neighbor + ARP tables (authorized API), no scans; accurate error when disconnected; tenant/dealer/NAS scoped.
5. **UI**: rename to **"NAS Management VPN · L2TP/IPsec"**; remove Subscriber/RADIUS wording; sections **NAS Server Configuration / Panel L2TP Client / Connection Diagnostics / Discover Neighbors**; show direction **Uplinko Panel → NAS Public IP**; never show duplicate values as independent credentials.
6. **Tests**: direction, `service=l2tp`, PSK match/mismatch, bad PPP creds rejected, unreachable NAS error, disconnect/reconnect, discovery only through tunnel, no secret in responses/logs.

## The one decision I need before implementing (infra, yours to make)
The spec says *"The panel must initiate the L2TP/IPsec connection."* **How should the Uplinko server actually bring up the client tunnel?** This choice shapes the whole implementation and cannot be guessed — see the question I'm asking alongside this report.
