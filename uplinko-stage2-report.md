# UPLINKO ISP CRM — Stage 2: Per-NAS SNMP Monitoring

**Base commit:** `1d76830` ("Initial commit: Uplinko mobile dashboard").
**Deliverable:** `uplinko-stage2-snmp.patch` — applies cleanly to the base commit, and also cleanly on top of the Stage 1 patch (verified with `git apply --check` both ways).
**Not committed / not pushed.** No Stage 3 work. Branding, colours, shell and navigation unchanged.

---

## A. Executive summary

Stage 2 turns the **existing, disabled SNMP stack** into a reliable, scalable, **per-NAS, opt-in** monitoring system — it does not rewrite it.

The repository already contained a complete SNMP collector (`device-health.service.ts`: v1/v2c sessions, IF-MIB walks, 32/64-bit counter-delta rate maths with wrap and reboot handling, `monitoredPorts` filtering, SQL-bucketed history, a real `testSnmp` probe, and `DeviceMetric`/`InterfaceMetric` storage). It was switched **off** by a global `MONITOR_SNMP` flag because it polled *every* device on one 30-second timer (including 500 seeded demo routers), with no backoff and a CRITICAL alert on every failed packet — load and alert-storms.

Stage 2 fixes exactly those failure modes and adds what was missing:

- **SNMPv3 (USM)** — authPriv preferred, never a silent downgrade.
- A **per-NAS scheduler** (`SnmpMonitorService`) with each device's own interval, **bounded concurrency**, **per-NAS timeout**, **single-flight**, and **exponential backoff**; demo NAS excluded; runs on the primary instance only.
- **Operational state** per NAS (`NasSnmpState`) — status, last poll / last success, consecutive failures, next poll, redacted last error, sysDescr/uptime.
- **Events** (`NasEvent`) on **state transitions only**, with recovery events, resource-threshold events (CPU/memory/interface) under a **cooldown**, pushed to the existing live-feed (no second alerting system).
- **APIs**: status, paginated events, acknowledge; config read/update extended for SNMPv3 with server-side validation and secret masking.
- A **NAS "SNMP monitoring" UI section** (status, latest real metrics, event timeline + ack) in the existing Health tab, plus SNMPv3 fields in the Config tab.

**Is it safe for staging?** Yes — the backend compiles against the regenerated Prisma client on CI (engine download is firewalled here), the additive migration is safe on a live DB, and all 29 Stage 2 unit tests pass (plus 36 existing telemetry/NAS tests re-run green). It is **not yet production-ready**: the real-MikroTik pilot (§M) has **NOT been run** — no device was available in this environment.

---

## B. Stage 1 status

Stage 1 (D2 wallet integrity, S1 lockout, S3 first-boot admin, P1 router-presence, P2 session scoping) is present in the working tree and delivered separately as `uplinko-stage1-fixes.patch`. Stage 2 is independent of it: they touch different files except `backend/prisma/schema.prisma`, where their hunks are in different models (Stage 1: `SubscriberBalanceLedger`; Stage 2: `Nas` relations + new `NasSnmpState`/`NasEvent`). The Stage 2 patch was verified to apply both on pristine base and on base+Stage 1.

---

## C. Architecture implemented

```
          ┌──────────────────────── primary instance only ────────────────────────┐
  @Cron(10s) dispatch()  ──selectDue()──▶  NAS where snmpEnabled & active & !demo
  SnmpMonitorService         (nextPollAt ≤ now)                 & nextPollAt due
        │  mapLimit(concurrency=10)  +  withTimeout(per-NAS budget)  + inFlight set
        ▼
    pollNas(nas) ──▶ DeviceHealthService.collectOne(nas)  ── net-snmp ──▶ device
        │                │  probe → classify (timeout/auth/unreachable/config)
        │                │  readHealth + IF-MIB walks → DeviceMetric / InterfaceMetric
        ▼                ▼  returns {ok, kind, sysDescr, uptime, cpu, mem, downIfaces}
    writeState(NasSnmpState)   ·   raiseEvents(NasEvent, on TRANSITION only)
        │  backoff: nextPollAt = now + min(interval·2^failures, maxBackoff)
        ▼
    EventsService.broadcast('nas-event', …ownerUserId)   → existing live feed
```

- **Collector** (`device-health.service.ts`) is now stateless "poll one device, return a classified result"; it no longer runs its own global sweep.
- **Scheduler/state/events** live in the new `SnmpMonitorService`.
- **Reuses** the existing `net-snmp` dependency, `oids.ts`, `nas-credentials.ts` (encrypt/mask), `EventsService`, `ScopeService`, `mapLimit`/`withTimeout`, `isPrimaryInstance`, and the `DeviceMetric`/`InterfaceMetric` tables. No new queue, no second monitoring platform, no new runtime dependency.

---

## D. Files changed

**New (backend):**
- `prisma/migrations/20261101140000_nas_snmp_monitoring/migration.sql` — additive tables.
- `src/telemetry/snmp-monitor.service.ts` — scheduler, state, events, backoff, single-flight, read API.
- `src/nas/nas-snmp-config.ts` — version normalisation, clamp, monitoredPorts normalisation, SNMPv3 validation.
- `src/telemetry/snmp-monitor.spec.ts`, `src/telemetry/snmp-collector.spec.ts`, `src/nas/nas-snmp-config.spec.ts` — tests.

**Modified (backend):**
- `prisma/schema.prisma` — `NasSnmpState`, `NasEvent` models + two relations on `Nas` (additive).
- `src/telemetry/device-health.service.ts` — SNMPv3 session, `collectOne` + probe + error classification, `POLL_SELECT`, removed the fixed 30 s global `@Cron`, `NasEvent` retention.
- `src/telemetry/telemetry.controller.ts` — `snmp-status`, `snmp-events`, event `ack` endpoints.
- `src/telemetry/telemetry.module.ts` — register `SnmpMonitorService`.
- `src/nas/nas.service.ts` — SNMPv3/timeout/retries/monitoredPorts config handling, validation, enable/disable events; uses the new helpers.

**New / modified (frontend):**
- `app/nas/[id]/monitoring-status.tsx` *(new)* — the monitoring status + events + ack section.
- `app/nas/[id]/tabs-health.tsx` — renders the new section.
- `app/nas/[id]/tabs-config.tsx` — SNMPv3 fields + monitored-interfaces + a v2c clear-text warning.
- `app/nas/[id]/lib.ts` — `NasRecord` SNMPv3 fields/has-flags (no secrets).

---

## E. Database migrations

`20261101140000_nas_snmp_monitoring` — **additive, safe on a live DB**, no change to existing tables/data. All objects `IF NOT EXISTS`.

- `nas_snmp_state` (PK `nasId`, FK→`nas` ON DELETE CASCADE): status, lastPollAt, lastSuccessAt, lastErrorAt, lastError (redacted), consecutiveFailures, nextPollAt, sysDescr, uptimeSec, updatedAt. Indexes on `status`, `nextPollAt`.
- `nas_event` (PK `id`, FK→`nas` CASCADE): type, severity, message (redacted), details JSONB, ts, ownerId (denormalised for scoped reads), acknowledged/at/by. Indexes on `(nasId, ts)`, `(nasId, type, ts)`, `(acknowledged, ts)`, `(ownerId, ts)`.

**No existing NAS record changes** — SNMP stays `snmpEnabled=false` by default, so existing devices keep operating unchanged. **Rollback:** `DROP TABLE IF EXISTS "nas_event"; DROP TABLE IF EXISTS "nas_snmp_state";`

No `Float`→`Decimal` or other destructive migration. No table converted to a hypertable.

---

## F. API changes

All under `/telemetry`, guarded by `JwtAuthGuard` + `PermissionsGuard`, tenant-scoped via `scope.assertNas(user, id)` before any work. Secrets are never returned.

| Method & path | Purpose |
|---|---|
| `GET /telemetry/nas/:id/snmp-status` | Current state + latest metrics + interface up/down counts (no credentials). |
| `GET /telemetry/nas/:id/snmp-events?limit&cursor&type&acknowledged` | Paginated events (cursor by id desc, page size capped at 100). |
| `POST /telemetry/nas/:id/snmp-events/:eventId/ack` | Acknowledge one event (must belong to that NAS). |
| `POST /telemetry/nas/:id/snmp-test` *(existing)* | Live probe; now also supports SNMPv3. |
| `GET /telemetry/nas/:id/health-history`, `/interfaces`, `/interfaces/:ifIndex/history` *(existing)* | Bucketed history / interface list. |
| `PUT /nas/:id` *(existing, extended)* | Config read/update: SNMPv3 username/level/protocols/passphrases, timeout, retries, monitoredPorts — validated, passphrases masked. |

Config reads (`GET /nas/:id`) return masked secrets with `hasX` flags (`sanitizeNas`). Updates treat a masked value as "unchanged".

---

## G. Worker / scheduler behaviour

- **Per-NAS interval**: `nextPollAt` on `NasSnmpState`; `dispatch()` runs every 10 s but only polls NAS that are due.
- **Bounded concurrency**: `mapLimit(due, SNMP_MONITOR_CONCURRENCY=10)` — never an unbounded `Promise.all`.
- **Per-NAS timeout**: `withTimeout(collectOne, (timeout·(retries+1))+25s)` so a half-answering device still frees its slot; the collector also has internal per-request timeouts.
- **Single-flight**: an in-process `inFlight` set + an optimistic `nextPollAt` claim before polling, so overlapping ticks never double-poll a NAS; `isPrimaryInstance()` keeps the cluster to one poller.
- **Exponential backoff**: `nextPollAt = now + min(interval·2^(failures-1), SNMP_MONITOR_MAX_BACKOFF_SEC=900)`.
- **One failed NAS never blocks others**: each poll is isolated; a throw is caught and recorded as a timeout state. (Test: `dispatch` with NAS 2 throwing still records NAS 1 and 3 as `ok`.)
- **Restart-safe**: all scheduling state is in the DB (`nextPollAt`), not memory; a restart resumes from it.
- **Disabled handling**: selection filters `snmpEnabled=true`; turning it off writes a `monitoring_disabled` event and sets state `disabled`. Master off-switch `SNMP_MONITOR=off`.
- **Tunables (env)**: `SNMP_MONITOR`, `SNMP_MONITOR_CONCURRENCY`, `SNMP_MONITOR_MAX_BACKOFF_SEC`, `SNMP_CPU_HIGH_PCT`, `SNMP_MEM_HIGH_PCT`, `SNMP_ALERT_COOLDOWN_SEC`, `METRIC_RETENTION_DAYS`, `EVENT_RETENTION_DAYS`.

---

## H. SNMP security implementation

- **SNMPv3 authPriv preferred**; `assertSnmpConfigValid` rejects an incomplete v3 config (missing username, missing/invalid security level, missing auth/priv passphrase or protocol) — **never a silent downgrade** to a weaker level or to v2c.
- **v2c allowed only as an explicit choice**, with a clear-text **warning in the UI**.
- **Credentials encrypted at rest** via the existing `SecretsService` (`encField`/`decField`), same key management as RADIUS/API secrets. The community and both v3 passphrases are in `SECRET_FIELDS`.
- **Never returned decrypted**: `sanitizeNas` masks them in every API response; the status/event APIs select only non-secret fields.
- **No secret in logs, errors, events or state**: poll failures are classified to **fixed, operator-friendly messages** built without the raw error text or the credential (verified by test — a timeout message never contains the community; an auth-failure message never contains the passphrase). `lastError` on `NasSnmpState` stores only that redacted text.
- **No auto-populated credentials** — operator-entered only.

---

## I. Metrics & OIDs supported

From `oids.ts` (standard IF-MIB works on every device; health OIDs are per-device-type with a generic fallback):

- **Identity/health**: `sysDescr` (1.3.6.1.2.1.1.1.0), `sysUpTime` (…1.3.0), CPU, memory (ratio used/total), temperature — each only where the device answers; **SNMP response time** (`snmpMs`); poll success/failure + last-success time (state).
- **Interfaces** (per ifIndex): `ifName`/`ifDescr`, `ifOperStatus`, `ifHighSpeed`, 64-bit `ifHCInOctets`/`ifHCOutOctets` (fallback to 32-bit), `ifInErrors`/`ifOutErrors`, `ifInDiscards`/`ifOutDiscards`. `ifAdminStatus` and `ifPhysAddress` OIDs are defined for future use.
- **Rate maths**: raw counters are kept per NAS+ifIndex; rates are computed from deltas with explicit 32-bit wrap handling and 64-bit-reset → 0 (no false spike). Reboot (sysUpTime regress) drops that sample's baseline.
- **No fabrication**: a failed probe writes **no** metrics; an unsupported/missing OID is simply absent (shown as "—" in the UI), never stored as 0. Out-of-range values (CPU/mem outside 0–100, impossible temps, rates above line-speed) are discarded.

OIDs are the commonly-published MikroTik/IF-MIB bases; they are validated against the real device in the pilot (§M), not asserted from mocks.

---

## J. Tests executed & results

Run with `ts-jest` transpile-only (Prisma client mocked). **29 Stage 2 unit tests pass**, and **36 existing telemetry/NAS tests re-run green** after the changes.

**`snmp-monitor.spec.ts` (12):** first-success is quiet; failure transition event + dedup on repeat + recovery event; exponential backoff grows; no-fabrication on failure (no sysDescr/uptime stored); single-flight skip; `dispatch` — one throwing NAS doesn't block others; cpu_high cooldown dedup; interface_down→up on set change; disabled via `SNMP_MONITOR=off`; events pagination + cursor + page-size cap; ack marks + rejects foreign id.

**`snmp-collector.spec.ts` (6):** timeout classified + **no metrics written** + message doesn't leak the community; SNMPv3 auth failure classified without leaking the passphrase; **SNMPv3 authPriv USM session built** (never a community session); success returns identity/uptime + records metrics; `rate()` 64-bit reset→0 and 32-bit wrap; no-IP → `config_error`.

**`nas-snmp-config.spec.ts` (11):** clampInt ranges; monitoredPorts CSV/JSON/array→null; version normalisation (1/2c/3/V3→enum); v3 validation accepts complete authPriv and **rejects** missing username / level / priv passphrase / auth passphrase; uses existing stored passphrases on a level-only change; **secret redaction** — community + v3 passphrases masked, has-flags exposed, username (non-secret) shown.

**Regression:** `telemetry-tenancy`, `nas-tenancy`, `nas-ownership` (36) pass. (The controller's new constructor arg was appended last so existing positional test construction stays valid; NestJS DI is type-based.)

**Frontend:** `tsc --noEmit` **passes (0 errors)**; `next build` **succeeds (exit 0)**.

**Patch self-containment:** applied to a clean checkout of base `1d76830` + the Stage 1 patch; the full 29-test Stage 2 suite passes there.

---

## K. Tests NOT executed & why

- `prisma generate` / `prisma validate`, full backend `tsc`, full Jest suite, `npm run build` (backend): the **Prisma engine download is firewalled** here (`binaries.prisma.sh` → 403). The schema follows the existing model conventions; these must be run on your CI (which has engine access). Unit tests above are unaffected (transpile-only + mocked client).
- Real SNMP I/O against a device — see the pilot (§M), **NOT RUN**.
- Multi-instance cluster behaviour against live Redis — covered logically (`isPrimaryInstance` + DB-held `nextPollAt`) but not run on a cluster here.

No test is claimed to have passed that was not actually run.

---

## L. Known limitations & remaining risks

- **OIDs unverified on hardware** — validated only against mocks here; confirm on a real RouterOS in the pilot before trusting CPU/memory OIDs across versions.
- **Storage growth** (see §N): at the default 30 s interval, interface samples dominate; retention / interval must be tuned per deployment. The monitoring tables are **not** hypertables (deliberately — no unrelated-table conversions); making `device_metric`/`interface_metric` Timescale hypertables is a documented optional follow-up.
- **Alerts** use `NasEvent` + the existing live feed (the `Alert` table is `NetworkDevice`-bound and has no NAS link). Deeper `Alert`/`Notification` bridging is a follow-up, not a second alerting system.
- **Interface errors/discards thresholds** are collected and stored but not yet alerted on (only interface up/down, CPU, memory, reachability raise events).
- **Traps / syslog**: not implemented (see §O) — polling does not depend on them.
- SNMPv3 config is set via the NAS update endpoint; the create endpoint keeps `snmpEnabled=false` defaults (configure after creation).

---

## M. Real MikroTik pilot — **NOT RUN**

No MikroTik device was reachable from this environment, so end-to-end SNMP was not exercised. Run this before declaring production readiness:

1. On a test MikroTik: `/snmp set enabled=yes`; add an SNMPv3 user `/snmp community` (v3 USM, SHA/AES) or a v2c community for a first smoke test; restrict with an address ACL to the Uplinko host.
2. In Uplinko: open the NAS → Configuration → set SNMP enabled, version, and credentials; save.
3. Click **Test SNMP** (`snmp-test`) → expect uptime, sysDescr, interface count, CPU/memory.
4. Confirm device identity + uptime on the Health tab's monitoring panel.
5. Confirm CPU/memory populate (or show "—" if the OID is unsupported on that RouterOS — not 0).
6. Confirm interface discovery (up/down counts, names).
7. Let it run two intervals; confirm traffic rates on the interface graphs look sane (not spikes).
8. Disable SNMP on the MikroTik → within one interval + backoff, state becomes `timeout`/`unreachable` and an event is raised (not a storm).
9. Re-enable → a `poll_recovered` event and `ok` state.
10. Confirm a second NAS keeps its own cadence throughout (independent scheduling).

---

## N. Data retention & expected growth

- **Writers**: per enabled NAS per poll — up to ~5 device-metric rows (cpu/memory/uptime/temperature/snmpMs) + one interface-metric row per monitored interface.
- **Rough estimate** at 30 s polling: a NAS with 24 interfaces ≈ 2,880 polls/day → ~14.4k device rows + ~69k interface rows per NAS per day. 100 such NAS ≈ **1.4M device + 6.9M interface rows/day**; at the 30-day default that is tens of millions of rows (~GB-scale with indexes).
- **Controls**: only `snmpEnabled` NAS are polled; `monitoredPorts` limits interfaces; `METRIC_RETENTION_DAYS` (default 30) prunes raw samples nightly; **events** prune on their own longer window (`EVENT_RETENTION_DAYS`, default 90) since they are low-volume.
- **Recommendations**: raise the per-NAS interval (60–120 s) for large fleets; shorten metric retention and rely on the existing SQL bucketing for long ranges; for very large deployments, consider making `device_metric`/`interface_metric` Timescale hypertables with a retention policy (optional migration, not included).

---

## O. Traps & syslog — separate plan (not implemented)

The schema has `syslogEnabled`/`syslogPort` per NAS but there is no receiver, and none is added here — polling does not need them. A safe future addition would be: a single UDP syslog listener and an SNMP-trap receiver, each **independently** toggled; verify sender identity against the NAS IP; normalise into `NasEvent` with the same transition/dedup rules; and document firewall exposure (bind to the management interface only, rate-limit, never a wide-open public UDP port). These must not be required for basic polling.

---

## P. Deployment instructions

1. **Apply** on base `1d76830` (or base + Stage 1): `git apply uplinko-stage2-snmp.patch` (check first with `git apply --check`).
2. **Backend** (host with Prisma engine access): `cd backend && npx prisma generate && npm run typecheck && npm test && npm run build`.
3. **Migrate**: `npm run db:deploy` (applies `20261101140000_nas_snmp_monitoring`; additive).
4. **Enable**: the monitor runs by default on the primary instance; set `SNMP_MONITOR=off` to disable, or tune the env knobs in §G. Ensure `net-snmp` is installed (it already is in `package.json`).
5. **Per device**: enable SNMP on the NAS form and enter credentials (SNMPv3 authPriv recommended). Existing NAS stay off until you do.
6. **Verify**: run the pilot (§M) on one device before enabling fleet-wide.

**Rollback:** `git apply -R uplinko-stage2-snmp.patch`; then `DROP TABLE IF EXISTS "nas_event"; DROP TABLE IF EXISTS "nas_snmp_state";`. Existing functionality is unaffected either way.

---

## Q. Scope & safety

No changes to WireGuard/SSTP/L2TP-IPsec, RADIUS auth, subscriber, billing/wallet, NAS provisioning, or authentication. No second monitoring platform or duplicate scheduler (the old fixed-interval sweep was replaced, not duplicated). No new runtime dependency. No commit/push. Stage 3 not started.
