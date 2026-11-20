# Uplinko NAS Management VPN — Phase 1.2 Final Safety Remediation Report

**Scope:** backend only. No frontend. No real router, real tunnel, shared database, deploy, commit or push.

**Disclosure:** I implemented Phases 1, 1.1 and 1.2. I treated `UPLINKO-VPN-PHASE1-1-INDEPENDENT-VERIFICATION.md` as authoritative.

## 1. Starting state

| Item | Value |
|---|---|
| HEAD | `af61caa` (`main`), with the Phase 1 and 1.1 changes uncommitted in the working tree, all preserved |
| Pre-existing user changes | `backend/prisma/seed.ts`, `backend/src/prisma/prisma.service.ts` (CRLF), and the report files. Not touched. |
| Phase 1.1 sources before editing | Matched the verified versions (SHA-256 prefixes `949a4619…`, `944a9a52…`, `60fb71a2…`, `7be58d32…`) |
| Baseline | `tsc`: 6 pre-existing errors. Full Jest: 10 failing suites / 21 failing tests, all from the environment (no Prisma query engine, no DNS) or failing already before Phase 1. |

## 2. Files changed in Phase 1.2

Line numbers refer to the files as they are on disk after formatting.

| File | Change |
|---|---|
| `backend/src/nas/routeros-mgmt-applier.ts` | Rule 4 gets `connection-state=new` (`:312`), and the read-back key list now includes it. `readL2tpClients()` (`:243`) and the `l2tp_clients_present` / `l2tp_clients_unreadable` refusals in preflight (`:385`). The snapshot **and** the intended result are persisted before the first mutation (`:548`). `classifyRouter()` (`:944`) gives read-only recovery classification. |
| `backend/src/nas/l2tp-client-dialer.service.ts` | Host-level per-NAS lock: `acquireHostLock` / `releaseHostLock` (`:253`, `:285`), with a holder-is-alive check (`:229`) and ownership-checked release. Cancel/lease checkpoints before every host mutation in a dial (`:535–600`). |
| `backend/src/nas/nas-l2tp-client.service.ts` | `withAddressLock()` (`:313`) pins `isolationLevel: 'ReadCommitted'` (`:322`) with bounded P2034 retries; the host inventory is read **before** the transaction (`:422`). Host lock taken for connect, reconnect, disconnect, apply, rollback, recover, purge and NAS-deletion cleanup. Owner-guarded writes during apply (`ownedUpdate`, `:587`). Apply refused while recovery is needed (`:572`). `recoverNas()` (`:831`). The view shows an operation only while its lease is live (`:151`). `applyStateOf()` (`:177`). `status()` clears a crashed worker's operation fields and marks an interrupted apply as `recovery_required` (`:1178`). |
| `backend/src/nas/nas-l2tp-client.controller.ts` | New `POST /nas/:id/l2tp-client/nas/recover` (`:68`) |
| `backend/src/nas/nas-vpn-fakes.testkit-spec.ts` | `FakeRouter.packetAllowed()` evaluates protocol, port, source, IPsec policy and **connection-state**. L2TP-client inventory, with error and malformed modes. `SharedHost` + `hostLocks()` run the **real** dialer lock code across simulated workers. |
| `backend/src/nas/nas-vpn-phase12.spec.ts` | **new**, 22 tests |
| `backend/src/nas/nas-l2tp-client.service.spec.ts` | Fixture updated for the host lock (`untilCalled`). The takeover test now separates a crashed worker from a live one. Two new fencing tests. **40 tests.** |
| `backend/src/nas/l2tp-client-dialer.spec.ts` | Fake filesystem gained `lockCreate` / `lockRemove` (43 tests) |
| `backend/src/nas/routeros-mgmt-applier.spec.ts` | Formatting only (48 tests) |

Not changed: schema and migration (no new columns needed), frontend, WireGuard, SSTP, RADIUS, subscriber authentication, `vpn.service.ts`, installers.

## 3. HIGH — UDP 1701 firewall rule

**Before:** rule 4 was `chain=input protocol=udp dst-port=1701 action=drop`, placed above the administrator's established-accept rule. Replies to the router's own outgoing L2TP clients were dropped (verification V2).

**After** (`guardRules`). Final order at the top of `input`, with admin rules following unchanged and in their original order:

| Rule | Payload |
|---|---|
| 1 | `udp dst-port=500,4500 src-address=<UPLINKO_PUBLIC_IP> accept` |
| 2 | `ipsec-esp src-address=<UPLINKO_PUBLIC_IP> accept` |
| 3 | `udp dst-port=1701 src-address=<UPLINKO_PUBLIC_IP> ipsec-policy=in,ipsec accept` |
| 4 | `udp dst-port=1701 **connection-state=new** drop` |

- Established and related packets (replies to the router's own L2TP clients, ongoing sessions) are no longer matched; they continue to the administrator's rules.
- New unauthorised inbound L2TP is still dropped.
- Read-back requires `connection-state=new` exactly. A router that drops the attribute fails verification and is restored.

**Evidence [SIMULATION]** (`nas-vpn-phase12.spec.ts` §1):
- The previous reproduction (reply 203.0.113.77 → udp/1701, state established) is **allowed before and after** apply, and `related` is allowed.
- New inbound 1701 from 8.8.4.4 is **dropped**. Uplinko's IP without IPsec is **dropped**; with IPsec it is **allowed**. Uplinko login works.
- An unrelated site-to-site IKE (udp/500) and ESP peer gets the **same verdict before and after**.
- The guard sits above the established-accept rule, and admin rules keep their identity and order.
- Repeat apply: no duplicates. Rollback restores the exact firewall. A missing rule is caught by read-back and restored.

**Mutation check:** removing `connection-state=new` makes **2 tests fail**.

## 4. HIGH — existing router L2TP clients

`readL2tpClients()` reads `/interface/l2tp-client/print` **before** anything else in preflight.
- Any configured client (running, not running, or disabled) → refusal `l2tp_clients_present`, naming the interfaces. **No confirmation bypass exists**, so the protection cannot be overridden.
- An API error or malformed rows (missing `name`) → `l2tp_clients_unreadable`. This fails closed: an incomplete answer is never read as "none".
- Client interfaces are only ever read, never written. Preview (`inspect`) reports the same refusal.

**Evidence [SIMULATION]** (§2): configured+running, configured+not-running and disabled are refused with 0 mutations and the router deep-equal to before. An empty list proceeds. API-error and malformed inventories are refused.

**Mutation checks:**
- Refusal removed → **4 tests fail**.
- Unreadable inventory accepted → **2 tests fail**.

## 5. MEDIUM — database isolation for address allocation

- `withAddressLock` runs `pg_advisory_xact_lock(727011)`, then the claim check, then the upsert, in a Prisma interactive transaction with an explicit `isolationLevel: 'ReadCommitted'`, `timeout 15 s` and `maxWait 5 s`.
- P2034 (write conflict / serialization) is retried at most 3 times; other errors propagate.
- Host I/O (`ip -j`) now happens **before** the transaction, which also resolves V1-b.
- Unique indexes remain as a backstop for exact duplicates.

**Actual Prisma verification [DISPOSABLE POSTGRESQL 16]:**
- The **real `NasL2tpClientService.save()`** ran against disposable PostgreSQL 16 (local, port 55435, stopped afterwards) after all 68 migrations.
- Prisma client: `prisma@6.19.3` / `@prisma/client@6.19.3` generated from the **same schema**, with `engineType = "client"` and `@prisma/adapter-pg`. The default Rust query engine cannot be downloaded here.
- Each worker had its own `PrismaClient` (separate connection pools).
- The test file was temporary, in the isolated copy only; it is not in the repository.

| Test | Result |
|---|---|
| P1: tenant A (NAS 1) claims .2/.1 and holds the lock 800 ms; tenant B (NAS 2) concurrently claims .1/.9 (A's remote as B's local) | **one committed, one rejected** ("already used by another NAS tunnel"); NAS 2 row unchanged |
| P2: same, with the **database default isolation set to REPEATABLE READ** | **one committed, one rejected**, so the per-transaction pin works |
| P3: exact duplicate claimed concurrently | one committed, one rejected |
| P4: 20 rounds of simultaneous overlapping claims, fresh clients each round | **0/20** rounds with both committed |
| P5: failing claim rolls back; next claim | proceeded in 11–16 ms (lock released) |

**Mutation checks against the real database:**
- Isolation pin removed → P2 **fails** (both committed under REPEATABLE READ).
- Advisory lock removed → P1 **fails** and P4 shows **16/20** double commits.

**Caveat:** the production Rust query engine was not exercised. The SQL transaction semantics (isolation level, advisory lock) are the same, but this should be confirmed once on a host that has the standard engine.

## 6. MEDIUM — lock loss during long system commands (fencing)

- **Host-level per-NAS lock** (`l2tp-client-dialer.service.ts:253`): an atomic `mkdir` of `<L2TP_CLIENT_DIR>/locks/nas-<id>` with `owner.json {token, pid}`.
  - Held for the whole operation (connect/reconnect background work, disconnect, apply, rollback, recover, purge, NAS-deletion cleanup).
  - A second worker cannot take it while the holder **process is alive**, **even if the holder's database lease has expired**. The heartbeat is therefore not the only protection: a still-running command keeps the NAS locked on the host.
  - A lock whose holder pid is dead is taken over.
  - Release is ownership-checked, so a former owner can never remove a new owner's lock.
- **Database fencing:** each operation's lease token works as its fencing token.
  - Every state write during apply goes through `ownedUpdate` (`where clientLockOwner = token`). If ownership is gone, the worker throws and stops before or between router mutations.
  - Background results are written only by `release()` (owner-guarded) and are discarded when the lease is lost.
- **Checkpoints:** the dial re-checks cancel / lease-lost before each file write and each host command (`:535–600`). After cancellation only teardown commands run.
- Disconnect and cancel never release another operation's lease (unchanged from 1.1). Disconnect, purge and deletion cleanup refuse (409) while another live process holds the host lock.

**Evidence [SIMULATION, real lock code]** (§4, service spec):
- Lock exclusive between live processes, independent per NAS; non-owner release has no effect; dead holder taken over; former owner cannot remove the new owner's lock.
- A dial cancelled during `swanctl --load-all` issues no `--initiate` and no LAC commands.
- **Fencing:** after a lease takeover from a still-running worker, the new worker's operation **does not touch the host** (dial and hangup never called), reports "still working on this NAS", and the old worker's later "connected" result is **not written**. When the old worker finishes, a third worker proceeds normally.
- A crashed worker (pid dead) is taken over and the new connect completes.
- Disconnect, purge and deletion cleanup are refused while a live process holds the lock.
- A stale apply worker cannot persist its snapshot, so the router sees 0 mutations.

**Mutation checks:**

| Protection removed | Tests failing |
|---|---|
| Live-holder check | 1 |
| Checkpoint before initiate | 1 |
| Owner guard on apply writes | 1 |
| Host lock for background operations | 2 |

## 7. MEDIUM — restart and interrupted-apply recovery

- **View after restart:** `operation` is shown only while the lease is live (`:151`).
  - `nasApplyState` reports `applying` with an expired lease as **`recovery_required`** (`applyStateOf`).
  - `status()` clears a crashed worker's operation fields (only once its lease has expired) and persists `recovery_required`.
- **No blind retries:** `applyNas` refuses while the state is `applying`, `recovery_required`, `apply_failed_unrestored` or `rollback_failed`, with **no router mutation**, and points to recovery.
- **Recovery (`POST /nas/recover`) is read-only on the router.** `classifyRouter` compares every managed item with the persisted snapshot and intended result:

  | Router state | Recorded as | Next step |
  |---|---|---|
  | `at_desired` | `applied` | — |
  | `at_snapshot` | `none` (records cleared) | — |
  | `mixed` (each item is either original or Uplinko's own, including a half-installed guard) | `recovery_required` | rollback is safe and allowed |
  | `foreign` / `unreadable` | `recovery_required` | manual intervention; rollback refused by its stale-change check |

- Because the intended result is persisted **before** the first mutation, an interrupted apply can now be rolled back safely. Phase 1.1 refused this outright.
- Locks and rollback claims stay ownership- and read-back-verified.

**Evidence [SIMULATION]** (§5). Worker crashes are simulated at 0, 2, 3 and all mutations (process marked dead, heartbeat stopped, lease expired):
- View shows no stale operation and `recovery_required`.
- A new apply is refused with 0 mutations.
- Mixed → rollback restores the router exactly.
- At-snapshot → `none`, read-only.
- Fully applied → `applied`, read-only.
- Foreign change → manual, and rollback is refused with 0 mutations.

**Mutation checks:**
- Stale operation shown in the view → 1 test fails.
- Apply allowed without recovery → 1 test fails.

## 8. Tests and checks (isolated copy; byte-identical files written to `F:\Jointbox panel`)

| Check | Command | Exit | Result |
|---|---|---|---|
| Phase 1.2 regressions | `jest src/nas/nas-vpn-phase12.spec.ts` | 0 | **22/22** [simulation/unit] |
| Phase 1.1 suites (160) | `jest` on address-policy / applier / dialer / service / delete-cleanup | 0 each | 27 + 48 + 43 + **40** + 3 = **161** (the service suite gained 1 net) |
| Actual Prisma × PostgreSQL 16 | temporary `zz-prisma-pg.spec.ts` (isolated copy) | 0 | **5/5** [disposable PostgreSQL], re-run after final formatting |
| All NAS/VPN suites | `jest src/nas/` | 1 | 18 suites pass, **325 tests**. `nas.module.spec.ts` fails on the Prisma query engine (environmental, same as baseline). |
| Full backend | `jest` | 1 | **1,642 passed / 21 failed; the 10 failing suites are identical to the baseline** (diffed) |
| TypeScript | `tsc --noEmit -p tsconfig.json` | 2 | **The same 6 baseline errors, none new** |
| Nest build + DI | `nest build`, `node scripts/check-di.js` | 0 / 0 | "✓ backend wiring check passed" |
| ESLint (changed files) | `eslint …` | 1 | No formatting errors. What remains is the codebase-wide `no-unsafe-*` / `require-await` pattern and 2 `no-base-to-string`. Not blocking; listed for cleanup. |
| Mutation checks | 11 protections removed one at a time, code restored after each | — | Every one made at least 1 test fail (detailed above) |

Test categories:
- **Unit:** address policy, real host-lock code on an in-memory filesystem.
- **Simulation:** FakeRouter (RouterOS model), FakeDb, fake host.
- **Disposable PostgreSQL:** the Prisma concurrency suite and migration application.
- **Real hardware:** **none**.

## 9. Remaining limitations

1. **RouterOS semantics [HW]:** `connection-state=new` on UDP (stateful conntrack for L2TP), `ipsec-policy=in,ipsec`, `place-before`, the `=ret=` id, `service=any` matching, and `/interface/l2tp-client/print` field names (`name`, `running`, `disabled`).
2. **strongSwan / iproute2 output formats [HW]** (fail closed). **NAS behind 1:1 NAT** is expected not to work, failing closed (remote id = public IP); it needs a configurable identity in a later phase.
3. **Host lock assumptions:** all backend workers run on **one host** (the PM2 cluster) and share `L2TP_CLIENT_DIR`. pid liveness can be fooled by pid reuse after a crash (rare); the next holder then waits until that pid exits. A multi-host deployment would need a distributed lock.
4. **Production Prisma engine:** the concurrency tests used Prisma's driver-adapter engine, not the Rust engine. The SQL semantics are the same, but this is not executed here.
5. **Router management access still uses the public IP** (`tunnelUsedForRouterAccess: false`). Low items from the verification are still open: XFRM `reqid` binding (V3-a), duplicate IKE SA ordering (V3-b), the demo-data `nas.deleteMany` paths, and symlink hardening.
6. **`POST /nas/apply` and `/nas/recover` are synchronous**, bounded by RouterOS socket timeouts.

## 10. Real MikroTik / Linux verification still required

1. On RouterOS 6 and 7, confirm that an existing outgoing L2TP client (if the refusal is lifted for the test) keeps working with the guard installed, and that new inbound 1701 from a third host is dropped.
2. `/interface l2tp-client/print` over the API with configured, running and disabled clients; confirm the refusal.
3. Real strongSwan/xl2tpd tunnel bring-up, the ESP proof, cancel mid-dial, and two workers.
4. A Prisma concurrency smoke test with the standard query engine.
5. A real NAT test.

## 11. Confirmation

No real router, VPN tunnel, package installation on a production server, shared or production database, deployment, commit, push, reset or clean. Only disposable local PostgreSQL instances in the session workspace were used, and they are stopped.

## Outcome

**READY FOR CONTROLLED REAL-HARDWARE TESTING.**

Every critical and high software defect found by the audits is fixed, regression-tested, and covered by mutation checks:
- original audit: C-1, H-1, H-2, H-3, and the `service=any` exposure;
- 1.1 verification: V2 (UDP 1701 drop) and the L2TP-client handling.

The medium issues on isolation, fencing and recovery are fixed, with the isolation fix verified through the actual Prisma service on disposable PostgreSQL.

What remains is limited to the physical compatibility checks in §10, to be done on an **isolated test MikroTik with no customers** and a test Uplinko host. **This is not production approval.**
