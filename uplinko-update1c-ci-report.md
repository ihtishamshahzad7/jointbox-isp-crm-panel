# UPLINKO ISP CRM — Update 1C CI and Staging Readiness

## Outcome: PARTIAL

Stage 1 and Stage 2 remain integrated on the isolated integration branch. The
Update 1C dependency, build, type-check, unit-test, and focused regression
results provide useful evidence, but repository-wide lint and the full backend
test run are not green. Disposable-database migration validation and a real
MikroTik pilot are still outstanding. Do not merge to `main`, run staging
migrations, or declare production readiness on this evidence.

## Repository state and scope

- Worktree: `F:\Jointbox panel-update1b-integration`
- Branch: `uplinko/update1b-integration`
- Starting and final HEAD: `3a0bc22d191ae78a6b782ab0ff6e31db1aea03a9`
- Expected integration base: `3a0bc22`
- Original worktree: `F:\Jointbox panel`, branch `main`, same HEAD; it remains
  separate and unchanged.
- Existing Stage 1/2 integration changes and Update 1B deliverables were
  preserved. No commit, push, merge, deployment, production migration, or
  destructive Git operation occurred.
- Package manifests and lockfiles were not changed.
- Additional Update 1C source/test fixes are captured in
  `uplinko-update1c-fixes.patch` (20 files; 410 insertions, 112 deletions).
  Its `git apply --check` succeeded against the reconstructed Stage 1/2
  integration baseline. It is an incremental patch, not a replacement for the
  Stage 1/2 integration patch.
- Final `git -c core.whitespace=cr-at-eol diff --check` passed. The default
  `git diff --check` treats CR characters in the mixed-line-ending
  `backend/src/nas/radius-sync.service.ts` diff as trailing whitespace; no
  content cleanup was made. Git also warned that `install.sh` may normalize
  from CRLF to LF on a future write.

### Update 1C files in the incremental fixes patch

- `backend/.env.example`
- `backend/src/common/bootstrap-credentials.spec.ts`
- `backend/src/common/bootstrap-credentials.ts`
- `backend/src/common/db-push-safety.spec.ts`
- `backend/src/common/platform-account.spec.ts`
- `backend/src/logs/network-log-tenancy.spec.ts`
- `backend/src/main.ts`
- `backend/src/nas/nas-snmp-config.spec.ts`
- `backend/src/nas/nas-snmp-config.ts`
- `backend/src/nas/nas.service.ts`
- `backend/src/nas/radius-tenancy-boundary.spec.ts`
- `backend/src/network/network.service.spec.ts`
- `backend/src/telemetry/device-health.service.ts`
- `backend/src/telemetry/snmp-collector.spec.ts`
- `backend/src/telemetry/snmp-monitor.service.ts`
- `backend/src/telemetry/snmp-monitor.spec.ts`
- `frontend/app/nas/[id]/monitoring-status.tsx`
- `frontend/app/nas/[id]/snmp-version.ts`
- `frontend/app/nas/[id]/tabs-config.tsx`
- `frontend/tests/snmp-version.test.ts`

## Dependency resolution

`npm ci` succeeded in both `backend` and `frontend`, using each existing
`package-lock.json`. The earlier frontend test import failure was caused by
dependencies not being installed: `read-excel-file@9.3.10` was already
declared in the frontend manifest and lockfile. No arbitrary dependency or
version change was needed. After installation, the frontend unit suite
including the spreadsheet test passed.

## Stage 1 verification

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Atomic wallet update and idempotency | VERIFIED | Wallet service and regression tests were reviewed; the focused 13-suite regression run passed, including wallet tests. The database-backed concurrency harness was not run on this Windows host. |
| Distributed login lockout and fail-closed Redis behavior | VERIFIED | The focused regression run passed the auth lockout tests. Redis-backed behavior was validated by code/tests, not against a live Redis service. |
| Secure first-boot administrator credentials | VERIFIED | Bootstrap credential tests passed in the focused regression run. Generated credentials are not printed; persistence fails closed if secure persistence cannot be established. |
| Bounded router-presence polling | VERIFIED | The focused regression run passed the router-presence tests. |
| SQL-level reseller/dealer session scoping | VERIFIED | The focused regression run passed the session-scope and related tenancy tests. |
| Wallet concurrency under a real database race | BLOCKED | The provided integration harness uses Linux PostgreSQL binaries and `sudo`; it is not runnable on this Windows host. No disposable PostgreSQL instance was used. |

## Stage 2 verification

| Requirement | Status | Evidence / limitation |
|---|---|---|
| SNMP disabled by default and per-NAS configuration | VERIFIED | `SNMP_MONITOR` defaults off unless explicitly set to `on`; NAS configuration remains individually controlled. |
| SNMPv3 USM authPriv; no implicit downgrade | VERIFIED | Source and UI mapping were reviewed; focused SNMP tests cover configuration and invalid/unknown-version handling. Unknown versions are rejected and missing v2c communities do not fall back to `public`. |
| Allowed destinations, literal IP validation, and port bounds | VERIFIED | Operator allowlist is enforced before creating an SNMP session. An unset `SNMP_ALLOWED_CIDRS` denies SNMP targets. The final focused SNMP run passed 37/37 tests. |
| Encrypted credentials and API/log redaction | VERIFIED | Credential write/read paths and error sanitization were inspected. No real credentials were used. Legacy plaintext values are not automatically migrated; re-enter or rotate them through the secured UI before a pilot. |
| Per-NAS intervals, bounded concurrency, timeout, single flight, backoff | VERIFIED | Scheduler and collector paths were inspected; focused collector/monitor tests passed. A live multi-NAS failure-isolation test remains part of the device pilot. |
| Primary-instance and demo-NAS exclusions | VERIFIED | Guards and selection predicates were inspected. |
| Interface discovery, 32/64-bit counters, reset/reboot/name-change handling | VERIFIED | Collector logic and regression tests were inspected; the focused SNMP test run passed. Device-specific counter behavior remains pending a real router. |
| Unsupported metrics distinct from zero | VERIFIED | Unsupported values are not emitted as fabricated zero-valued measurements; UI rendering and collector logic were reviewed. |
| NAS state/events, transitions, recovery, deduplication, and retention | VERIFIED | Persistence, event lifecycle, cooldown/deduplication, and retention code were reviewed. Focused monitor tests passed; database-backed behavior was not tested. |
| Tenant-scoped event/status APIs, pagination, acknowledgement permissions | VERIFIED | Controller scope checks, bounded pagination, and NAS/event acknowledgement checks were inspected. Live API/database testing remains outstanding. |
| Existing live-feed integration and NAS Health UI | VERIFIED | Existing event broadcast integration and NAS page wiring were reviewed. Frontend typecheck, build, and unit tests passed; no browser/device-backed test was run. |
| Real MikroTik behavior | PENDING | No real non-production MikroTik was available. No simulation is represented as a successful pilot. |

## Backend CI

| Check | Status | Evidence |
|---|---|---|
| Lockfile dependency installation | VERIFIED | `npm ci` completed in `backend`. |
| Prisma client generation | VERIFIED | `npm run prisma:generate` completed. |
| Prisma schema validation | VERIFIED | `npx prisma validate --schema prisma/schema.prisma` completed. Prisma emitted four existing warnings about `SetNull` on required fields; no schema error was reported. This did not connect to a database. |
| TypeScript typecheck | VERIFIED | `npm run typecheck` passed. |
| Production build | VERIFIED | `npm run build` passed. |
| Focused Stage 1 regressions | VERIFIED | Thirteen relevant suites passed, 110/110 tests. |
| Focused Stage 2 SNMP regressions | VERIFIED | Config, collector, and monitor suites passed, 37/37 tests. |
| RADIUS vault regressions | VERIFIED | Isolated suite passed, 27/27 tests. |
| Full backend Jest suite | FAILED | Initial full run: 1,477 passed, 13 failed. Related stale assertions were corrected and the affected focused suites passed afterward, but the full suite was not rerun. A licence-agent test also fails on Windows because its Unix-domain socket listen returns `EACCES`. |
| Backend repository-wide lint | FAILED | `npm run lint -- --no-fix` reported 23,877 errors and 2,055 warnings. |
| Disposable-database migrations | BLOCKED | No disposable database with representative data was available. No migration command was executed. |
| Prisma engine HTTP 403 | NOT APPLICABLE | Generation and validation succeeded; no engine-download 403 occurred in this run. |

## Frontend CI

| Check | Status | Evidence |
|---|---|---|
| Lockfile dependency installation | VERIFIED | `npm ci` completed in `frontend`. |
| TypeScript typecheck | VERIFIED | `npm run typecheck` passed. |
| Production build | VERIFIED | `npm run build` passed. |
| Unit tests | VERIFIED | `npm run test:unit` passed 18/18 tests, including the spreadsheet and SNMP-version tests. |
| Focused NAS/SNMP lint | VERIFIED | Linting the modified NAS/SNMP UI files passed. |
| Frontend repository-wide lint | FAILED | `npm run lint -- --no-fix` reported 1,217 errors and 326 warnings. |
| Browser/responsive/permission-state verification | BLOCKED | No browser/e2e run was completed. Static UI, tests, typecheck, and build do not prove all runtime layouts and permission/error states. |

The full command list and observed test counts are in
`uplinko-update1c-test-results.md`.

## Migration review

The ordered migrations remain:

1. `backend/prisma/migrations/20261101120000_ledger_idempotency_key/migration.sql`
2. `backend/prisma/migrations/20261101140000_nas_snmp_monitoring/migration.sql`

Static review found additive changes: a nullable ledger idempotency column and
partial unique index, followed by new NAS state/event tables with NAS foreign
keys and indexes. Existing rows are not rewritten by these SQL statements.
Prisma schema validation passed, but does not demonstrate upgrade behavior
against populated data. Foreign-key cascade behavior and rollback data loss
must be tested and accepted on a disposable staging-like database before any
staging migration. No live or production database was accessed.

## Security review and fixes

A security review identified that a tenant-configured NAS could otherwise
direct SNMP requests toward reachable private/link-local destinations and
choose an unbounded port. The Update 1C fix requires an operator-controlled
`SNMP_ALLOWED_CIDRS` allowlist, validates literal IP targets and ports, rejects
unknown SNMP versions, and removes the implicit `public` community fallback.
The allowlist is absent by default, so SNMP targets are denied until explicitly
approved. Regression coverage passed in the 37-test SNMP run.

The incremental fixes also harden bootstrap credential persistence, avoid
printing generated credentials, correct SNMP version form mapping and
acknowledgement error handling, and update stale regression expectations to
match secure login/session scoping and the canonical migration wrapper.
No SNMP secrets, passphrases, tokens, or real credentials were placed in this
report. Existing legacy plaintext SNMP values must be re-entered or rotated
through the secured interface before enabling the pilot; no automatic legacy
credential migration is performed.

## Remaining risks and blockers

- Repository-wide backend and frontend lint are failing.
- Full backend Jest was not rerun after targeted fixes; the Windows
  Unix-domain-socket test remains incompatible with this host.
- No disposable-data migration upgrade test was run.
- No live Redis integration test or database wallet-race test was run.
- No real MikroTik pilot or browser/e2e validation was run.
- Existing Prisma `SetNull`/required-field warnings remain.

## Staging preparation checklist

Do not begin with migrations or SNMP enabled. First obtain green CI, review the
lint baseline, and complete disposable-database migration testing.

1. **Prepare an isolated staging environment.** Use a separate database,
   Redis instance, application secrets, and non-production NAS. Restrict
   staging access to authorized operators.
2. **Configure required secrets privately.** Supply the deployment's
   `DATABASE_URL`, `JWT_SECRET`, `SECRETS_KEY`, and `REDIS_URL` through the
   secret manager. Set `REDIS_REQUIRED=true` for multi-instance production-like
   testing. Set `BOOTSTRAP_CRED_FILE` or a protected `UPLINKO_STATE_DIR` and
   ensure the service identity alone can read it. Never paste secret values
   into reports or logs.
3. **Keep SNMP off initially.** Set `SNMP_MONITOR=off`; leave
   `SNMP_ALLOWED_CIDRS` unset until a specific non-production test target and
   narrow subnet have been approved. Do not globally enable SNMP for existing
   NAS devices.
4. **Back up the staging database before migration.** Use the database
   provider's verified backup process or `pg_dump --dbname="$PG_DUMP_URL"
   --format=custom --file="$BACKUP_FILE"` with protected environment variables.
   Verify the backup is restorable before proceeding; do not echo connection
   URLs.
5. **Validate and migrate staging only.** Install from lockfiles, run Prisma
   generation/validation, and run `npm run db:deploy` from `backend` only after
   explicit staging authorization and a verified backup. Confirm that the
   two migrations are applied in timestamp order. No migration was run by this
   task.
6. **Start workers/schedulers deliberately.** Start the application with its
   existing scheduler and shared Redis configuration. Ensure only the
   designated primary instance performs scheduled SNMP polling and that
   configured concurrency remains bounded.
7. **Limit network and permissions.** Permit outbound UDP only from the
   staging poller to the approved MikroTik SNMP address/port. Grant the
   application account only the database, Redis, and protected state-file
   permissions it needs. Keep existing RouterOS, RADIUS, and subscriber
   connectivity unchanged.
8. **Observe logs and health.** Use the staging service manager's application
   logs and existing health/live-feed views. Confirm redaction before enabling
   SNMP. Verify existing RouterOS/device-health polling, RADIUS, and subscriber
   flows continue independently of SNMP.
9. **Disable SNMP safely on failure.** Set `SNMP_MONITOR=off`, disable SNMP on
   the pilot NAS, remove or narrow `SNMP_ALLOWED_CIDRS`, and restart the
   application if needed. Keep additive schema/data in place unless a
   separately approved restore/rollback plan is executed.

### Real MikroTik pilot — PENDING

Use one non-production NAS and an SNMPv3 user with authPriv. Confirm the
device's supported authentication/privacy protocols, configure credentials
only through the secured Uplinko interface, and allowlist only its test IP.
Check identity and uptime, interface discovery/state, 32-bit/64-bit traffic
counters and rates, unsupported CPU/memory metrics, counter resets and router
reboots, interface changes, timeout/unreachable/recovery transitions,
incorrect credentials, event deduplication and acknowledgement, and continued
polling of a second healthy NAS when the pilot device fails. Verify no
credential appears in API output or logs, and confirm PPPoE, RADIUS, and
subscriber connectivity remain healthy. This procedure is not a test result.

## Rollback and readiness decision

The original `main` worktree is the clean rollback boundary. The integration
branch remains uncommitted. For an authorized staging trial, disable SNMP and
roll back application code first while retaining the additive schema. Do not
drop the new tables/index or idempotency column after they contain data without
a reviewed recovery plan; restoring the verified pre-migration staging backup
is safer than an ad hoc destructive rollback.

**Staging migration/pilot: BLOCKED. Production readiness: NOT READY.** The
current overall outcome is **PARTIAL** because lint and full-suite checks are
not green and disposable-database plus real-device validation are outstanding.
