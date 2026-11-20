# Uplinko NAS Management VPN — Phase 1 (Backend) Implementation Report

**Status: NOT VERIFIED against a real MikroTik or a real Linux strongSwan/xl2tpd/pppd host.** Every test in this report is a mocked unit test. Do not treat the VPN as production-ready until the manual integration steps in §7 pass on real equipment.

| Item | Value |
|---|---|
| Base | `main` @ `af61caa` (unchanged; nothing committed, pushed or deployed) |
| Working tree before | only CRLF noise in `backend/prisma/seed.ts` and `backend/src/prisma/prisma.service.ts`, plus the earlier audit report. All of it was preserved. |
| Architecture | Uplinko Linux server = L2TP/IPsec **client** (strongSwan + xl2tpd + pppd) → MikroTik NAS public IP = L2TP/IPsec **server** with a dedicated `/ppp secret service=l2tp`. A NAS management tunnel only: no subscriber VPN and no FreeRADIUS. |

---

## 1. Patch review findings (`uplinko-vpn-phase1-2.patch`)

I read the whole patch: migration, schema, dialer service and spec, controller, service, management spec, module and frontend panel. It applies cleanly to `af61caa`, which confirms it had never been applied. **It was not applied as written.** These defects were corrected:

| # | Severity | Patch defect | Consequence | Correction |
|---|---|---|---|---|
| P1 | CRITICAL | pppd options contain `require-mschap-v2` | `require-*` makes the **client demand that the NAS authenticate to it**. Authentication against a MikroTik would fail every time. | The client authenticates *to* the NAS: `noauth` plus `refuse-pap/chap/eap/mschap`, which leaves MS-CHAPv2. |
| P2 | CRITICAL | `xl2tpd-control add / connect / status / remove` | xl2tpd-control's verbs are `add-lac / connect-lac / disconnect-lac / remove-lac`. The patch's commands would not run. | Correct verbs. Results are checked for exit code and "error" output. |
| P3 | CRITICAL | Interface taken from regex `ppp\d+` on `xl2tpd-control status` output | That output does not name the pppd interface, so the result would be empty or another NAS's `pppN`. | pppd `ifname ulnas<ID>` gives each NAS a fixed interface; status reads only that one. |
| P4 | CRITICAL | `secrets { ike-… { secret = "…" } }` with no `id` selector | A wildcard PSK. With several NAS configured, strongSwan could offer one NAS's key to another, so per-NAS isolation was broken. | The secret is bound with `id-1 = <NAS public IP>` and the remote `id` is set. Public host must be an IPv4 address, so PSK lookup by address is deterministic. |
| P5 | HIGH | Config written to `/etc/uplinko/l2tp/swanctl/conf.d`, then `swanctl --load-all` | `--load-all` reads `/etc/swanctl/swanctl.conf`, which does not include that directory, so nothing would load. | Files go to the stock `/etc/swanctl/conf.d/uplinko-nas-<ID>.conf`. Loading all files never unloads another NAS. |
| P6 | HIGH | PSK and PPP password interpolated inside `"…"`; only `"` and newline rejected | Backslash and other characters could corrupt the config lines. | PSK is written as `0s<base64>`. Secrets are restricted to 8–128 printable characters with no `"` or `\`. |
| P7 | HIGH | RouterOS secret `remote-address=<remoteAddress>` and `local-address=<localAddress>` | **Reversed.** In RouterOS, `local-address` is the router's own side, so the NAS would hand out the wrong addresses. | `local-address` = NAS tunnel IP, `remote-address` = Uplinko tunnel IP. A test covers this. |
| P8 | HIGH | Apply sets `authentication=mschap2`, `default-profile` and the global `ipsec-secret` unconditionally | Breaks every **other** L2TP client already using that NAS. | Only `mschap2` is *added*, `default-profile` is not touched, `use-ipsec=required` is kept if already set. Replacing a running server's different IPsec secret needs `confirmServerChange: true`. |
| P9 | HIGH | Secret counted as "ours" if `comment` matches **or** `service === 'l2tp'` | Any existing customer L2TP secret with the same name would be overwritten. | Only the `uplinko-mgmt-vpn` marker counts. Otherwise 409. |
| P10 | HIGH | No route handling at all; "connected" did not consider routing | The isolation requirement was not covered. | `nodefaultroute`, no `usepeerdns`. Before "connected": `ip route get <NAS tunnel IP>` must leave via `ulnas<ID>`, and the host default route must equal the pre-dial snapshot. Otherwise the tunnel is torn down with `route_violation`. |
| P11 | MEDIUM | No rollback for the NAS side; the existing `rollback()` is a no-op | Requirement not met. | Snapshot of the original server settings (encrypted) is saved. Automatic restore if read-back fails. `POST …/nas/rollback` endpoint. |
| P12 | MEDIUM | No cross-process lock (7 PM2 workers) | Two workers could dial the same NAS at once. | Atomic `updateMany` lock (`clientLockUntil`) that expires and can be taken over after a crash. |
| P13 | MEDIUM | Migration uses `TIMESTAMPTZ` where Prisma `DateTime` maps to `TIMESTAMP(3)` | Schema drift. | `TIMESTAMP(3)`. The migration is renamed to `20261121090000_…` so it sorts after the migrations already applied. |
| P14 | MEDIUM | Nothing stops two NAS using the same tunnel peer address | Two identical /32 routes, so one NAS becomes unreachable. | Unique index on `remoteAddress`, giving 409 on save. |
| P15 | LOW | No PPP-auth failure detection; vague retry | Unhelpful errors, and retrying with wrong credentials keeps hitting the NAS. | Error codes: `ipsec_auth_failed`, `ipsec_proposal_mismatch`, `nas_unreachable`, `ppp_auth_failed` (from the per-NAS pppd log), `address_mismatch`, `route_violation`, `timeout`, `tooling_missing`, `invalid_config`. No retry on auth, proposal, route or address errors. |
| P16 | — | Frontend `nas-vpn-panel.tsx` rewrite | Out of Phase 1 scope. | **Not applied.** |
| P17 | — | Patch's own specs | They tested the defective behaviour (for example `add`/`connect` verbs and the `ppp0` regex). | Replaced by new specs. |

Kept from the patch: the overall split (dialer + service + endpoints), encrypted-at-rest columns, masked views, and verifying the NAS by read-back.

---

## 2. Files changed and why

| File | Change |
|---|---|
| `backend/src/nas/l2tp-client-dialer.service.ts` | **New.** Host dialer: validation, swanctl and pppd config rendering, `add-lac`/`connect-lac`, live NAS-specific status, route and default-route verification, teardown, purge, error classification. |
| `backend/src/nas/nas-l2tp-client.service.ts` | **New.** Save and masked view, NAS preview/apply/verify/rollback over the RouterOS API, connect/disconnect/reconnect/status with a cluster lock, host purge. |
| `backend/src/nas/nas-l2tp-client.controller.ts` | **New.** Endpoints (below), guarded by `JwtAuthGuard` + `PermissionsGuard` (`nas.read` / `nas.write`), with `ParseIntPipe` on ids. |
| `backend/src/nas/nas-l2tp-config.service.ts` | **+9 lines.** Public `assertNasAccess()`, which delegates to the existing private `ensureAccess` (tenant scope + NAS owner or platform owner). The rule stays in one place. No other change. |
| `backend/src/nas/nas.module.ts` | Registers the new controller, service and dialer. |
| `backend/prisma/schema.prisma` | New `NasL2tpConfig` columns (§3). |
| `backend/prisma/migrations/20261121090000_nas_l2tp_client/migration.sql` | **New.** Additive migration. |
| `backend/src/nas/l2tp-client-dialer.spec.ts` | **New.** 28 mocked tests. |
| `backend/src/nas/nas-l2tp-client.service.spec.ts` | **New.** 37 mocked tests. |

**Not changed:** WireGuard (`tunnel.service.ts`), SSTP, `vpn.service.ts` (including its legacy inverted L2TP installer text; see §6), subscriber auth and RADIUS, the existing `l2tp-config` draft/approve/apply flow, the frontend, `install.sh` and `update-jointbox.sh`.

### Endpoints (all under `/nas/:id/l2tp-client`)

| Method | Path | Action |
|---|---|---|
| GET | `` | Masked settings view (`hasIpsecPsk` and `hasPppPassword` flags only) |
| PUT | `` | Save settings (validated; secrets encrypted; refused while connected) |
| GET | `/status` | Live host status for this NAS; stored state is corrected from it |
| POST | `/nas/preview` | Read-only plan of NAS changes and conflicts (no writes) |
| POST | `/nas/apply` | Configure the L2TP server and the dedicated PPP secret, confirmed by read-back. Body `{ "confirmServerChange": true }` is required to replace a running server's different IPsec secret |
| POST | `/nas/rollback` | Disconnect, remove Uplinko's secret, restore the original server settings |
| POST | `/connect`, `/disconnect`, `/reconnect` | Tunnel lifecycle |
| DELETE | `/host` | Tear down and delete this NAS's host config files |

---

## 3. Database and schema changes

Additive only. Migration `20261121090000_nas_l2tp_client` on `nas_l2tp_config`:
- `pppUsername` VARCHAR(64)
- `pppPasswordEnc` VARCHAR(512), encrypted
- `localAddress` VARCHAR(45): Uplinko tunnel IP
- `remoteAddress` VARCHAR(45), **unique**: NAS tunnel IP
- `connectTimeoutSec` INT, default 30
- `retryCount` INT, default 1
- `retryDelaySec` INT, default 5
- `clientState` VARCHAR(24), default 'disconnected'
- `clientLockUntil`, `lastDialAt`, `lastConnectedAt`, `lastDisconnectedAt`, `nasAppliedAt`: TIMESTAMP(3)
- `tunnelInterface` VARCHAR(15)
- `lastClientErrorCode` VARCHAR(40), `lastClientError` VARCHAR(512)
- `nasSnapshotEnc` TEXT, encrypted

The IPsec PSK reuses the existing encrypted `ipsecPskEnc`, so there is no second source of truth.

The migration SQL is hand-written to match the schema. `prisma migrate diff` could not run here because the schema engine download is blocked, so run `prisma migrate diff --from-migrations … --to-schema-datamodel …` against a scratch database before release (§7). **No migration was run against any database.**

---

## 4. Security and routing design

**Secrets**
- PSK, PPP password and the rollback snapshot are encrypted with the existing `SecretsService`.
- API responses expose only `hasX` flags. The preview shows the password as `********`.
- Logs contain the NAS id, state and error code only.
- On the host, the PSK is stored base64-encoded (`0s…`) in a 0600 file; the pppd options file is 0600 inside a 0700 directory.
- No secret is ever passed as a command argument (a test asserts this).

**Commands**
- `execFile` with argv arrays only; there is no shell.
- The only binaries invoked are `which`, `test`, `swanctl`, `xl2tpd-control` and `ip`.
- Every value is validated first: NAS public host must be a routable IPv4 literal, tunnel IPs must be IPv4, the PPP user is `[A-Za-z0-9._@-]{3,64}`, and the profile name is restricted.
- No network scanning.

**Authorization**
- `nas.read` / `nas.write` through the existing `PermissionsGuard`; the AUDITOR read-only floor applies.
- Then `assertNasAccess`: tenant scope plus NAS owner or platform owner, checked before any database write, device call or host command (covered by tests).

**Per-NAS isolation**

| Item | Value |
|---|---|
| strongSwan connection | `uplinko-nas-<ID>` |
| PSK | bound to that NAS's IP |
| xl2tpd LAC | `uplinko-nas-<ID>` |
| pppd interface | `ulnas<ID>` |
| pppd log | `/etc/uplinko/l2tp/uplinko-nas-<ID>.log` |
| NAS tunnel address | unique per host |

Teardown of one NAS issues commands for that NAS only (covered by a test).

**Routing**
- pppd uses `nodefaultroute`, without `usepeerdns`, so the only route it adds is the /32 to the NAS tunnel IP.
- "Connected" additionally requires that `ip route get <NAS tunnel IP>` leaves via `ulnas<ID>` and that the host default route is unchanged from before the dial. Otherwise the tunnel is torn down.
- Management traffic should target the NAS **tunnel** address. IPsec and L2TP themselves still go to the NAS public IP over the normal default route.

**"Connected" means verified**, read live each time:
1. This NAS's IKE SA is `ESTABLISHED`.
2. `ulnas<ID>` is UP.
3. Its addresses equal the configured pair.
4. The route check passes.
5. The default route is unchanged (checked during the dial).

Saved configuration never sets `connected`. `GET /status` overwrites a stale stored "connected" with the live result.

**NAS side**
- Uses the existing RouterOS API client to the NAS management IP (`nasIp`, the bootstrap path).
- It is idempotent: it updates only the Uplinko-marked secret.
- Every attribute is read back, and the IPsec secret is compared on the router side and never returned.
- If the read-back fails, the settings from before the call are restored. The snapshot of the original settings is kept for a later rollback.

---

## 5. Tests run (actual commands and results)

Environment: an isolated copy of `af61caa` with the Phase 1 files added. The Prisma client was generated **offline** for the new schema (types only). Prisma query-engine binaries are blocked here, so suites needing a real Prisma engine cannot run (same as baseline).

| Command | Exit | Result |
|---|---|---|
| `prisma generate` (offline, schema only) | 0 | Client generated for the new schema (also confirms the schema parses) |
| `tsc --noEmit -p backend/tsconfig.json`, baseline (before) | 2 | 6 errors in `field-job-reports.service.ts`, `ticket-sla.service.ts`, `tickets-tenancy.spec.ts` |
| same, after | 2 | **The same 6 errors, no new ones** |
| `jest src/nas/l2tp-client-dialer.spec.ts` | 0 | **28 passed** (mocked host) |
| `jest src/nas/nas-l2tp-client.service.spec.ts` | 0 | **37 passed** (mocked Prisma, RouterOS and dialer) |
| `jest src/nas/` | 1 | 207 passed. 1 suite failed: `nas.module.spec.ts`, "Prisma could not locate the Query Engine". This is environmental and the same at baseline. |
| Full `jest`, baseline | 1 | 1,459 passed, 21 failed, 10 suites failed |
| Full `jest`, after | 1 | 1,524 passed, 21 failed, **the same 10 suites** (no new failures; +65 tests) |
| `nest build` + `node scripts/check-di.js` | 0 / 0 | "✓ backend wiring check passed". The new providers resolve in the full app graph. |
| `eslint` on the 5 new files | 1 | 0 formatting errors after `prettier`. What remains is the codebase-wide `no-unsafe-*` / `require-await` pattern from `any`-typed Prisma calls (the existing `nas-l2tp-config.service.ts` has the same 151 problems) and 2 `no-base-to-string` in string helpers. Not blocking; listed for cleanup. |
| Mutation checks (temporarily breaking code, then restoring it) | — | Removing the default-route check and switching to `defaultroute` → 2 dialer tests fail. Removing the secret-conflict check, swapping address mapping and dropping the auto-restore → 6 service tests fail. The tests detect these regressions. |

Coverage by requirement (**all mocked**):

| Requirement | Mocked test coverage |
|---|---|
| Encryption and masking | Yes |
| Tenant and role authorization | Yes, for all 10 operations |
| Configuration validation | Yes |
| Connect, disconnect, reconnect | Yes |
| Failed authentication (IPsec PSK, PPP) | Yes |
| IPsec proposal mismatch, NAS unreachable with bounded retries | Yes |
| Timeout | Yes |
| Multiple independent NAS (separate names, interfaces, teardown; one failing does not affect another) | Yes |
| Route isolation and default-route preservation | Yes |
| NAS apply: conflict, confirmation, read-back failure → auto-restore | Yes |
| Rollback | Yes |
| Simulated or stored state never reports Connected | Yes |

**Not tested at all:** real strongSwan, xl2tpd and pppd on Linux; a real MikroTik (RouterOS 6 or 7); NAT traversal; real database migration.

---

## 6. Remaining risks and limitations

1. **Interoperability is unproven.** The swanctl proposals (IKEv1 PSK, aes/3des-sha1, modp2048/1024, ESP without PFS) target RouterOS's default `l2tp-server use-ipsec` peer. A real NAS may need adjustment.
2. **RouterOS API fields.** Apply checks `ipsec-secret` and `password` by reading them back. If an API user lacks the "sensitive" policy, `ipsec-secret` may not be returned. Apply then **fails closed** (reports not confirmed and restores).
3. **Privileges.** The backend must write `/etc/swanctl/conf.d` and `/etc/uplinko/l2tp` and run `swanctl` and `xl2tpd-control`. This works when PM2 runs as root (the current installs do). A non-root deployment needs a narrowly scoped helper, which is not built.
4. **Host packages are not installed by the installer** (out of scope: no production config changes). See §7.
5. **No automatic reconnect monitor.** Reconnect is on demand (`/reconnect`). `GET /status` detects drops. A background watchdog is a later phase.
6. **Hostnames are not accepted** for the NAS public address (IPv4 only), so PSK selection by address stays deterministic.
7. **Rollback scope.** It restores the L2TP-server settings from the first apply and removes the Uplinko-marked secret under the *current* username. If the username was changed after an apply, the old marked secret must be removed by hand.
8. **The legacy L2TP installer text in `vpn.service.ts` is still inverted** (panel as server). It was left untouched as an existing feature. It should be removed or relabelled in Phase 2 so it cannot be confused with this flow.
9. **No frontend yet** (Phase 2). The existing NAS VPN panel keeps using the old `l2tp-config` endpoints.
10. **Interface name limit.** `ulnas<ID>` stays within Linux's 15-character limit for NAS ids up to 10 digits.

---

## 7. Manual Linux and MikroTik integration steps

Use a **test** Uplinko server and a **test** MikroTik. Do not do this on production.

**A. Uplinko test host (Ubuntu 22.04/24.04, as root)**
```bash
apt-get install -y strongswan-swanctl charon-systemd xl2tpd ppp
systemctl enable --now strongswan xl2tpd   # or strongswan-swanctl, depending on the distro
cat /etc/swanctl/swanctl.conf | grep -n 'include conf.d'   # must include conf.d/*.conf
test -S /var/run/xl2tpd/l2tp-control && echo "xl2tpd control socket OK"
ip -4 route show default > /root/default-route.before
```
Allow outbound UDP 500, 4500 and 1701. If the host is behind NAT, NAT-T (UDP 4500) is used automatically.

**B. Deploy the branch to the test host**
```bash
cd /opt/jointbox/backend
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL"   # must report no difference
npm run db:deploy
npm run build && node scripts/check-di.js
```

**C. MikroTik test NAS:** give the API user `api,read,write,sensitive` policy. Note the current L2TP server settings with `/interface l2tp-server server print`.

**D. Through the API**, as the NAS owner. Replace `$T` with the token and `7` with the NAS id.
```bash
curl -X PUT  /nas/7/l2tp-client -d '{"publicHost":"<NAS public IPv4>","pppUsername":"uplinko-mgmt","pppPassword":"<8+ chars>","ipsecPsk":"<8+ chars>","localAddress":"10.255.7.2","remoteAddress":"10.255.7.1"}'
curl -X POST /nas/7/l2tp-client/nas/preview     # check serverChanges / requiresConfirmation
curl -X POST /nas/7/l2tp-client/nas/apply       # add {"confirmServerChange":true} only if you accept the warning
curl -X POST /nas/7/l2tp-client/connect         # expect state=connected, interface=ulnas7
curl      /nas/7/l2tp-client/status
```

**E. Verify on the host**
```bash
swanctl --list-sas --ike uplinko-nas-7          # ESTABLISHED
ip -o addr show dev ulnas7                      # inet 10.255.7.2 peer 10.255.7.1/32
ip route get 10.255.7.1                         # … dev ulnas7
diff <(ip -4 route show default) /root/default-route.before && echo "default route unchanged"
ping -c3 10.255.7.1
```

**F. Verify on the MikroTik**
- `/ppp active print`: `uplinko-mgmt`, service `l2tp`.
- `/ppp secret print where comment=uplinko-mgmt-vpn`: exactly one secret.
- `/ip ipsec active-peers print`: the Uplinko address.

**G. Failure cases** (each must give the matching `errorCode` and leave no `ulnas7` interface or SA behind):

| Change | Expected `errorCode` |
|---|---|
| Wrong PSK on the NAS | `ipsec_auth_failed` |
| Wrong PPP password | `ppp_auth_failed` |
| Block UDP 500 | `nas_unreachable` |
| Change the NAS secret's `local-address` | `address_mismatch` |
| Reboot the NAS while connected | `GET /status` shows `disconnected`, then `/reconnect` restores it |

**H. Two NAS at once:** configure a second NAS (for example 10.255.8.1/2). Both connect, `ulnas7` and `ulnas8` both exist, and disconnecting 7 leaves 8 up.

**I. Rollback:** `POST /nas/7/l2tp-client/nas/rollback`. `/interface l2tp-server server print` must match the settings noted in C, and the marked secret must be gone.

---

## 8. Explicit status

**NOT VERIFIED against a real MikroTik.** The backend is implemented and covered by **mocked** tests only. It is not production-ready until §7 A–I passes on real equipment. Nothing was committed, pushed, deployed or migrated.
