# UPLINKO ISP CRM — Update 1B Integration Test Results

All commands below ran in `F:\Jointbox panel-update1b-integration`. No database
migration or deployment command was run. Dependencies were not reinstalled:
earlier install attempts during this task were slow/incomplete, and the
lockfile-installed local executables remain absent.

## Backend

| Check | Command | Result |
|---|---|---|
| Prisma generation | `cd backend; npm run prisma:generate` | **BLOCKED** — `'prisma' is not recognized as an internal or external command`. |
| Prisma schema validation | `cd backend; npm_config_offline=true; npx --no-install prisma validate --schema prisma/schema.prisma` | **BLOCKED** — no output after 30 seconds; command stopped. Prisma validation did not run. |
| TypeScript | `cd backend; npm run typecheck` | **BLOCKED** — `'tsc' is not recognized as an internal or external command`. |
| Lint | `cd backend; npm run lint` | **BLOCKED** — `'eslint' is not recognized as an internal or external command`. |
| Production build | `cd backend; npm run build` | **BLOCKED** — the `clean` script completed; the subsequent Prisma generation failed with `'prisma' is not recognized as an internal or external command`. `backend/dist` did not exist before the run. |
| Stage 1 + Stage 2 targeted tests | `cd backend; npm test -- --runInBand src/auth/auth-lockout.spec.ts src/billing-ext/billing-ext-wallet.spec.ts src/common/bootstrap-credentials.spec.ts src/nas/nas-snmp-config.spec.ts src/network/live-sessions-scope.spec.ts src/subscribers/router-presence.spec.ts src/telemetry/snmp-collector.spec.ts src/telemetry/snmp-monitor.spec.ts` | **BLOCKED** — `'jest' is not recognized as an internal or external command`. |
| Stage 1 wallet DB concurrency test | `node src/billing-ext/billing-ext-wallet.concurrency.int.mjs` (not run) | **BLOCKED** — this test hardcodes Linux PostgreSQL binaries and `sudo`; it is incompatible with this Windows host. It also requires a disposable local PostgreSQL instance. |

The Prisma engine HTTP 403 was not observed during this run. Generation could
not start because the local CLI is missing. Run Prisma generate and validate
on an unrestricted CI runner with the existing lockfile-installed dependencies.

## Frontend

| Check | Command | Result |
|---|---|---|
| TypeScript | `cd frontend; npm run typecheck` | **BLOCKED** — `'tsc' is not recognized as an internal or external command`. |
| Production build | `cd frontend; npm run build` | **BLOCKED** — `'next' is not recognized as an internal or external command`. |
| Lint | `cd frontend; npm run lint` | **BLOCKED** — `'eslint' is not recognized as an internal or external command`. |
| Unit tests | `cd frontend; npm run test:unit` | **BLOCKED** — 15 of 16 tests passed; the spreadsheet XLSX test could not import `read-excel-file` (`ERR_MODULE_NOT_FOUND`) because frontend dependencies are absent. |

## Migration and pilot

- Migration files were reviewed in order:
  `20261101120000_ledger_idempotency_key`, then
  `20261101140000_nas_snmp_monitoring`.
- SQL was inspected for additive schema changes and rollback comments. Prisma
  validation remains BLOCKED.
- `npm run db:deploy` was **NOT RUN**. No database was migrated.
- A real MikroTik test was **NOT RUN / PENDING**. No virtual or simulated result
  is counted as a pilot.

## Repository checks

- Original checkout: branch `main`, HEAD
  `3a0bc22d191ae78a6b782ab0ff6e31db1aea03a9`, clean.
- Integration branch: `uplinko/update1b-integration`, based on that same HEAD.
- Stage 1 patch check/application completed before Stage 2; Stage 2 patch
  applicability check passed after Stage 1. Windows line-ending differences
  required `git apply --ignore-space-change`.
- No commit, push, production operation, or destructive Git operation was
  performed.
