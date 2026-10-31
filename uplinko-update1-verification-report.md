# UPLINKO ISP CRM — Update 1 Verification Report

**Date:** 2026-10-31  
**Scope:** Verify the delivered Stage 1 and Stage 2 patches against the checked-out source; validate the available CI checks; prepare a staging pilot checklist.  
**Classification:** VERIFIED, FAILED, BLOCKED, PENDING, or NOT APPLICABLE.

## Executive result

**Release readiness: FAILED for staging as a pilot release; NOT production-ready.**

The Stage 1 and Stage 2 reports and patch files are present, but their implementation changes are **not in the checked-out source**. The patches pass a forward `git apply --check` against this HEAD, but were not applied. The branch’s latest commit is titled “Add stage 1 & 2 reports and patches”; source evidence confirms key Stage 1 protections and the Stage 2 SNMP monitor/UI are absent. Do not treat either report or patch as evidence that its changes are deployed.

No source fixes were made. No patch was created for this update. Do not enable SNMP or run migrations against production. A controlled staging pilot should begin only after the stage changes are integrated, the required CI checks pass on a supported runner, and the staging checklist below is followed.

## Repository state and patch inspection

- **Branch:** `main`
- **HEAD:** `c38b417ae16442ea9a4d7de9edc6d42b483b99da`
- **Remote:** `origin/main`; initially up to date.
- **Initial working tree:** clean; no staged, modified, or untracked files.
- **Toolchain:** Node `v24.18.0`, npm `11.16.0`.
- **Reports found:** [UPLINKO-STAGE1-REPORT.md](UPLINKO-STAGE1-REPORT.md), [uplinko-stage2-report.md](uplinko-stage2-report.md).
- **Patches found:** [uplinko-stage1-fixes.patch](uplinko-stage1-fixes.patch), [uplinko-stage2-snmp.patch](uplinko-stage2-snmp.patch).
- No separate `jointbox-stage2-snmp-monitoring.md` was found.

Both patches are based on commit `1d76830`. `git apply --check` returned exit code 0 for each against current HEAD. Reverse checks failed because their changes are not present (including files that the patches add). These were read-only checks; neither patch was applied. The Stage 2 patch contains the reported v3 session, scheduler/state/events, APIs, schema and UI additions; those additions are absent from this checkout.

The supplied reports describe tests/builds run against their patched base trees. Those historical claims were not reproduced here and do not establish that the current `main` source contains or passes Stage 1/2.

## Stage 1 verification

| Requirement | Status | Evidence from current source |
|---|---|---|
| Wallet transaction atomicity and idempotency | **FAILED** | `SubscriberBalanceLedger` has no `idempotencyKey`; the Stage 1 ledger migration and wallet regression specs are absent. Some other code paths use atomic increments, but that does not verify the delivered ledger idempotency/transaction behavior. |
| Distributed login lockout | **FAILED** | [auth.service.ts](backend/src/auth/auth.service.ts) stores failed attempts in an in-process `Map`, clears it after it grows past 50,000 entries, and does not use Redis-backed counters. |
| Secure first-boot administrator setup | **FAILED** | [main.ts](backend/src/main.ts), [platform-account.ts](backend/src/common/platform-account.ts), [install.sh](install.sh), and [backend/.env.example](backend/.env.example) retain known password fallbacks/defaults; bootstrap code also logs the default-login setup. The generated one-time secret/file behavior from the Stage 1 patch is absent. |
| Bounded router-presence polling | **FAILED** | [subscribers.service.ts](backend/src/subscribers/subscribers.service.ts) uses `Promise.all` over all selected NAS devices. There is no per-device timeout or bounded `mapLimit` in that path, and the query does not exclude demo NAS. |
| SQL-level reseller/tenant session scoping | **FAILED** | [network.service.ts](backend/src/network/network.service.ts) fetches all live sessions for non-admins, enriches them, then slices the result in memory. The SQL helper has no username-scope argument for this path. |
| Stage 1 regression tests | **BLOCKED** | The patch-provided wallet, lockout, bootstrap, router-presence and session-scope specs are absent from the source tree. Backend Jest could not run because dependencies were not installed. |

## Stage 2 verification

| Requirement | Status | Evidence from current source |
|---|---|---|
| Per-NAS basic SNMP settings and default off | **VERIFIED** | The limited existing fields include per-NAS enabled/version/community/port/interval/timeout, and `snmpEnabled` defaults false. The older `MONITOR_SNMP=1` global switch is separate. The community defaults/falls back to the public community if left empty. This does not establish Stage 2 monitoring. |
| SNMPv3 USM/authPriv and no downgrade | **FAILED** | [device-health.service.ts](backend/src/telemetry/device-health.service.ts) creates community sessions only: V1 selects V1; every other version selects V2c. A NAS configured as V3 therefore falls through to V2c; no v3 USM authPriv session or v3 validation is present. |
| Encrypted credentials and redaction | **VERIFIED** | Existing configured secret fields, including v3 passphrase columns, are encrypted/masked by [nas-credentials.ts](backend/src/nas/nas-credentials.ts). However, the current `snmp-test` catch path returns the raw exception message; redaction of all SNMP failures is not verified. |
| Per-NAS interval, timeout/retries, bounded concurrency and exponential backoff | **FAILED** | The collector uses a global 30-second cron and sequentially walks the selected list. It does not use the configured per-NAS interval or a bounded dispatcher/backoff. Although the existing form/schema have timeout/retry fields, the current NAS update handler does not persist those fields. |
| Per-NAS timeout and single-flight | **FAILED** | A global `busy` flag prevents overlapping sweeps, and subtree reads have a fixed 12-second completion timer. There is no per-NAS flight guard/timeout or per-device backoff. |
| Primary-instance and demo-NAS exclusions | **VERIFIED** | The current collector checks `isPrimaryInstance()` and its query uses `NON_DEMO_OWNED`. |
| Identity, uptime, interface metrics and counter handling | **VERIFIED** | The older [device-health.service.ts](backend/src/telemetry/device-health.service.ts) reads health OIDs, interface state and 64-bit counters with 32-bit fallback; it handles 32-bit wrap, 64-bit decreases and uptime regressions, and stores device/interface metrics. This is source-level evidence only; no real device behavior was tested. |
| Unsupported values distinguished from zero | **FAILED** | Missing health OIDs are omitted, but interface rates initialize to zero and can be emitted as zero when a later poll lacks counters while a prior baseline exists. This behavior is not covered by an available regression test. |
| `NasSnmpState` / `NasEvent` persistence and transition events | **FAILED** | These models, their migration, the Stage 2 monitor service, transition/recovery handling, deduplication and event acknowledgement are absent. Existing generic live-feed/events are not the proposed per-NAS event system. |
| Tenant-scoped status/event APIs, pagination and acknowledgement | **FAILED** | Existing health endpoints call `scope.assertNas`, but the Stage 2 status/events routes, cursor pagination and acknowledgement endpoint do not exist. |
| Metric and event retention | **VERIFIED** | Existing device/interface metric pruning is scheduled and uses `METRIC_RETENTION_DAYS` (default 30). Event retention is not present because no `NasEvent` table or event-retention task exists. |
| NAS Health configuration/monitoring UI | **FAILED** | Existing NAS pages expose basic SNMP version/community/polling fields and health graphs. They do not provide the Stage 2 v3 fields, monitoring-state panel, per-NAS events or acknowledgement controls. The `SNMPv3` version option does not make the current backend collector support v3. |
| Stage 2 unit tests | **BLOCKED** | `snmp-monitor.service.ts`, `snmp-monitor.spec.ts`, `snmp-collector.spec.ts` and `nas-snmp-config.spec.ts` are absent. |

## Backend CI and combined regression

The backend and frontend `npm ci` attempts did not complete. The online runs spent many minutes fetching packages; npm logs show registry responses taking several minutes per tarball. The offline retry reported missing cached tarballs. The install processes were stopped after prolonged non-completion. No Prisma 403 was observed in this run because generation was not reached.

| Check | Status | Result |
|---|---|---|
| Backend dependency install from lockfile | **BLOCKED** | `npm ci` from the repository root failed because there is no root lockfile. Correctly scoped backend install did not complete; see [test results](uplinko-update1-test-results.md). |
| Prisma generate | **BLOCKED** | `npm run prisma:generate` failed because the local `prisma` executable was unavailable after incomplete dependency installation. |
| Prisma schema validation | **BLOCKED** | `npx --no-install prisma validate` could not resolve a local Prisma CLI; it did not validate the schema. |
| Backend TypeScript check | **BLOCKED** | `npm run typecheck` could not find local `tsc`. |
| Backend production build | **BLOCKED / not run** | The package build begins with `npm run clean`, which deletes the pre-existing ignored `backend/dist`. To preserve that pre-existing output, the build was not run; the Prisma CLI was also unavailable. No backend build is claimed to pass. |
| Stage 1, Stage 2 and backend regression suites | **BLOCKED** | `npm test -- --runInBand` could not find `jest`; Stage-specific specs are absent. Authentication, billing, NAS, telemetry, RADIUS, VPN and tenant regressions therefore remain unverified. |
| Frontend dependency install | **BLOCKED** | Correctly scoped install did not complete; local frontend tool binaries were unavailable. |
| Frontend TypeScript check, build and lint | **BLOCKED** | `tsc`, `next` and `eslint` were unavailable; no typecheck/build/lint pass is claimed. Existing `.next` output was preserved. |
| Frontend unit tests | **VERIFIED** | `npm run test:unit`: 16 passed, 0 failed. These are existing CSV/spreadsheet tests, not NAS Health tests. |
| Migrations | **NOT APPLICABLE in this verification** | No migration was run. The two Stage migrations exist only in the unapplied patches. |

## MikroTik pilot

**PENDING.** No real MikroTik device was provided or verified as reachable. No simulated test is represented as a successful pilot. Stage 2 is not production-ready without the real-device validation.

After Stage 2 is integrated and its CI passes, use one non-production NAS only:

1. Restrict its SNMP ACL to the staging backend’s management IP. Configure SNMPv3 USM **authPriv** using the agreed SHA/AES protocols; do not use production credentials.
2. Keep every other NAS SNMP-disabled. Configure the pilot NAS and run the live SNMP test.
3. Confirm returned identity and uptime; discover interface names/indices and up/down status.
4. Observe at least two polling intervals. Confirm plausible traffic rates, 32/64-bit counter behavior, and no spike after a counter reset or reboot.
5. Confirm CPU/memory only when supported; unsupported values must render unavailable rather than as fabricated zero.
6. Test timeout/unreachable and incorrect credentials. Confirm clear redacted errors, one transition event, deduplication during repeated failures, and one recovery event.
7. While the pilot NAS is unavailable, confirm another enabled NAS continues its own polling cadence.
8. Inspect API responses and application logs to confirm no community, username secret, authentication passphrase or privacy passphrase is exposed.
9. Keep the pilot disabled until all checks pass; do not enable SNMP fleet-wide as part of this test.

## Staging deployment checklist

**Do not use the current HEAD as the Stage 1/2 staging release.** First integrate the intended patches in an authorized staging code change, resolve the CI dependency issue, and repeat the checks. This checklist is for that later controlled staging deployment; it is not authorization to migrate production.

1. **Environment and secrets**
   - Configure `NODE_ENV=production`, `DATABASE_URL`, a unique high-entropy `JWT_SECRET`, `ADMIN_PASSWORD`, and an explicit strong `PLATFORM_ADMIN_PASSWORD`. The checked-in example/defaults are not acceptable values.
   - Set and preserve a stable `SECRETS_KEY`; changing it can make stored credentials undecryptable. Keep it separate from routinely rotated login tokens.
   - For clustered processes, configure a reachable `REDIS_URL` and `REDIS_REQUIRED=true`; configure the RADIUS database/server variables required by the deployment.
   - After the Stage 2 patch is integrated, document and set its supported knobs (`SNMP_MONITOR`, concurrency/backoff, alert thresholds/cooldown, metric/event retention) explicitly. Do not assume those variables exist in the current HEAD.
   - Never put SNMP communities or passphrases in shell history, reports, ticket text or log statements.
2. **SNMP feature flags/defaults**
   - Current source has per-NAS `snmpEnabled=false` by default and the legacy global `MONITOR_SNMP` gate. Leave SNMP disabled; do not set `MONITOR_SNMP=1` for the current checkout.
   - The Stage 2 patch uses `SNMP_MONITOR=off` as its master stop switch. Use that only after the patch is integrated; keep all NAS disabled until the single-device pilot is approved.
3. **Database backup**
   - Against the staging database only, create a protected, access-controlled custom-format backup before migrations (for example, `pg_dump --format=custom --file="$BACKUP_FILE" "$DATABASE_URL"` from the deployment host).
   - Verify the file exists, is non-empty, and can be read by the designated restore operator. Do not print the connection URL or credentials. Store the backup outside the web root and restrict access.
4. **Migration order and rollback**
   - The Stage 1 patch proposes `20261101120000_ledger_idempotency_key`; Stage 2 proposes `20261101140000_nas_snmp_monitoring`. Neither migration is in this checkout’s migration directory.
   - On staging only, first deploy the integrated application/schema, then use the repository’s `npm run db:deploy` migration process in timestamp order. Check migration status and logs before enabling any NAS.
   - Roll back the application first and disable SNMP. Preserve the additive tables/column unless a reviewed rollback is necessary and data-retention consequences are understood. Restore only into staging; never run destructive rollback SQL against production.
5. **Workers and scheduler**
   - Start the API and exactly one scheduler/primary worker according to the existing PM2 deployment configuration. For a dedicated worker, set `WORKER_INSTANCES` as documented and ensure `REDIS_URL` is available. Do not start duplicate scheduler instances.
   - Verify worker, Redis and database health before enabling the pilot NAS.
6. **Permissions and network**
   - Permit the staging backend to reach only the pilot device’s management address on UDP 161; restrict the MikroTik SNMP ACL to that backend source IP. Do not expose SNMP to the public internet.
   - Ensure the application’s existing database, Redis, RouterOS API and RADIUS network requirements remain available. Limit pilot configuration and event access to authorized NAS operators.
7. **Monitoring/logs**
   - Use the deployment’s configured process-manager logs and application health endpoint. Check scheduler startup, poll duration/failures, database growth and worker restarts.
   - Do not enable verbose packet/credential logging. Redact secrets before sharing logs.
8. **Existing monitoring regression**
   - Before and during the pilot, verify the existing NAS overview/health, RouterOS API connectivity, RADIUS accounting and active-session views, and existing telemetry feed.
   - Compare a known NAS’s active sessions and traffic before/after enabling the pilot. Confirm that non-SNMP monitoring still works when SNMP is disabled.
9. **Safe disable and rollback**
   - Disable SNMP on the pilot NAS and set the integrated Stage 2 master flag to `SNMP_MONITOR=off`; restart the scheduler/worker if required. On the current checkout, keep legacy `MONITOR_SNMP` unset/not `1`.
   - Confirm no new polls/events are emitted and existing RouterOS/RADIUS monitoring continues. Roll back the application only after preserving logs and the staging database backup.
   - Do not remove additive schema objects or perform any production migration/rollback as part of this pilot.

## Fixes and final readiness

- **Issues found:** Stage 1/2 patches are not applied; several Stage 1 requirements fail in current source; current SNMP V3 selection silently falls back to V2c; the Stage 2 scheduler, persistence, APIs and UI are absent; dependency installation prevented backend/frontend CI validation.
- **Fixes made:** None. Implementing or applying the delivered stage patches would exceed this verification-only task and could overwrite intended newer work.
- **Source changes:** None.
- **New fixes patch:** None.
- **Staging:** Not safe to begin as a Stage 1/2 pilot on this HEAD.
- **Production:** Not ready. Before production, integrate the changes, run the full backend and frontend CI on a runner with working dependency/Prisma downloads, verify tenant/auth/billing/NAS/RADIUS/VPN regressions, and pass the real MikroTik pilot.
