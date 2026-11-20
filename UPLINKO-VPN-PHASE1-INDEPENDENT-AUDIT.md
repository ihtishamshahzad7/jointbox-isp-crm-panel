# Uplinko VPN Phase 1 — Independent Security & Code Audit

Audit only. No source, schema, migration, test, configuration or documentation file in `F:\Jointbox panel` was changed.

**Disclosure:** I (Claude) also wrote the Phase 1 implementation being audited. Every conclusion below comes from reading the source and from reproductions, not from the implementation report. Several findings are defects in my own code.

## 0. Repository state

| Item | Value |
|---|---|
| HEAD | `af61caa5c2bb7a94e40d1a9b7db90e4f968cf618` (`main`, equal to `origin/main`) |
| Modified (Phase 1) | `backend/prisma/schema.prisma`, `backend/src/nas/nas-l2tp-config.service.ts`, `backend/src/nas/nas.module.ts` |
| Modified (pre-existing CRLF noise) | `backend/prisma/seed.ts`, `backend/src/prisma/prisma.service.ts` |
| Untracked (Phase 1) | `backend/prisma/migrations/20261121090000_nas_l2tp_client/`, `backend/src/nas/l2tp-client-dialer.service.ts`, `l2tp-client-dialer.spec.ts`, `nas-l2tp-client.controller.ts`, `nas-l2tp-client.service.ts`, `nas-l2tp-client.service.spec.ts` |
| Untracked (reports) | `UPLINKO-LATEST-MAIN-DEEP-AUDIT.md`, `UPLINKO-VPN-PHASE1-IMPLEMENTATION-REPORT.md` |
| Audited copy | SHA-256 of all 9 Phase 1 files in the isolated workspace match the files in `F:\Jointbox panel` byte for byte. |

Line numbers refer to the files as they are on disk now (after `prettier`).

**How I tested:**
- Reproductions ran as throw-away Jest specs in the isolated copy, and were deleted afterwards.
- The migration was tested on a **disposable local PostgreSQL 16** with no production data or credentials. That instance was stopped afterwards.
- The only change outside the repository: I added the execute permission (`o+x`) to my own workspace folders, so the local PostgreSQL user could reach its data folder.

---

## 1. Confirmed bugs

### C-1 CRITICAL — When the RouterOS API cannot read the IPsec secret, apply replaces the router's key without confirmation and then wipes it
- **Where:**
  - `nas-l2tp-client.service.ts:327`: `ipsecSecret: String(s['ipsec-secret'] ?? '')`
  - `:359–360`: `affectsOthers = server.enabled && pskDiffers && server.ipsecSecret !== ''`
  - `:440`: unconditional `=ipsec-secret=${psk}`
  - `:474` / `:536–543`: `restore()` writes `before.ipsecSecret`, which is `''`
- **Actual behaviour:** RouterOS hides sensitive fields such as `ipsec-secret` from API users without the `sensitive` policy. The real secret is then read as `''`, so `affectsOthers` is false and **no confirmation is asked**, and Uplinko's PSK is written over the customers' key. The read-back also hides the field (`'' !== psk`), so the code "restores", writing `ipsec-secret=` (empty). The user is told "Its previous settings were restored", which is false.
- **Reproduction:** running server with key `Customers-Key-99`, and `print` omits `ipsec-secret`. Result:

  ```
  R1 result=BadRequestException msg="…Its previous settings were restored." | ipsec-secret writes=["<uplinko psk>","=ipsec-secret="] | final device key=""
  ```
- **Expected:** if `ipsec-secret` is absent from the read, refuse before writing anything ("API user needs the sensitive policy"). Never restore a value that was not actually read.
- **Impact:** every existing L2TP/IPsec client on that NAS is disconnected, and the original key is lost. The test plan grants `sensitive`, but the code neither checks nor enforces it.
- **Fix:**
  - Treat a missing field as "unknown" and abort.
  - Distinguish an empty value from an unreadable one.
  - Only restore fields that were read.
  - Fix the success/restore message.

### H-1 HIGH — "Connected" does not prove the L2TP traffic is encrypted
- **Where:**
  - `l2tp-client-dialer.service.ts:610–612`: `ipsecUp` checks only that the **IKE** SA shows `ESTABLISHED`. The CHILD (transport) SA is not checked.
  - `nas-l2tp-client.service.ts:439`: apply sets `use-ipsec=yes` (optional) rather than `required`.
- **Actual behaviour:** an IKE SA can be `ESTABLISHED` while the CHILD SA failed or expired. xl2tpd then sends L2TP in clear, a NAS with `use-ipsec=yes` accepts it, and the dialer reports `connected`.
- **Reproduction:** `swanctl --list-sas` output with only the IKE line (no `INSTALLED, TRANSPORT` child). Result: `R3 state: connected | IPsec established; ulnas7 up …`.
- **Expected:**
  - Require the child SA line for this connection to show `INSTALLED` and `TRANSPORT`, and ideally confirm an XFRM state for the NAS public IP.
  - On the NAS, require IPsec for Uplinko's session: set `use-ipsec=required` (only with consent, because it affects others), or add an IPsec policy or firewall rule allowing UDP/1701 only with IPsec.
- **Impact:** management traffic (PPP, and later RouterOS API over the tunnel) could cross the internet unencrypted while the UI says Connected.

### H-2 HIGH — An exception part-way through apply leaves the router modified
- **Where:** `nas-l2tp-client.service.ts:479–490`. The `catch` records the failure and rethrows; it **does not call `restore()`**. Restore only happens on read-back mismatch (`:474`).
- **Reproduction:** `/ppp/secret/add` throws "connection closed by the router" after `server/set` succeeded. Result:

  ```
  R2 result=BadRequestException | device enabled=yes use-ipsec=yes keyIsUplinkoPsk=true
  ```
- **Expected:** any failure after the first write triggers a best-effort restore, using a new connection if the old one dropped. The response must say whether the restore was confirmed.
- **Impact:** the server is left enabled with Uplinko's key, with no record that the change happened and no snapshot saved for rollback (`nasSnapshotEnc` is written only on success, `:516`). Existing clients can be cut off.

### H-3 HIGH — Tunnel and dial addresses are unrestricted, so one tenant can steer root-owned host routes
- **Where:**
  - `l2tp-client-dialer.service.ts:125–136`: `isDialableIpv4` and `isTunnelIpv4` accept **any** unicast IPv4, including public addresses and the host's own LAN.
  - Used by `nas-l2tp-client.service.ts` `save()` (validation block around `:165–175`).
- **Reproduction:**
  - `remoteAddress=8.8.8.8, localAddress=1.1.1.1` is accepted.
  - `publicHost=10.0.0.5` (private) with `remoteAddress=192.168.1.1` (the host's own gateway range) is accepted (`R5`).
- **Actual behaviour:** after connect, pppd (running as root) installs a /32 to `remoteAddress` via `ulnasN`. A company admin who owns one NAS can choose `remoteAddress` equal to another tenant's NAS public IP, the licence server, a DNS resolver or the host's gateway. That hijacks host-wide traffic to that address into their own tunnel. The route check (`:676`) only confirms the route goes via `ulnasN`, which is exactly the hijack. `publicHost` may also be a private or internal address, which makes the root host send IKE/L2TP into internal networks.
- **Expected:**
  - Tunnel addresses only from a platform-configured management range (for example `L2TP_MGMT_CIDR=10.255.0.0/16`).
  - Reject addresses inside host-connected networks and the default gateway.
  - `localAddress` unique as well.
  - `publicHost` must not be private, loopback or the host's own network unless the platform owner allows it.
- **Impact:** cross-tenant outage or interception on a shared Uplinko host.

### M-1 MEDIUM — Disconnect during a running connect clears the cross-process lock
- **Where:** `nas-l2tp-client.service.ts:745–757`. `disconnectInternal` sets `clientLockUntil: null` without owning the lock; `disconnect()` (`:761`) takes no lock.
- **Reproduction:** first `connect` in progress, then `disconnect`, then a second `connect` → `R4 lock after disconnect=null | dial() calls while first still running=2`.
- **Impact:** two dials for one NAS on the same host race over the same files, LAC and SA. The first dial's result can then overwrite the state written after the disconnect.
- **Fix:** disconnect and purge must take the same lock (or a lock token), and must not clear a lock they do not own.

### M-2 MEDIUM — The dial lock can expire while the dial is still running
- **Where:** budget `nas-l2tp-client.service.ts:710–711` = `(timeout+25)·(retries+1) + delay·retries + 30s`. The worst case for one attempt in `l2tp-client-dialer.service.ts` is:

  | Step | Max time |
  |---|---|
  | load-all | 20s |
  | initiate | timeout + 5s |
  | remove/add/connect-lac | 25s |
  | polling | timeout |
  | teardown | 25s |
  | **Total** | **≈ 2·timeout + 75s** |
- **Evidence:** arithmetic from the command time limits in the code. With timeout 30s, the lock allows about 55s per attempt against about 135s worst case.
- **Impact:** another PM2 worker can take over the "expired" lock and start a second dial (as in M-1).
- **Fix:** derive the budget from the real worst case, or refresh the lock during the dial.

### M-3 MEDIUM — Connect runs synchronously for up to tens of minutes inside one HTTP request
- **Where:** `nas-l2tp-client.controller.ts` `connect` awaits `dialer.dial()`. With retries 5 and timeout 120, the worst case is about 36 minutes.
- **Impact:** reverse-proxy timeouts (nginx typically 60s) return 504 while the root-level dial continues. The user retries and gets "already running", or worse, see M-1/M-2.
- **Fix:** start the dial as a background job, return 202, and let the client poll `/status`.

### M-4 MEDIUM — Rollback restores a possibly outdated snapshot without checking for later changes
- **Where:** `nas-l2tp-client.service.ts:516` saves the snapshot only on the first successful apply. `rollbackNas` (`:553–608`) writes it back unconditionally.
- **Actual behaviour:**
  - If the operator later changed the NAS L2TP server (for example rotated the IPsec key for customers), rollback silently reverts it and disconnects those clients.
  - Two applies running at once (there is no NAS-side lock) can both see "no snapshot". The second then stores the already-modified state as the "original".
- **Fix:**
  - Store the post-apply values too.
  - Before rollback, compare the router's current values with what Uplinko set. On any difference, refuse or ask for confirmation.
  - Lock apply and rollback per NAS.

### M-5 MEDIUM — Columns shared with the legacy `l2tp-config` flow
- **Where:**
  - `nas-l2tp-config.service.ts:256`: the legacy `saveDraft` writes `ipsecPskEnc`, the same column the management VPN uses as its PSK (`nas-l2tp-client.service.ts:187`, `:286`, `:693`).
  - The management flow writes the legacy `state` column (`:512` 'active', `:620` 'failed', `:602` 'draft'). The legacy flow's workflow uses `state` (`draft/validated/approved/…`, legacy `:355`, `:419`).
- **Impact:**
  - Editing the old VPN screen silently changes the management tunnel's PSK. The next connect then fails with `ipsec_auth_failed`, or apply replaces the NAS key.
  - Management apply and rollback reset the legacy approval state.
- **Fix:** give the management VPN its own state column (`nasApplyState`). Decide whether the legacy flow keeps or loses write access to `ipsecPskEnc`.

### M-6 MEDIUM — Nothing uses the tunnel, and pointing `nasIp` at the tunnel breaks apply and rollback
- **Where:**
  - All RouterOS access, including apply and rollback (`nas-l2tp-client.service.ts:275`) and `mikrotik-sync.service.ts`, uses `nas.nasIp`.
  - No code path routes management traffic over `ulnasN` or the NAS tunnel address.
- **Impact:**
  - The audit requirement "management traffic uses the correct tunnel" is **not met**: the tunnel comes up but nothing uses it.
  - If an operator sets `nasIp` to the tunnel address to force this, apply cannot bootstrap (no tunnel yet). Rollback disconnects the tunnel first (`:569`) and then cannot reach the router.
- **Fix:** add an explicit management-host choice (public for bootstrap, tunnel once connected) and teach the sync/API clients to use it.

### M-7 MEDIUM — Deleting a NAS leaves its tunnel and root-owned files on the host
- **Where:** `NasL2tpConfig` cascades on NAS delete (schema), but no hook calls `dialer.purge()`. `purgeHost` (`:809`) is manual only.
- **Impact:** an orphaned, still-routed tunnel, plus `/etc/swanctl/conf.d/uplinko-nas-<id>.conf` containing an (encoded) PSK, remain indefinitely.

### L-1 LOW — smaller issues
- `l2tp-client-dialer.service.ts:189`:
  - `mkdir(..., {mode:0o700})` does not tighten an already-existing directory.
  - `writeFile` follows symlinks. The risk is low because both directories are root-owned, but use `O_NOFOLLOW` / `lstat` and an explicit `chmod 0700` on the directory.
- **Cross-NAS coupling** (`:423`, `:553`): `swanctl --load-all` loads every file. One malformed `uplinko-nas-*.conf` (for example from an interrupted write) makes every NAS's dial fail with `host_error`. Write to a temporary file and rename it into place.
- **Load from status polling:** `status()` runs about 8 root commands per GET (tooling check plus probes). Frequent polling across many NAS adds up, and there is no per-tenant rate limit on connect/status.
- **False route violations:** the default-route snapshot is compared exactly, so a DHCP renewal during a dial gives a false `route_violation`. Only the main routing table is checked; policy routing is not.
- **Error text:** raw RouterOS and exception text is returned in 400 messages (`:399`, `:479`, `:586`). No secret was observed in it, but sanitise it anyway.
- **`purgeHost` takes no lock**, so it can delete files under a running dial.
- **ESLint:** 2 `no-base-to-string` remain, plus the codebase-wide `no-unsafe-*` pattern.

---

## 2. Verified correct (by reading the code and by reproductions)

| Area | Result | Evidence |
|---|---|---|
| Direction | Uplinko initiates (`swanctl --initiate`, `xl2tpd-control add-lac lns=<NAS IP>`); the NAS is the L2TP server (`/interface/l2tp-server/server/set`) | dialer `:420–485`; service `:437–443` |
| PSK bound per NAS | `secrets { ike-<name> { id-1 = <NAS IP>; secret = 0s<base64> } }`; remote `id = <NAS IP>` | dialer `:297`, `:310–313` |
| PPP direction | `noauth` + `refuse-pap/chap/eap/mschap`, with no `require-*`, so the client authenticates to the NAS with MS-CHAPv2 | dialer `:331–335` |
| RouterOS address mapping | `local-address` = NAS tunnel IP and `remote-address` = Uplinko tunnel IP (correct RouterOS semantics) | service `:449–450` |
| Interface naming | `ifname ulnas<ID>` (≤15 characters), static `local:remote` | dialer `:324`, `:337` |
| Command injection | `execFile` with argv only; binaries are fixed; every interpolated value is validated (IPv4 regex, username regex, printable-no-quote secrets, integer ids) | dialer `:170–178`, validators `:118–146` |
| Path traversal | All paths are built from an integer NAS id | dialer `:200–215` |
| Secrets in commands | No PSK or password in any argv (test asserts this) | spec |
| Encryption at rest | AES-256-GCM (authenticated) via `crypto-box.ts:26–35`; snapshot tampering fails decryption | — |
| API masking | Views return only `has*` flags; preview masks the password | service `:96–120`; spec |
| Authorization order | `assertNasAccess` (tenant scope + NAS owner or platform owner) runs first in all 10 operations, before database writes, RouterOS calls or host commands. Route guard: JWT + `nas.read/write` (AUDITOR cannot write) | service; `permissions.guard.ts:91–135`; spec (10 cases) |
| Customer secrets | Only the `uplinko-mgmt-vpn` marker counts as Uplinko's; otherwise 409 with no writes | service `:430–432`; spec |
| Running-server key change | Needs `confirmServerChange` **when the key is readable** (see C-1 for when it isn't) | service `:359–360` |
| Per-NAS isolation | Unique connection, LAC, interface, config and log names; teardown only touches `<ID>` (test) | dialer `:200–215`, `:556–561` |
| Default route | `nodefaultroute`, no `usepeerdns`; only the /32 peer route; default-route snapshot compared | dialer `:339`, `:688–695` |
| Public NAS traffic | IKE and L2TP go to the NAS public IP over the normal route; only the /32 tunnel peer goes via `ulnasN` | — |

---

## 3. Unverified protocol assumptions (need real equipment)

1. `xl2tpd-control add-lac <name> lns=… pppoptfile=… autodial=no redial=no`: whether the installed xl2tpd version accepts several key=value arguments this way, and its exit codes and messages (the code also looks for "error" in the output).
2. The pppd on the target distro supports `ifname`, and accepts `password` from an option file passed by xl2tpd as root.
3. `swanctl --initiate --child <name>` for an IKEv1 transport connection, and the exact output of `--list-sas` that the status parser depends on.
4. Whether MikroTik RouterOS 6/7 dynamic L2TP IPsec peers accept the offered IKE proposals (aes256/aes128/3des with sha1 and modp2048/1024) and ESP without PFS.
5. Remote identity: `remote { id = <NAS IP> }` fails if the NAS sits behind 1:1 NAT and sends its private address as its identity.
6. That the host uses `charon-systemd` / swanctl with `conf.d` included, not the legacy `strongswan-starter` (`ipsec.conf`) setup.
7. RouterOS API field names and values: `use-ipsec`, `ipsec-secret`, `authentication` as a comma list, booleans as `true/false`, and whether `/ppp/secret print` returns `password`.
8. **Operational risk (not a code bug, HIGH):** enabling the NAS L2TP server opens UDP 500/4500/1701 on the NAS to the internet. **Existing customer PPP secrets with `service=any` then become usable over L2TP.** Apply adds no firewall restriction to Uplinko's address and does not require IPsec. Mitigate by restricting with an `/ip firewall` rule to the Uplinko public IP, or by requiring IPsec.

---

## 4. Database and migration

**Verified on a disposable PostgreSQL 16:**
- All 67 existing migrations applied in order.
- 3 existing `nas_l2tp_config` rows were created (legacy `state='approved'`, `publicHost='legacy.example'`).
- `20261121090000_nas_l2tp_client` then applied without error.
- The rows were kept, got `clientState='disconnected'`, and the legacy `state` was unchanged.
- Columns, types, nullability and defaults match `schema.prisma` exactly. Every timestamp is `TIMESTAMP(3)`, the snapshot column is `text`, and the unique index is `nas_l2tp_config_remoteAddress_key`, the name Prisma expects.
- **Uniqueness cannot fail on existing data:** the new column is all NULL, and PostgreSQL does not treat NULLs as equal. A duplicate value is rejected as intended (`duplicate key … nas_l2tp_config_remoteAddress_key`).
- A hand-written down step (dropping the 17 columns) succeeded, and re-applying afterwards succeeded. Prisma has no down migrations, so this rollback is manual.
- Applying the migration twice fails ("column … already exists"). That is normal for Prisma migrations, which run once, but it is not idempotent.

**NOT VERIFIED:** `prisma migrate diff` / `migrate deploy` (Prisma schema-engine binaries are blocked in this environment). The column-by-column comparison above is the substitute.

---

## 5. Test quality (65 new tests)

**Run:**

```
jest src/nas/l2tp-client-dialer.spec.ts src/nas/nas-l2tp-client.service.spec.ts
```

Exit 0: **65 passed.** This is the same result as the implementation report. The rest of the baseline (6 TypeScript errors, 10 environment-limited suites) was recorded earlier and is unchanged.

All 65 tests are **mock-only**. They do not show that a real MikroTik works with this code.

**Strengths:** they are behavioural tests against a stateful fake host and a fake router, not just "this mock was called" checks. Deliberately breaking the routing checks, the secret ownership check, the address mapping or the auto-restore made them fail.

**Gaps (each would have caught a confirmed bug above):**

| Gap | Missed |
|---|---|
| The fake router always returns `ipsec-secret` and `password`; there is no "sensitive hidden" case | **C-1** |
| The fake `swanctl --list-sas` returns only `ESTABLISHED`; there is no child-SA state | **H-1** |
| No exception or connection-drop mid-apply | **H-2** |
| Validation tests do not cover public or host-network tunnel addresses | **H-3** |
| No disconnect-during-connect, lock-expiry or concurrent-apply tests | **M-1, M-2, M-4** |
| No legacy-flow interaction test | **M-5** |
| No test runs the real `files.writeSecret` (modes, symlinks) or the real `execFile` runner | L-1 |
| The rollback test does not cover "router changed after apply" | M-4 |
| The timeout test fakes `Date.now`; real command time limits are not exercised | M-2 |

---

## 6. Outcome

**1. BLOCKED: critical defects exist.**

Blocking items before any real-hardware test on a NAS that has customers:
- **C-1:** the router's IPsec key can be overwritten without confirmation and then wiped.
- **H-1:** "Connected" does not prove encryption.
- **H-2:** a partial apply is not restored.
- **H-3:** a tenant can choose host routes.

Fix M-1 to M-7 before production. Real-hardware testing may only proceed after C-1 and H-1 to H-3 are fixed, and then only on an **isolated test MikroTik with no customers**.

The 65 passing tests are mocked and are **not** evidence of real MikroTik or strongSwan/xl2tpd compatibility.
