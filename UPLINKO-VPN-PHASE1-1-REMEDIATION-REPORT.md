# Uplinko NAS Management VPN — Phase 1.1 Security Remediation Report

**Scope:** backend only. No frontend change. No real router, real tunnel, production server, shared database, deploy, commit or push. Every test below is a unit test or simulation, labelled as such.

**Disclosure:** I implemented Phase 1 and this remediation. I treated the findings of `UPLINKO-VPN-PHASE1-INDEPENDENT-AUDIT.md` as authoritative.

## 1. Starting state

| Item | Value |
|---|---|
| HEAD / branch | `af61caa5c2bb7a94e40d1a9b7db90e4f968cf618` / `main` (equal to `origin/main`) |
| Pre-existing user changes (preserved) | `backend/prisma/seed.ts`, `backend/src/prisma/prisma.service.ts` (CRLF only), the three earlier report files |
| Phase 1 files at start | Byte-identical to the audited version (SHA-256 prefixes `69d2236b…` dialer, `16b500aa…` service, `51e52a23…` migration) |
| `nas.service.ts` | Unchanged against HEAD before editing (`git diff --quiet`) |
| Baseline | `tsc`: 6 errors (`field-job-reports.service.ts` ×3, `ticket-sla.service.ts` ×2, `tickets-tenancy.spec.ts` ×1). Full Jest: 10 failing suites / 21 failing tests, all from the environment (no Prisma query engine, no DNS) or failing already before Phase 1. |

## 2. Files changed

Line numbers refer to the files as they are on disk after formatting.

| File | Status | Why |
|---|---|---|
| `backend/src/nas/routeros-mgmt-applier.ts` | **new** | RouterOS apply/restore engine. Treats each secret as known-empty, known-value or unknown; requires the API user's `sensitive` policy; persists the snapshot before any change; restores and verifies after a failure at any step; checks for stale changes before rollback; installs the firewall guard. |
| `backend/src/nas/l2tp-address-policy.ts` | **new** | Server-side address policy (pure functions) and parser for the host network inventory (`ip -j`). |
| `backend/src/nas/nas-l2tp-client.service.ts` | rewritten | Address policy at save, connect and apply; uses the applier; renewable owner-token lease; background connect/reconnect with operation id; cancel; disconnect no longer releases another operation's lock; separate management columns; NAS-deletion cleanup. |
| `backend/src/nas/l2tp-client-dialer.service.ts` | modified | ESP/CHILD_SA and kernel XFRM proof before "connected"; `parseSwanctlSas`; cancellation; verified `purge`; `inventory()`. |
| `backend/src/nas/nas-l2tp-client.controller.ts` | modified | `POST /nas/:id/l2tp-client/cancel` added. |
| `backend/src/nas/nas.service.ts` | modified (+22/−3) | `remove()` stops and removes this NAS's host tunnel first and refuses the delete if that cannot be verified (`:721`). `ConflictException` is passed through with its message (`:798`). The dependency is optional only so the existing hand-built unit tests still compile. |
| `backend/prisma/schema.prisma` | modified | Management columns kept apart from the legacy ones; lease and operation columns; apply state. |
| `backend/prisma/migrations/20261121090000_nas_l2tp_client/migration.sql` | **modified** | Justification: this migration is uncommitted and has never been applied anywhere, and it had a concrete defect (it shared `publicHost`, `ipsecPskEnc` and `state` with the legacy flow; audit M-5). It remains additive only. |
| `backend/src/nas/nas-vpn-fakes.testkit-spec.ts` | **new (test kit)** | `FakeRouter` (RouterOS model with the sensitive policy, firewall evaluation, fault injection, L2TP login model) and `FakeDb`. |
| `backend/src/nas/routeros-mgmt-applier.spec.ts` | **new** | 48 simulation tests |
| `backend/src/nas/l2tp-address-policy.spec.ts` | **new** | 27 unit tests |
| `backend/src/nas/nas-delete-vpn-cleanup.spec.ts` | **new** | 3 unit tests |
| `backend/src/nas/l2tp-client-dialer.spec.ts` | updated | Realistic `swanctl --list-sas` and `ip xfrm` fixtures, plus 15 new tests (43 total) |
| `backend/src/nas/nas-l2tp-client.service.spec.ts` | rewritten | 39 simulation tests for the new contract |

Not changed: frontend, WireGuard (`tunnel.service.ts`), SSTP, `vpn.service.ts`, FreeRADIUS/RADIUS, subscriber authentication, the legacy `l2tp-config` flow, `install.sh` and `update-jointbox.sh`.

## 3. Blocking defects: before and after

### C-1 CRITICAL — the router's IPsec secret was overwritten and then wiped

**Before**
- `readServer` mapped a missing `ipsec-secret` to `''`, so the "affects others" check was false.
- The key was overwritten without confirmation, and the "restore" then wrote `''` and reported success.
- Audit reproduction R1 ended with `final device key=""`.

**After** (`routeros-mgmt-applier.ts`)
- `hasSensitivePolicy()` (`:164`) passes only when the API user's group policy explicitly contains `sensitive`.
- `readServer()` (`:179`, `:205`) returns the secret as known or unknown. A missing field is unknown, never `''`.
- `preflight()` refuses with `sensitive_policy_missing` (`:342`) or `secret_unreadable` (`:349`, `:362`) **before any write**.
- Replacing a running server's different key needs `confirmServerChange` (`:400–410`), and the old key is kept in the snapshot.
- Restore only writes values that were actually read, and reports `restored` only when the read-back matches (`:650–`). If the key is unreadable at restore time, the outcome is `failed` with "manual intervention required".

**Evidence** (`routeros-mgmt-applier.spec.ts`)
- *"audit scenario: API user without sensitive…"*: refused, 0 mutations, key `Customers-Key-99` unchanged, no "restored" in the result.
- *"hidden secret shown as an EMPTY value"*: refused.
- *"policy granted but the field is still missing"*: refused.
- *"existing key on a disabled server is preserved…"* and *"explicit replacement…"*: the original key is restored exactly.
- *"failed read-back"*: restored.
- *"rollback when the router cannot be reached"* and *"key becomes unreadable later"*: `failed`, never `restored`.
- Service level: *"API user without sensitive: 400, router untouched, no false restore claim"*.

**Mutation checks**
- Forcing the policy check to pass: 2 tests fail.
- Mapping an unknown secret to `''`: 2 tests fail.

### H-1 HIGH — "Connected" did not prove the traffic was encrypted

**Before:** only the IKE `ESTABLISHED` state was checked. Apply set `use-ipsec=yes`. Reproduction R3 (an IKE SA with no CHILD_SA) was reported as connected.

**After** (`l2tp-client-dialer.service.ts`)
- `status()` calls `verifyEncryption()` (`:795`) before reporting connected. It requires all of the following:
  - the IKE SA for `uplinko-nas-<ID>` is `ESTABLISHED`, with its remote host equal to the NAS public IP;
  - a CHILD_SA of the same name that is `INSTALLED`, in `TRANSPORT` mode (`-in-UDP` accepted), protocol `ESP`, with a non-NULL cipher;
  - traffic selectors `<ip>/32[udp/1701|l2f|l2tp]` locally and towards the NAS IP;
  - kernel state from `ip xfrm state list dst <NAS IP> proto esp` (`:853`) showing `proto esp` and `mode transport`.
- Anything missing, unexpected or truncated gives `encryption_unverified` (`:784`). The dialer tears down and does not retry.
- `status()` without the NAS public IP cannot prove encryption and reports an error.
- RouterOS is set to `use-ipsec=required`. On a running server whose setting is not `required`, this needs confirmation (it affects other clients).

**Parsing basis:** `parseSwanctlSas` (`:897`) follows the strongSwan 5.x `src/swanctl/commands/list_sas.c` layout, which is documented in the code. This layout is **not verified against a real host**. It fails closed: an unrecognised layout means "not connected".

**Evidence** (`l2tp-client-dialer.spec.ts`, realistic fixtures): IKE without CHILD_SA, unrelated CHILD_SA, wrong peer, wrong traffic selectors, no XFRM state, CHILD_SA in `REKEYING`, NULL cipher and truncated output are all `encryption_unverified`, never connected, with the tunnel torn down. *"expected ESP transport SA"* is connected. A parser fixture test covers the format.

**Mutation check:** bypassing `verifyEncryption`: 9 tests fail.

### H-2 HIGH — a failed apply left the router modified

**Before:** an exception after `server/set` skipped restore, and no snapshot was saved (R2: `enabled=yes`, key replaced).

**After** (`routeros-mgmt-applier.ts`)
- The snapshot is validated and **persisted before the first mutation** (`:498`). If persistence fails, the result is `snapshot_persist_failed` and nothing changes.
- Mutation order: firewall guard → IPsec settings and key → authentication → PPP secret → **enable last**.
- `mutating = true` is set *before* each call (`:510`), so an API drop right after the router applied a change still triggers a restore.
- Restore runs on a **fresh API session** in reverse order: disable first, then secret, authentication, IPsec, guard. It is verified by read-back.
- Outcomes:

  | Restore result | Apply state |
  |---|---|
  | `restored` | `apply_failed_restored` |
  | `partial` | `apply_failed_partially_restored` |
  | `failed` | `apply_failed_not_restored` (shown to the user as "manual intervention required") |

- A failed re-apply restores the state from just before *that* call (`callState`), while keeping the original long-term rollback point.

**Evidence** (`routeros-mgmt-applier.spec.ts`), for each of the 8 mutations (4 firewall adds, IPsec/key, authentication, secret add, enable) × 3 modes:
- API drops after the step and the router comes back: `restored`, and the router state is deep-equal to before.
- Router rejects the step: `restored`, deep-equal to before.
- API drops and the router stays down: `failed` plus "manual intervention".

Also covered: API error during the final read-back (restored), snapshot persistence failure (0 mutations), snapshot persisted with 0 mutations so far, and idempotent second rollback (0 extra mutations).

**Mutation check:** skipping restore: 8 tests fail.

### H-3 HIGH — tunnel and endpoint addresses were unrestricted

**Before:** any unicast IPv4 was accepted (R5: `8.8.8.8`, `192.168.1.1`, private endpoint).

**After:** `l2tp-address-policy.ts`, `checkAddressing` (`:139`), called from the service under a Postgres advisory lock (`:378`) at save, and again at connect and apply (`assertAddressing`, `:190`).

**Tunnel addresses must be:**
- inside `L2TP_MGMT_POOL` (default `10.255.0.0/16`, which must be RFC 1918, /8–/29);
- not the pool's network or broadcast address;
- not protected (`L2TP_PROTECTED_CIDRS`);
- not a host address, gateway or connected network;
- not any other NAS's local or remote tunnel address (any tenant);
- not any known NAS address.

**Endpoint must be:**
- an IPv4 literal (no hostnames);
- not a special-purpose range (0/8, 127/8, 169.254/16, 100.64/10, 192.0.0/24, documentation ranges, 198.18/15, 224/4, 240/4);
- not private, unless the platform sets `L2TP_ALLOW_PRIVATE_ENDPOINTS=true`;
- not in the pool, protected, host-owned, the gateway, or used by another NAS.

**Fail closed:**
- unreadable or unparsable host inventory (`ip -j -4 addr` / `route`);
- the pool overlapping a host network;
- a malformed policy.

**Database backstop:** unique indexes on `mgmtPublicHost`, `localAddress` and `remoteAddress`. `UPLINKO_PUBLIC_IP` is validated by the same policy.

**Evidence**
- `l2tp-address-policy.spec.ts` (27 tests): `8.8.8.8`, `192.168.1.1`, private endpoint, host gateway, host interface, overlap with another NAS tunnel (local and remote side), duplicate endpoint, licence/protected address, fail-closed inventory, pool overlap, valid pool addresses accepted.
- Service spec: rejected **before** any database row, router call or dial; cross-tenant overlap through two service instances; re-check at connect.

**Mutation check:** removing the pool check: 3 tests fail.

## 4. `service=any` protection and the firewall guard

**RouterOS semantics relied on (an assumption, verify on hardware):**
- An L2TP server authenticates any `/ppp secret` whose service is `l2tp` or `any`. The server has no per-user filter, so a dedicated username alone does **not** protect anything. This is why the guard exists.

**Protection (three independent layers):**
1. `use-ipsec=required`, plus a PSK that only Uplinko holds. On a running server, replacing the PSK needs explicit confirmation.
2. A firewall guard: four `input` rules placed **first** (`guardRules`, `:249`), commented `uplinko-mgmt-vpn guard nas=<id> rule=<k>`:
   - accept UDP 500,4500 from `UPLINKO_PUBLIC_IP`
   - accept `ipsec-esp` from `UPLINKO_PUBLIC_IP`
   - accept UDP 1701 from `UPLINKO_PUBLIC_IP` with `ipsec-policy=in,ipsec`
   - **drop UDP 1701 from everyone else**
3. Enable last, only after the guard and IPsec are in place.

**Not affected:** PPPoE, RADIUS and other IPsec peers. Only UDP 1701 is dropped; IKE and ESP from other sources are not filtered. No customer secret is read for writing, changed or removed.

**Safety checks:**
- The guard is verified by read-back: exact properties, enabled, each rule exactly once, and the first input rules.
- Re-apply does not duplicate rules.
- Rollback removes them, unless they were already present at the snapshot.
- If the firewall cannot be read, apply refuses with no changes. If the guard cannot be verified in place (the router ignored the ordering), apply fails and restores.
- Without `UPLINKO_PUBLIC_IP`, apply refuses with no changes.

**Evidence** (`FakeRouter.canL2tpLogin` models firewall → IPsec requirement → secret):

| Login attempt | Result |
|---|---|
| Uplinko account, from the Uplinko IP, with the PSK | allowed |
| `service=any` customer from the internet, without the PSK | **denied** |
| `service=any` customer from the internet, with a leaked PSK | **denied** |
| `service=any` customer from the Uplinko IP, without the PSK | **denied** |

Customer secrets, the PPPoE server and admin rules are deep-equal to before.

**Mutation check:** skipping the guard: 16 tests fail.

**Effect to know about:** on a NAS whose L2TP server was already serving others, applying (after confirmation) makes it Uplinko-only. This is stated in the confirmation reasons.

## 5. Medium issues

| ID | Status | Remediation and evidence |
|---|---|---|
| A — disconnect cleared the lock | **Fixed** | `disconnect()` (`:875`) acquires its own lease. If another operation holds it, disconnect only sets `clientCancelRequested` and returns `state: cancelling`. `release()` (`:267`) updates only `where clientLockOwner = <own token>`. Tests: *"disconnect during a running connect (other worker) does NOT release the lease"*. *"an old operation finishing after a takeover never clears the new owner's lease"* — mutation check: dropping the owner condition makes 1 test fail; making disconnect clear the lease makes 1 test fail. |
| B — lock expired during the dial | **Fixed** | Renewable lease: TTL 45 s, renewed every 15 s by the owning process, with an owner token. If renewal fails, `lost` is set; the dial's `shouldCancel` then stops it and its result is discarded. An expired lease (crashed worker) is taken over. Tests: renewal extends expiry; crashed-worker takeover; lost lease aborts and is discarded. |
| C — long HTTP request | **Fixed** (contract change) | `POST /connect` and `/reconnect` now return at once with `{accepted, operationId, state:'connecting', statusUrl}`. `GET /status` shows `operation {id, kind, startedAt, cancelRequested}`. New `POST /cancel`. `POST /nas/apply` stays synchronous; its RouterOS calls are bounded by a 12 s socket timeout. No frontend uses these endpoints yet. |
| D — stale rollback | **Fixed** | `restore(requireNoForeignChange)` (`:677–742`): every managed item must equal either the snapshot or what Uplinko applied (stored encrypted in `mgmtDesiredEnc`); otherwise rollback is refused with no changes and "manual intervention required". After an interrupted apply (no desired record), rollback is refused. Tests: key rotated, authentication changed, secret edited, guard rule edited → refused, 0 mutations. Mutation check: removing the check makes 4 tests fail. |
| E — shared legacy fields | **Fixed** | New `mgmtPublicHost`, `mgmtIpsecPskEnc`, `mgmtApplyState`, `mgmtSnapshotEnc`, `mgmtDesiredEnc`. The management flow never writes `publicHost`, `ipsecPskEnc` or `state`. Test: legacy values and `state='approved'` unchanged after save and apply. |
| F — tunnel not used for router access | **Deferred (documented)** | See below. Every view and status now says `tunnelUsedForRouterAccess: false`. |
| G — NAS deletion orphans | **Fixed (host side)** | `NasService.remove` calls `cleanupForNasDeletion` (`nas-l2tp-client.service.ts:1011`) before the delete transaction. It refuses while an operation runs (and asks it to stop), purges only this NAS (SA, LAC, interface, files) and verifies with `purge()` → `{clean, remaining}`. If cleanup fails, the NAS is **not deleted** (409 with a reason). Router-side Uplinko settings are not removed (the router may be unreachable). The delete response includes a warning when they were applied. Tests: `nas-delete-vpn-cleanup.spec.ts` (3), plus service tests. |

**Plan for F (router access over the tunnel).** The current call paths all build `host = nas.nasIp`:
- `NasL2tpClientService.nasApi` (apply and rollback)
- `MikrotikSyncService` (live data, neighbours, pools)
- `NasService` probes
- `mikrotik.client.ts withMikrotik`

Required phase:
1. Add a per-NAS `managementHost` resolver that returns `remoteAddress` only while the dialer's live `status()` is `connected` (ESP verified), and `nasIp` otherwise.
2. Use it in the RouterOS call sites one at a time, behind a per-NAS opt-in flag.
3. Never use the tunnel for apply/rollback bootstrap.
4. Tests must prove that NAS A's resolution never affects NAS B, and that the fallback is used when the tunnel is down.

This was not implemented here because it touches unrelated live-data paths.

## 6. Tests and checks (actual commands; isolated copy of the working tree, byte-identical to what was written to `F:\Jointbox panel`)

| Check | Command | Exit | Result |
|---|---|---|---|
| Prisma generate (offline, schema only) | `prisma generate` with local engine overrides | 0 | Generated, so the schema parses |
| TypeScript | `tsc --noEmit -p tsconfig.json` | 2 | **6 errors, the same 6 as the baseline, none new** |
| Nest build | `npx nest build && node scripts/flatten-dist.js` | 0 | OK |
| DI wiring | `node scripts/check-di.js` | 0 | "✓ backend wiring check passed" (includes `NasService` → `NasL2tpClientService`) |
| New/updated specs | `jest src/nas/<file>.spec.ts` | 0 each | address-policy **27/27**, applier **48/48**, dialer **43/43**, service **39/39**, delete-cleanup **3/3**: **160 tests** |
| All NAS/VPN suites | `jest src/nas/` | 1 | 17 suites pass. `nas.module.spec.ts` fails with "Prisma could not locate the Query Engine" (environmental, same as baseline) |
| Full backend suite | `jest` (all) | 1 | **1,619 passed / 21 failed; the 10 failing suites are identical to the baseline** (diffed); +160 tests vs. baseline |
| ESLint (changed/new files) | `eslint …` | 1 | No formatting errors after `prettier`. What remains is the codebase-wide `no-unsafe-*` / `require-await` pattern from `any`-typed Prisma and RouterOS rows, and 2 `no-base-to-string`. Not blocking; listed for cleanup. |
| Mutation checks | protection removed → tests re-run → code restored | — | M1a 2 fail · M1b 2 fail · M2 9 fail · M3 8 fail · M4 3 fail · M5 16 fail · M6 1 fail · M6b 1 fail · M7 4 fail. M8 (advisory lock removed): **0 fail**, because the fake DB cannot model real concurrency (see §8). |
| Migration | disposable PostgreSQL 16 (local, trust auth, port 55433, stopped afterwards) | 0 | 67 earlier migrations, then 3 legacy rows, then the new migration applied. Legacy `state/publicHost/ipsecPskEnc` kept; defaults correct; unique indexes `mgmtPublicHost`, `localAddress`, `remoteAddress` created and enforced (duplicate rejected). |

**The original 65 Phase 1 tests:** the dialer tests (28) still pass on updated realistic fixtures. Their single changed assertion now passes `server` to `status()`, which is required to prove encryption. The service spec was rewritten for the new contract (async connect, management columns); its old guarantees are re-asserted there.

**Note:** `nest build` (SWC) already copies 38 existing `*.spec` files into `dist/`, ignoring `tsconfig.build.json`'s exclude. The new test kit follows the same pre-existing behaviour.

## 7. Security considerations

- **Secrets:** AES-256-GCM via `SecretsService`. They never appear in responses (the `NEVER_RETURNED` scan), exceptions or logs (the applier test checks the result JSON for the PSK, PPP password and old key). Snapshot and desired state are encrypted.
- **Root operations:** argv-only `execFile`. New commands: `ip -j -4 addr show`, `ip -j -4 route show table main`, `ip xfrm state list dst <validated IPv4> proto esp`. No user-controlled strings reach the host beyond validated IPv4 literals and integer ids.
- **Authorization:** `assertNasAccess` runs first in all 11 operations (test-asserted, including `cancel`), and NAS deletion keeps its owner check.

## 8. Remaining limitations and assumptions (not verified)

1. **strongSwan output layout** (`list_sas.c`), service port naming (`l2f`), and `ip xfrm` output. The parser fails closed if they differ, so the risk is that connections fail, not that encryption is falsely claimed.
2. **RouterOS behaviour:**
   - API field names: `use-ipsec`, `ipsec-secret`, `authentication`, `ipsec-policy=in,ipsec`, `place-before`, the `=ret=` id returned by add.
   - Booleans printed as `true/false`.
   - Hidden sensitive fields: both omission and empty values are handled by the policy check.
   - L2TP secret matching (`l2tp`/`any`).
3. **The `FakeRouter` login model is a simulation of RouterOS, not RouterOS itself.**
4. **`UPLINKO_PUBLIC_IP` must be the address the NAS actually sees.** If it is wrong, rule 4 drops Uplinko's own L2TP and connect fails with `timeout`. The RouterOS API (TCP 8728) is not filtered, so rollback still works.
5. **Postgres advisory lock for cross-column address claims:** standard PostgreSQL semantics, but **not exercised against a real database** here. Same-column duplicates are additionally blocked by unique indexes (verified on the disposable database).
6. **A NAS behind 1:1 NAT** that sends its private identity can still fail IKE (`remote id = <public IP>`). Unchanged from Phase 1.
7. **Router access does not use the tunnel** (medium issue F, deferred).
8. **Router-side settings remain after NAS deletion** (warning only).
9. **`POST /nas/apply` is synchronous**, bounded by RouterOS socket timeouts.

## 9. Real-hardware tests still required (isolated test MikroTik with no customers, test Uplinko host)

1. Run `swanctl --list-sas` and `ip xfrm state` on the real host and compare them with the parser fixtures. Confirm the dialer reports connected only with ESP installed, and `encryption_unverified` when the CHILD_SA is removed (`swanctl --terminate --child`).
2. Test an API user **without** `sensitive` on RouterOS 6 and 7: confirm the refusal and that the router is unchanged.
3. Full apply on a disabled server: four guard rules on top, `use-ipsec=required`, the secret, enabled. Then check that `service=any` and PPPoE customers cannot log in over L2TP from another IP, and that PPPoE still works.
4. Fault injection on hardware: unplug the API path mid-apply and confirm the restore outcome and the router state.
5. Stale rollback: change the key on the router, then confirm rollback is refused.
6. Two NAS at once; cancel during a dial; delete a NAS with a live tunnel (host resources gone, other NAS unaffected).
7. Check the address policy against the real host's `ip -j` output.

## 10. Confirmation

No real router was contacted. No VPN tunnel was established. No package was installed. No production, staging or shared database was used; only a disposable local PostgreSQL in the session workspace, now stopped. Nothing was deployed, committed, pushed, reset or cleaned. Pre-existing user changes are preserved.

## Outcome

**CONDITIONALLY ACCEPTABLE FOR CONTROLLED TEST ENVIRONMENT.**

All CRITICAL and HIGH software defects from the audit (C-1, H-1, H-2, H-3, and the `service=any` exposure) are fixed, regression-tested and covered by mutation checks.

Compatibility with real equipment is unverified. In particular, the strongSwan/RouterOS output formats and API semantics are assumptions; where an assumption is wrong, the code fails closed. Router access over the tunnel (F) is deferred.
