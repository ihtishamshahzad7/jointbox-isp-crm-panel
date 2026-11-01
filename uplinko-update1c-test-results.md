# UPLINKO ISP CRM — Update 1C Test Results

All commands ran in `F:\Jointbox panel-update1b-integration` unless a package
directory is stated. Results below report actual execution; code review,
schema validation, and unit tests are not substitutes for database or device
tests.

## Dependency and package resolution

| Suite/check | Command | Result |
|---|---|---|
| Backend install | `cd backend; npm ci` | **VERIFIED** — completed from the existing lockfile. |
| Frontend install | `cd frontend; npm ci` | **VERIFIED** — completed from the existing lockfile. |
| Spreadsheet package diagnosis | Inspect `frontend/package.json`, `frontend/package-lock.json`; run `npm run test:unit` after `npm ci` | **VERIFIED** — `read-excel-file@9.3.10` was already declared and locked; the earlier `ERR_MODULE_NOT_FOUND` was due to absent `node_modules`, not a missing package or bad import. |
| Manifest/lockfile modifications | `git diff -- backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json` | **VERIFIED** — no dependency manifest or lockfile changes. |

## Backend

| Suite/check | Command | Result |
|---|---|---|
| Prisma client generation | `cd backend; npm run prisma:generate` | **VERIFIED** — completed. |
| Prisma schema validation | `cd backend; npx prisma validate --schema prisma/schema.prisma` | **VERIFIED** — passed with four existing warnings about `SetNull` on required fields. No database connection or migration was performed. |
| TypeScript | `cd backend; npm run typecheck` | **VERIFIED** — passed. |
| Production build | `cd backend; npm run build` | **VERIFIED** — passed. |
| Focused Stage 1 regressions | `cd backend; npm test -- --runInBand src/auth/auth-lockout.spec.ts src/auth/auth-tenancy.spec.ts src/auth/staff-boundary.spec.ts src/billing-ext/billing-ext-wallet.spec.ts src/common/bootstrap-credentials.spec.ts src/common/db-push-safety.spec.ts src/common/platform-account.spec.ts src/logs/network-log-tenancy.spec.ts src/nas/radius-tenancy-boundary.spec.ts src/network/live-sessions-scope.spec.ts src/network/network.service.spec.ts src/subscribers/router-presence.spec.ts src/users/platform-companies.spec.ts` | **VERIFIED** — 13 suites passed; 110 tests passed. |
| Focused Stage 2 SNMP regressions | `cd backend; npm test -- --runInBand src/nas/nas-snmp-config.spec.ts src/telemetry/snmp-collector.spec.ts src/telemetry/snmp-monitor.spec.ts` | **VERIFIED** — 3 suites passed; 37 tests passed. Jest printed an open-handle notice after completion; the process exited successfully. |
| RADIUS vault regression | `cd backend; npm test -- --runInBand src/nas/radius-vault.spec.ts` | **VERIFIED** — 27 tests passed when run alone. |
| Full Jest suite | `cd backend; npm test -- --runInBand` | **FAILED** — initial run reported 1,477 passed and 13 failed (1,490 total). Several failures were stale assertions for the secured login/session filters and migration wrapper; related suites subsequently passed in the focused 110-test run. The complete suite was not rerun after those updates. The licence-agent Unix-domain socket test independently fails on Windows with `listen EACCES`. |
| Repository-wide lint | `cd backend; npm run lint -- --no-fix` | **FAILED** — 23,877 errors and 2,055 warnings. |
| Wallet database concurrency harness | `cd backend; node src/billing-ext/billing-ext-wallet.concurrency.int.mjs` | **BLOCKED / NOT RUN** — harness depends on Linux PostgreSQL binaries and `sudo`, unavailable on this Windows host; it also requires a disposable PostgreSQL database. |
| Disposable-database migration test | No command run | **BLOCKED** — no disposable representative database was available. |

## Frontend

| Suite/check | Command | Result |
|---|---|---|
| TypeScript | `cd frontend; npm run typecheck` | **VERIFIED** — passed. |
| Production build | `cd frontend; npm run build` | **VERIFIED** — passed. |
| Unit tests | `cd frontend; npm run test:unit` | **VERIFIED** — 18 tests passed, including the spreadsheet and SNMP-version tests. |
| Focused NAS/SNMP lint | `cd frontend; npx eslint 'app/nas/[id]/tabs-config.tsx' 'app/nas/[id]/tabs-health.tsx' 'app/nas/[id]/monitoring-status.tsx' 'app/nas/[id]/snmp-version.ts' 'tests/snmp-version.test.ts'` | **VERIFIED** — modified NAS/SNMP UI files passed focused lint. |
| Repository-wide lint | `cd frontend; npm run lint -- --no-fix` | **FAILED** — 1,217 errors and 326 warnings. |
| Browser/e2e tests | No command run | **BLOCKED** — no browser/e2e verification completed. |

## Integration/security regression evidence

| Area | Command/evidence | Result |
|---|---|---|
| SNMP allowlist, IP/port validation, unsupported versions, collector, monitor | Focused Stage 2 command above | **VERIFIED** — 37/37 tests passed, including the Update 1C guardrails. |
| Tenant/session, auth, billing wallet, bootstrap, router-presence regressions | Focused Stage 1 command above | **VERIFIED** — 110/110 tests passed. |
| RADIUS vault | Isolated suite above | **VERIFIED** — 27/27 tests passed. |
| SNMP credential protection | Code-path review and test coverage; no real credentials used | **VERIFIED** for inspected encrypted-write/redaction paths; live deployment secret/log verification remains outstanding. |
| Existing RouterOS, RADIUS, VPN, subscriber and billing end-to-end flows | No live service/e2e command run | **BLOCKED** — no staging services were used. |
| Real MikroTik pilot | No device command run | **PENDING** — no real non-production MikroTik was available. |

## Migration and environment notes

- Prisma generate and schema validation passed, but neither proves migration
  compatibility with populated data.
- Migration order was reviewed as
  `20261101120000_ledger_idempotency_key` followed by
  `20261101140000_nas_snmp_monitoring`. No migration command was run.
- No Prisma engine HTTP 403 occurred; those checks completed successfully.
- No live Redis, production router, customer database, or production
  environment was contacted.
- The full backend test run was not repeated after the related assertion fixes;
  its initial failed result remains a failed full-suite check even though the
  focused replacements passed.

## Final repository checks

| Check | Command | Result |
|---|---|---|
| Default whitespace check | `git diff --check` | **FAILED** — Git reported CR characters as trailing whitespace on added lines in the mixed-line-ending `backend/src/nas/radius-sync.service.ts`; it also warned that `install.sh` may be normalized from CRLF to LF on a future write. No whitespace conversion or source cleanup was made. |
| CRLF-aware whitespace check | `git -c core.whitespace=cr-at-eol diff --check` | **VERIFIED** — passed; the diff had no additional whitespace errors when CRLF was recognized as an end-of-line convention. |
| Incremental patch parse | `git apply --stat uplinko-update1c-fixes.patch` | **VERIFIED** — parsed as a 20-file patch (410 insertions, 112 deletions). The patch's `git apply --check` was previously verified against the reconstructed Stage 1/2 integration baseline. |
| Branch and base | `git rev-parse --abbrev-ref HEAD; git rev-parse HEAD; git worktree list` | **VERIFIED** — `uplinko/update1b-integration` remains at `3a0bc22d191ae78a6b782ab0ff6e31db1aea03a9`; original `main` remains a separate worktree at the same HEAD. |
| Original worktree status | `git -C 'F:\Jointbox panel' status --short --branch` | **VERIFIED** — `main` remains clean and unchanged. |
| Update 1C deliverables | `Test-Path` checks for the CI report, test-results report, and fixes patch | **VERIFIED** — all three files are present in the integration worktree. |
