# Uplinko VPN Phase 1.1 — Independent Post-Remediation Verification

This was a read-only audit. Nothing in `F:\Jointbox panel` was changed apart from adding this report.

**Disclosure:** I (Claude) also wrote the Phase 1.1 remediation being verified. Every conclusion below comes from the source code and from fresh reproductions, not from the remediation report.

## 0. State verified

| Item | Value |
|---|---|
| HEAD | `af61caa` (`main`) |
| Audited sources | Byte-identical (SHA-256) in `F:\Jointbox panel` and in the isolated copy: `nas-l2tp-client.service.ts` 949a4619…, `routeros-mgmt-applier.ts` 944a9a52…, `l2tp-client-dialer.service.ts` 60fb71a2…, `l2tp-address-policy.ts` 7be58d32…, migration 4b97e22e… |
| Temporary tests | Created only in the isolated copy, then deleted. A disposable local PostgreSQL 16 (port 55434, trust auth) was used and then stopped. |
| Existing suites (re-run) | 5 Phase 1.1 spec files, **160/160 pass** (exit 0). These are simulation and unit results only. |

Legend:
- **[CODE]** read in the source
- **[SIM]** mock or simulation test
- **[PG]** disposable PostgreSQL
- **[HW]** needs a real MikroTik or Linux host

---

## 1. PostgreSQL concurrent address allocation

**Implementation:**
- `nas-l2tp-client.service.ts:376–381`: `$transaction(async tx => { pg_advisory_xact_lock(727011); assertAddressing(tx,…); upsert })`.
- The claims are read from the database inside the transaction (`otherClaims`, `:173–188`).
- Unique indexes on `mgmtPublicHost`, `localAddress` and `remoteAddress` (migration lines 37–39).
- Tunnel "ranges" are single /32 addresses (local plus remote), so overlap here means equal addresses across both columns.

**Tests [PG].** Two real concurrent sessions, emulating the code's exact SQL sequence (advisory lock → check both columns of other rows → write). Tenant A (NAS 1) claims .2/.1 and holds the transaction open for 2 s. Tenant B (NAS 2) concurrently claims local .1 (A's remote) and remote .9:

| Case | Result |
|---|---|
| A) advisory lock + READ COMMITTED (**as implemented**; Prisma default) | B blocks, then sees A's commit: **"overlap detected"**, B writes nothing. **PASS** |
| B) control: no lock | Both commit, so `1:.2/.1` and `2:.1/.9` overlap. This proves the lock is necessary, not decorative. |
| C) advisory lock + REPEATABLE READ | B's snapshot predates A's commit, so **the overlap is committed**. |
| Exact duplicate on the same column, concurrent | `duplicate key … nas_l2tp_config_remoteAddress_key`. **PASS** |
| Lock holder rolls back | Lock released at once (next taker in 0.73 s, after the sleep). **PASS** |

**Findings:**
- **V1-a MEDIUM — FAIL (latent).** Correctness depends on READ COMMITTED, but the code does not pin the isolation level (`:376`). If the database default is raised (`default_transaction_isolation=repeatable read`) or the transaction options change, cross-tenant overlaps become possible again (case C). **Fix:** pass `{ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }`, or use SERIALIZABLE with retry, and add a database-level guarantee (for example a claims table with one row per address and a unique key).
- **V1-b LOW — NOT VERIFIED.** The Prisma interactive transaction uses the default 5 s timeout, and `assertAddressing` runs host commands (`ip -j`, two 5 s time limits) **inside** the transaction while holding the global lock. A slow host makes saves fail (P2028) and serialises all tenants behind that host I/O. **Fix:** read the inventory before opening the transaction.
- **Not verified:** the emulation used psql with the same SQL. The Prisma code path itself could not run against PostgreSQL because the Prisma query engine is blocked in this environment.

## 2. MikroTik firewall and customer PPP isolation

**Payloads [CODE]** (`routeros-mgmt-applier.ts:249–276`, add loop `:520–540`). Chain `input`, inserted with `place-before=<first filter rule id>` in reverse, so the final order is 1–4 at the top:

| Rule | Payload |
|---|---|
| 1 | `protocol=udp dst-port=500,4500 src-address=<UPLINKO_PUBLIC_IP> action=accept` |
| 2 | `protocol=ipsec-esp src-address=<UPLINKO_PUBLIC_IP> action=accept` |
| 3 | `protocol=udp dst-port=1701 src-address=<UPLINKO_PUBLIC_IP> ipsec-policy=in,ipsec action=accept` |
| 4 | `protocol=udp dst-port=1701 action=drop` |

Plus `use-ipsec=required` and a PSK that only Uplinko holds; the server is enabled last.

**Results:**

| Check | Result |
|---|---|
| Only Uplinko's IP over IPsec reaches L2TP; `service=any` customers denied from the internet, with a leaked PSK, or from Uplinko's IP without the PSK | **PASS [SIM]** (`canL2tpLogin` model). **[HW]** needed. |
| PPPoE and RADIUS untouched (no payload references them; only UDP 1701 is dropped) | **PASS [CODE][SIM]** |
| Unrelated IPsec peers: rules 1 and 2 only *accept*, nothing drops 500/4500/ESP | **PASS [CODE]** |
| Re-apply does not duplicate rules; rollback removes only rules carrying the `uplinko-mgmt-vpn guard nas=<id>` comment; admin rules deep-equal afterwards | **PASS [SIM]** |
| Partial firewall update (fault after each of the 4 adds) restored and verified | **PASS [SIM]** (24 fault cases) |
| **V2 — rule 4 breaks the NAS's own outbound L2TP clients** | **HIGH — FAIL** |

**V2 HIGH — FAIL.**
- **Code:** rule 4 drops *every* UDP packet to port 1701 in `input`, with no `connection-state` or `src`/`dst` restriction. It sits above the router's own `established,related` accept rule. Apply never reads `/interface l2tp-client` (0 commands touch it).
- **Reproduction [SIM]** (temporary test): before apply, a reply from another L2TP server (203.0.113.77 → NAS udp/1701) is **allowed**; after apply it is **dropped**. Rule 4 has `connection-state=null` and precedes the established accept.
- **Impact:** a NAS that is itself an L2TP client (upstream or site-to-site L2TP, common on ISP routers) loses those tunnels as soon as Uplinko applies. That violates "do not disrupt unrelated router services". This is a confirmed software-level safety issue. The RouterOS behaviour still needs hardware confirmation: RouterOS L2TP clients use local port 1701 [HW].
- **Fix:**
  - limit rule 4 to new inbound sessions (`connection-state=new`), or
  - drop only when the packet is not an IPsec-decrypted packet from Uplinko and not established/related, and
  - in addition, read `/interface l2tp-client` and require confirmation or refuse when any exist.
  - Add a test for both cases.

**Other observations:**
- **V2-b LOW — NOT VERIFIED [HW].** RouterOS dynamic filter rules (for example from hotspot) cannot be preceded. `rulesInPlace` requires Uplinko's rules to be the *first* input rules (`:310`), so such routers would always fail verification. That fails safe (restored), but the feature would not work.
- **[HW]:**
  - `ipsec-policy=in,ipsec` matching decrypted transport-mode L2TP;
  - `place-before` with API ids;
  - the `=ret=` id returned by add;
  - L2TP secret matching for `service=any`.

## 3. Encryption detection

**[CODE]:**
- `verifyEncryption` (`l2tp-client-dialer.service.ts:795–860`) and `parseSwanctlSas` (`:897–`). Connected requires all of:
  - IKE `ESTABLISHED`, with remote host equal to the configured NAS IP (`:810`);
  - a CHILD_SA *with this connection's name*, `INSTALLED`, `TRANSPORT*`, `ESP`, non-NULL cipher;
  - remote traffic selector `<NAS IP>/32[udp/1701|l2f|l2tp]` and a local L2TP selector (`:844`);
  - `ip xfrm state list dst <NAS IP> proto esp` containing `proto esp` and `mode transport` (`:853`).
- Any failure gives `encryption_unverified`, the tunnel is torn down, and there is no retry.

**Results:**

| Check | Result |
|---|---|
| No CHILD_SA, unrelated CHILD_SA name, wrong peer, wrong selectors, no XFRM, `REKEYING`, NULL cipher, truncated output → not connected | **PASS [SIM]** (fixture tests) |
| An unrelated ESP SA alone cannot produce Connected (the CHILD_SA is matched by name) | **PASS [CODE]** |
| **V3-a LOW:** the XFRM check is not tied to this CHILD_SA's `reqid`/SPI, so any ESP transport SA to the same destination satisfies that one sub-check | **FAIL (defence-in-depth gap)**. Fix: capture `reqid` from the child line and require it in `ip xfrm state`. |
| **V3-b LOW:** several IKE SAs with the same name (rekey overlap): the last header wins (`:910`), which can give a false *negative* | **FAIL (availability only; fails closed)** |
| Output formats | **NOT VERIFIED [HW].** The fixtures were written from strongSwan 5.x `list_sas.c` and iproute2 conventions; they were **not captured from a real host**. Port naming (`l2f` comes from `/etc/services`) varies by distro. Every mismatch fails closed. |

## 4. Router behind 1:1 NAT

**[CODE]:**
- Remote identity pinned to the dialed public IP: `remote { auth = psk id = <public IP> }` (`:307`).
- PSK bound with `id-1 = <public IP>` (`:322`).
- No `local id` is set, so Uplinko's own identity defaults to its local (possibly private) address.
- Status requires the IKE remote host and the **remote traffic selector IP** to equal the public IP (`:810`, `:844`).

**What can be proven:**
- NAT-T itself is negotiated automatically by strongSwan. The connection does not disable encapsulation, and UDP 4500 is allowed by rule 1. **PASS [CODE].**
- A MikroTik behind 1:1 NAT normally identifies itself with its own (private) address. That would fail strongSwan's remote-identity constraint, so IKE would not come up. Even if IKE did come up, a transport-mode selector carrying the NAS's private address would fail `l2tpTs(remoteTs, server)`. **Result: NAS behind 1:1 NAT is expected NOT to work. Fails closed: no false Connected. MEDIUM — FAIL (functional), NOT VERIFIED [HW].**
- **Fix (for a later phase):** an optional per-NAS `remoteId` (for example `%any` with the PSK still bound by address, or a FQDN/KEY_ID agreed with the NAS). Accept the NAT'd selector when NAT is detected (strongSwan reports `-in-UDP` / NAT-OA). Needs a real NAT test.
- Firewall side: the NAS sees Uplinko's NAT'd public IP, which must equal `UPLINKO_PUBLIC_IP`. Correct by design; **[HW]**.

## 5. Asynchronous Connect API

| Check | Evidence | Result |
|---|---|---|
| Prompt return with an operation id | `connect` (`:813`) does validation, the address check (host `ip -j`), then `acquire`, then `startBackground` (not awaited), and returns `{accepted, operationId, state:'connecting', statusUrl}` | **PASS [CODE][SIM]** |
| Concurrent requests on one NAS | Atomic `updateMany` lease where unlocked or expired (`acquire`, `:211`); second worker gets 409 | **PASS [SIM]** |
| Cancel cannot release another operation's lock | `cancel` only sets `clientCancelRequested` (`:865`). `release` is guarded by `clientLockOwner=<token>` (`:267`). Disconnect during connect returns `cancelling` and keeps the owner's lease. A mutation check (owner condition removed) fails a test. | **PASS [SIM]** |
| Expired operations recovered | Lease TTL 45 s, renewed every 15 s. An expired lease can be taken over. The old owner's late result is discarded. | **PASS [SIM]** |
| **V5-a MEDIUM:** a lease can be lost while the old worker is inside a long host command (`swanctl --initiate` up to timeout+5 s, `load-all` 20 s). `shouldCancel` is checked only between steps (`:395`, `:519`), so after a takeover two dials can briefly drive the same NAS's host resources | Code trace | **FAIL (narrow race)**. Fix: check the cancel flag before every host command, and make teardown/attempt idempotent under a host-level per-NAS file lock (`flock`). |
| **V5-b LOW:** after a worker restart, `getView` still shows `operation:{…}` from the stale `clientOpId` (`:147`), because the stale fields are not cleared until the next acquire. `status()` is correct (it checks `busy`). | Code | **FAIL (cosmetic)** |
| **V5-c LOW:** if the lease is lost during `applyNas`, `release` is a no-op (owner mismatch), so `mgmtApplyState` stays `applying` even when the router was successfully changed. Rollback is then refused as "interrupted". Fail-safe, but needs manual recovery. | `:581`, `:613` | **FAIL (recoverability)** |
| Error and rollback outcomes | `applyOutcome` is `apply_failed_restored`, `apply_failed_partially_restored` or `apply_failed_not_restored`. `mgmtApplyState` lumps partial into `apply_failed_unrestored` (acceptable). | **PASS [SIM]** |
| API consumers | No file under `frontend/` references `l2tp-client`. Git status shows no frontend changes. | **PASS [CODE]** |
| `POST /nas/apply` still synchronous | RouterOS calls are bounded by a 12 s socket timeout, but there are many of them | **NOT VERIFIED (latency)** |

## 6. Re-check against the original audit (C-1 … M-7)

| Finding | Status | Evidence |
|---|---|---|
| C-1 secret wipe | **PASS [SIM]** | Sensitive-policy check and three-state secret, refusal before any write; the audit scenario test passes (0 mutations, key unchanged); removing the check fails tests |
| H-1 encryption proof | **PASS [SIM]** with V3-a/b LOW; formats **[HW]** | See §3 |
| H-2 partial apply | **PASS [SIM]** | Snapshot persisted before the first mutation; 24 fault cases restored or reported not restored |
| H-3 address abuse | **PASS [SIM][PG]** with V1-a MEDIUM | Pool, host inventory, protected ranges, cross-tenant claims |
| M-1 disconnect lock | **PASS [SIM]** | — |
| M-2 lock expiry | **PASS [SIM]**, V5-a residual | — |
| M-3 long HTTP | **PASS** for connect; apply remains synchronous | — |
| M-4 stale rollback | **PASS [SIM]** | Admin changes cause a refusal with 0 mutations |
| M-5 legacy fields | **PASS [CODE][SIM][PG]** | Separate columns; legacy values unchanged on the disposable database |
| M-6 tunnel not used | **PASS (honestly reported)** | `tunnelUsedForRouterAccess:false` in view and status; RouterOS access still uses `nasIp` |
| M-7 NAS deletion | **PASS** for `NasService.remove` (cleanup before delete; 409 keeps the NAS) | **LOW gap:** `demo.service.ts:121` and `demo-data.service.ts:132` `nas.deleteMany` bypass cleanup (demo accounts only) |
| L-1 symlink / load-all coupling | Unchanged | LOW, still open |

**Additional checks:**
- **Migration vs schema [PG]:** all 68 migrations applied in order. The new columns, defaults and three unique indexes match `schema.prisma`; legacy rows are unchanged. `prisma migrate diff` is **NOT VERIFIED** (engine blocked).
- **Authorization [CODE]:** `assertNasAccess` is the first call in all 11 service entry points, including `cancel`. The controller uses the same JWT + permission guards. **PASS.**
- **Secrets [CODE][SIM]:** AES-256-GCM. Snapshot and desired state encrypted. No PSK, password or old key in responses or errors (tested). **PASS.**
- **Process cleanup [SIM]:** `purge` verifies that the SA, interface and files are gone for this NAS only. **PASS**; **[HW]** needed.

---

## 7. Summary of open findings

| ID | Severity | Result | Area |
|---|---|---|---|
| **V2** | **HIGH** | **FAIL** | The firewall guard drops all UDP 1701, including replies to the NAS's own L2TP client tunnels; existing L2TP clients are never checked |
| V1-a | MEDIUM | FAIL (latent) | Address-claim safety depends on an isolation level the code does not pin |
| NAT | MEDIUM | FAIL (functional), [HW] | NAS behind 1:1 NAT expected not to work (fails closed) |
| V5-a | MEDIUM | FAIL | Narrow dual-dial race after a lease is lost mid-command |
| V1-b, V2-b, V3-a, V3-b, V5-b, V5-c, demo deleteMany | LOW | FAIL / NOT VERIFIED | Listed above |

Not verified anywhere (real equipment needed): strongSwan and `ip xfrm` output formats; RouterOS API field semantics, `place-before`, `ipsec-policy` matching and `service=any` behaviour; NAT; actual tunnel bring-up.

## Outcome

**BLOCKED.**

V2 is a confirmed HIGH software-level safety defect: applying the guard can break unrelated L2TP client tunnels on the NAS. Real-hardware testing is not authorised until V2 is fixed and regression-tested. V1-a should be fixed in the same pass. Every other critical and high item from the original audit is verified as remediated at code and simulation level.
