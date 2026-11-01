# UPLINKO ISP CRM — Update 1B Integration Report

## Result

Stage 1 and Stage 2 have been integrated on an isolated branch for review. The
original `main` checkout remains at its original commit and clean. No commit,
push, database migration, or deployment was performed.

**Staging deployment: BLOCKED** until required backend/frontend CI can run with
the lockfile-installed dependencies. The real MikroTik pilot is **PENDING**.
Do not treat this integration as production-ready.

## Repository and isolation

- Repository: `ihtishamshahzad7/jointbox-isp-crm-panel`
- Original `main` HEAD: `3a0bc22d191ae78a6b782ab0ff6e31db1aea03a9`
- Integration branch: `uplinko/update1b-integration`
- Integration worktree: `F:\Jointbox panel-update1b-integration`
- Integration base: same original HEAD; no commits made.
- Original `F:\Jointbox panel` worktree: `main`, clean, unchanged.
- The integration worktree is the rollback boundary. Returning to the original
  checkout returns to the untouched `main` state.

Both required patches and reports were present. The patches identify
`1d76830` as their original base; the actual current `main` was newer. Stage 1
and Stage 2 applicability checks passed against the current source when
`--ignore-space-change` was used for Windows line endings. Stage 1 was applied
first; Stage 2 then passed its check and was applied. No delivered patch or
report was overwritten. `jointbox-stage2-snmp-monitoring.md` was not present.

## Files changed

The integration patch contains only the following 36 source, migration, and
test files relative to the original HEAD:

- `backend/.env.example`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261101120000_ledger_idempotency_key/migration.sql`
- `backend/prisma/migrations/20261101140000_nas_snmp_monitoring/migration.sql`
- `backend/src/auth/auth-lockout.spec.ts`
- `backend/src/auth/auth-tenancy.spec.ts`
- `backend/src/auth/auth.service.ts`
- `backend/src/auth/staff-boundary.spec.ts`
- `backend/src/billing-ext/billing-ext-wallet.concurrency.int.mjs`
- `backend/src/billing-ext/billing-ext-wallet.spec.ts`
- `backend/src/billing-ext/billing-ext.service.ts`
- `backend/src/common/bootstrap-credentials.spec.ts`
- `backend/src/common/bootstrap-credentials.ts`
- `backend/src/common/cache.service.ts`
- `backend/src/common/platform-account.ts`
- `backend/src/main.ts`
- `backend/src/nas/nas-snmp-config.spec.ts`
- `backend/src/nas/nas-snmp-config.ts`
- `backend/src/nas/nas.service.ts`
- `backend/src/nas/radius-sync.service.ts`
- `backend/src/network/live-sessions-scope.spec.ts`
- `backend/src/network/network.service.ts`
- `backend/src/subscribers/router-presence.spec.ts`
- `backend/src/subscribers/subscribers.service.ts`
- `backend/src/telemetry/device-health.service.ts`
- `backend/src/telemetry/snmp-collector.spec.ts`
- `backend/src/telemetry/snmp-monitor.service.ts`
- `backend/src/telemetry/snmp-monitor.spec.ts`
- `backend/src/telemetry/telemetry.controller.ts`
- `backend/src/telemetry/telemetry.module.ts`
- `backend/src/users/platform-companies.spec.ts`
- `frontend/app/nas/[id]/lib.ts`
- `frontend/app/nas/[id]/monitoring-status.tsx`
- `frontend/app/nas/[id]/tabs-config.tsx`
- `frontend/app/nas/[id]/tabs-health.tsx`
- `install.sh`

The report, test-results file, and combined patch are separate deliverables and
are not included in that implementation patch.

## Integration review

### Stage 1

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Atomic wallet updates and idempotency | VERIFIED | The balance mutation uses a transactional atomic increment and a unique nullable idempotency key. A concurrent unique-key collision aborts the transaction. Stage 1 unit and database concurrency tests are present but were not executable here. |
| Distributed login lockout | VERIFIED | Lockout counters use the shared cache/Redis path; when Redis is required and unavailable, login fails closed. The local fallback is suitable only for a single-instance deployment. Configure `REDIS_REQUIRED=true` for a multi-instance deployment. Runtime tests are BLOCKED. |
| Secure first-boot administrator setup | VERIFIED | Generated bootstrap credentials are persisted in a restricted-permission file and cleared after password change; known insecure defaults are rejected. Runtime tests are BLOCKED. |
| Bounded router-presence polling | VERIFIED | Router probes use bounded concurrency/timeouts. Runtime tests are BLOCKED. |
| SQL-level tenant/reseller session scoping | VERIFIED | Active-session queries carry tenant/reseller ownership predicates in SQL rather than relying only on post-query filtering. Runtime tests are BLOCKED. |
| Stage 1 migration/schema alignment | BLOCKED | The migration is additive and the column/index definition agrees structurally with the Prisma model; Prisma CLI validation and database-backed tests could not run. |

### Stage 2

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Per-NAS configuration and disabled-by-default behavior | VERIFIED | `snmpEnabled` defaults false. The example environment explicitly sets `SNMP_MONITOR=off`; monitoring must also be enabled per NAS. |
| SNMPv3 USM authPriv and no v2c fallback | VERIFIED | V3 configuration creates a V3 USM session and does not fall through to the community-string session. The UI defaults to authPriv; it requires auth and privacy protocols/passphrases when selected. Lower security levels remain explicit operator choices. Unsupported version strings now return a validation error rather than normalizing to V2c. |
| Credential encryption and API masking | BLOCKED | New community strings and V3 passphrases are encrypted on write and sanitized from NAS API objects. Legacy plaintext values remain readable for compatibility and are not automatically migrated; re-enter legacy community values through the configuration UI before the pilot. API redaction is covered by tests, but tests could not run. |
| Per-NAS intervals, bounded concurrency, timeout, single-flight and backoff | VERIFIED | A primary-instance cron dispatcher selects due, active, non-demo NAS rows; concurrency and retry/backoff are bounded. Tests exist but were not executable. |
| Primary-instance and demo-NAS exclusions | VERIFIED | Polling checks the primary-instance guard and applies the shared non-demo ownership/row predicate. |
| Interface metrics and counter handling | VERIFIED | 64-bit counters are preferred, 32-bit fallback and wrap handling are present, and reboot/reset samples are guarded. A directly related compatibility fix now resets the baseline when an ifIndex's interface name changes and avoids emitting a sample when octet counters are unavailable. Regression test added; execution BLOCKED. |
| Unsupported health metrics | VERIFIED | Unsupported health values are omitted rather than converted to fabricated metric rows. Runtime behavior remains untested here. |
| `NasSnmpState` and `NasEvent` persistence | VERIFIED | Prisma models and an additive migration add per-NAS state and lifecycle events. |
| Transition/recovery events and deduplication | VERIFIED | State changes emit lifecycle events; CPU/memory threshold events use a cooldown. Event delivery reuses `EventsService.broadcast`. Runtime behavior is BLOCKED. |
| Tenant-scoped APIs, pagination and acknowledgement | VERIFIED | Controller routes call `ScopeService.assertNas`; event pages are bounded and event acknowledgements check both event and NAS IDs. |
| Retention | VERIFIED | Existing metric retention and a separate event-retention window are implemented in the primary-instance collector. |
| NAS Health configuration/monitoring UI | VERIFIED | The NAS page includes V3 fields, validation feedback, status, metrics and event/acknowledgement flows. Build/browser verification is BLOCKED. |
| Safe SNMP test errors | VERIFIED | The test endpoint now classifies errors to fixed redacted messages, including session-construction errors; a regression test was added. |
| Live MikroTik behavior | PENDING | No real non-production MikroTik was available to this session. No simulation is represented as a successful pilot. |

### Fixes made during integration

1. Rejected unsupported SNMP version values instead of silently normalizing
   them to V2c; added normalization regression coverage.
2. Redacted SNMP session-construction errors returned by the test endpoint;
   added a regression test.
3. Reset interface counter baselines when the name at an ifIndex changes and
   skip samples without traffic counters; added a regression test.
4. Added Stage 2 runtime controls and explicit default-off guidance to
   `backend/.env.example`.
5. Updated the telemetry module description to reflect the integrated monitor.

These are narrow compatibility/safety fixes. No unrelated application
functionality was changed.

## Migrations

Order in the integration branch:

1. `20261101120000_ledger_idempotency_key`
2. `20261101140000_nas_snmp_monitoring`

The first adds a nullable ledger column and a partial unique index over
non-null idempotency keys. The second creates the state/event tables, indexes,
and NAS foreign keys. Both are additive; no existing rows are deleted or
rewritten. Schema and migration structure were inspected, but Prisma validation
was BLOCKED because the Prisma CLI was unavailable. No migration was executed
against any database.

The supplied migration comments document reverse SQL. On staging rollback,
stop the application first and take a fresh backup. Dropping the SNMP tables
destroys pilot state/events; dropping the idempotency column/index removes
deduplication history and must not be done while the updated app is running.
Prefer restoring the pre-migration staging backup if rollback is required.

## CI and regression verification

Detailed commands and observed output are in
`uplinko-update1-integration-tests.md`.

- Backend Prisma generation/validation, TypeScript check, lint, build and
  targeted Stage 1/Stage 2 tests: **BLOCKED** by missing local packages/CLI.
- Frontend TypeScript, lint and production build: **BLOCKED** by missing local
  packages/CLI.
- Frontend unit tests: 15 passed; one test could not load
  `read-excel-file` because dependencies are not installed. Overall **BLOCKED**.
- Relevant NAS, telemetry, auth and billing regression suites: **BLOCKED**.
- Prisma engine HTTP 403: **NOT OBSERVED in this run**; Prisma generation could
  not start because `prisma` was not installed. No claim of validation or
  generation success is made.
- Dependency installation: not repeated because prior installation attempts
  in this task were slow/incomplete. Both package lockfiles are present, but
  the required local `node_modules` tools are absent.
- Existing UI branding/colors: no visual redesign or branding changes were
  made; browser verification remains BLOCKED by the unavailable frontend build.

Run the listed checks on an unrestricted CI runner after installing each
package from its existing `package-lock.json`. Do not change dependency
versions to bypass missing tooling or Prisma engine downloads.

## Combined regression scope

- NAS management and RouterOS API/RADIUS synchronization code are part of the
  integrated diff; their regression suites could not run.
- Subscriber, billing/wallet, authentication, Redis lockout and tenant-scope
  changes have targeted tests in the patch; execution is BLOCKED.
- Existing device-health collection, scheduler/live feed, and SNMP collector
  orchestration were reviewed together. Runtime regression verification is
  BLOCKED.
- WireGuard, SSTP and L2TP/IPsec application modules were not changed by the
  integration patch. Their regression tests were not run, so behavior is
  BLOCKED pending CI rather than assumed preserved.
- No migration or database-backed test was run.

## Staging preparation

Do not deploy this branch to staging until CI above passes. Once it does:

1. Use a disposable staging environment and database. Set unique
   `ADMIN_PASSWORD`, `PLATFORM_ADMIN_PASSWORD`, `JWT_SECRET`, stable
   `SECRETS_KEY`, and `DATABASE_URL`; set `UPLINKO_STATE_DIR` to a persistent,
   access-restricted path if generated bootstrap credentials are used. Set
   `REDIS_URL` and `REDIS_REQUIRED=true` for multi-instance operation. Supply
   required RADIUS settings through the deployment's secret manager. Never
   paste credentials into this report or logs.
2. Leave `SNMP_MONITOR=off` and all NAS `snmpEnabled=false` by default. For the
   approved pilot only, set `SNMP_MONITOR=on` and enable one non-production NAS.
   Tune `SNMP_MONITOR_CONCURRENCY`, `SNMP_MONITOR_MAX_BACKOFF_SEC`,
   `SNMP_ALERT_COOLDOWN_SEC`, and retention values only as needed.
3. Back up the staging DB before migration, for example:
   `pg_dump --format=custom --file=<protected-staging-backup.dump> "$DATABASE_URL"`
   Store the backup outside the web root with restricted access; verify it is
   readable before proceeding.
4. Set `DATABASE_URL` to staging only and use a deployment database principal
   with the required schema migration privileges. Then use the repository
   deployment script from `backend`: `npm run db:deploy`. This runs forward-only
   `prisma migrate deploy` and generation. Do not run it against production.
5. Start the existing backend service/worker using its normal deployment
   entrypoint. The monitor is a Nest scheduler in that service and is primary
   instance gated; do not start a second scheduler. In multi-instance
   deployments, configure Redis as required and ensure only the designated
   primary performs polling.
6. Permit backend-to-device UDP access on the configured SNMP port (default
   161) and return traffic. Configure SNMPv3 authPriv on the test router and
   allow only the backend source address. Re-enter any legacy plaintext
   community string through the UI so the saved value is encrypted.
7. Review the existing backend service logs and monitoring feed. Confirm
   RouterOS API monitoring and RADIUS/accounting continue independently of
   SNMP. Confirm NAS Health status and events through the authenticated UI/API;
   never log SNMP credentials or passphrases.
8. For the real-device pilot, verify identity/uptime, interface discovery and
   state, rates/counters, unsupported metric handling, bad credentials,
   unreachable timeout, alert/recovery deduplication, and continued polling of
   a second NAS when the pilot router fails.
9. To disable the pilot, set `SNMP_MONITOR=off` and restart the backend, then
   set the pilot NAS `snmpEnabled=false`. This stops new SNMP polls without
   affecting RouterOS API polling or existing metrics; retention continues.

Use the application deployment's normal log destinations; this integration
does not add a separate log path. Monitoring operations remain unauthenticated
only where the existing application already provides public health checks;
SNMP status/events/test routes use the existing JWT/permissions guards and
tenant scope.

## Final readiness

- Integration on the isolated branch: **VERIFIED**.
- Stage 1 and Stage 2 code presence: **VERIFIED by source review**.
- Required behavioral/build CI: **BLOCKED**.
- Real MikroTik pilot: **PENDING**.
- Staging deployment: **BLOCKED pending CI**. Pilot preparation may proceed
  only after CI passes, with SNMP disabled until the single-device pilot is
  explicitly approved.
- Production readiness: **NOT READY**.
