# UPLINKO ISP CRM — Update 1 Test Results

**Date:** 2026-10-31  
**Repository:** `main` at `c38b417ae16442ea9a4d7de9edc6d42b483b99da`  
**Source modifications:** none.

## Repository and patch checks

| Command | Result | Output/notes |
|---|---|---|
| `git branch --show-current` | **PASS** | `main` |
| `git rev-parse HEAD` | **PASS** | `c38b417ae16442ea9a4d7de9edc6d42b483b99da` |
| `git status --porcelain=v2 --branch` and `git status` | **PASS (initial state)** | Branch matched `origin/main`; clean, no staged, modified or untracked files before this verification. |
| `git apply --check -- uplinko-stage1-fixes.patch` | **PASS (check only)** | Exit code 0; patch is applicable, not applied. |
| `git apply --check -- uplinko-stage2-snmp.patch` | **PASS (check only)** | Exit code 0; patch is applicable, not applied. |
| `git apply --reverse --check -- uplinko-stage1-fixes.patch` | **FAIL as an applied-state check** | Exit code 1; patch changes are absent, including Stage 1 test/migration files. |
| `git apply --reverse --check -- uplinko-stage2-snmp.patch` | **FAIL as an applied-state check** | Exit code 1; patch changes are absent, including `snmp-monitor.service.ts`, monitoring UI and Stage 2 migration. |

The failed reverse checks are evidence that the patches are not applied; no patch conflict was found by the forward checks. No patch was applied.

## Dependency installation

| Command | Result | Relevant output/notes |
|---|---|---|
| `npm ci` from repository root | **FAIL — wrong directory** | `npm error code EUSAGE`; `npm ci` requires a root `package-lock.json` or `npm-shrinkwrap.json`, which this repository does not have. |
| `Push-Location backend; npm ci; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | Scoped online install remained active for many minutes and did not complete. npm logs show slow registry fetches, including a successful `recharts` tarball response taking `454219ms`; no package-install success is claimed. |
| `Push-Location frontend; npm ci; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | Scoped online install remained active for many minutes and did not complete. |
| `Push-Location backend; npm ci --offline --no-audit --no-fund; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | Offline attempt did not complete. npm debug output reported no local tarball data for required packages (including `ajv` and `rxjs`). |
| `Push-Location frontend; npm ci --offline --no-audit --no-fund; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | Offline attempt did not complete with the available npm cache. |

The interrupted installs were stopped by specific process IDs after prolonged non-completion. The local `node_modules` directories may be incomplete; rerun the lockfile installs on a runner with normal registry access before relying on any local toolchain. The log excerpt above shows registry HTTP 200 responses with high latency, **not** a Prisma 403. No Prisma engine download error was observed in this run.

## Backend

| Command | Result | Relevant output |
|---|---|---|
| `Push-Location backend; npm run prisma:generate; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'prisma' is not recognized as an internal or external command, operable program or batch file.` |
| `Push-Location backend; npx --no-install prisma validate; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `npm error npx canceled due to missing packages and no YES option: ["prisma@8.0.0-rc.29"]`. Schema validation did not run. |
| `Push-Location backend; npm run typecheck; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'tsc' is not recognized as an internal or external command, operable program or batch file.` |
| `Push-Location backend; npm test -- --runInBand; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'jest' is not recognized as an internal or external command, operable program or batch file.` |
| `npm run build` | **NOT RUN** | Backend `build` first runs `npm run clean`, which removes the pre-existing ignored `backend/dist`. It was preserved rather than deleted; required Prisma/build tools were also unavailable. |
| Stage 1/Stage 2 test specs | **BLOCKED** | The patch-provided test files are absent in current source. |

No Prisma generation, schema validation, backend typecheck, backend build, migration or backend test suite passed in this environment.

## Frontend

| Command | Result | Relevant output |
|---|---|---|
| `Push-Location frontend; npm run typecheck; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'tsc' is not recognized as an internal or external command, operable program or batch file.` |
| `Push-Location frontend; npm run build; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'next' is not recognized as an internal or external command, operable program or batch file.` |
| `Push-Location frontend; npm run lint; $result=$LASTEXITCODE; Pop-Location; exit $result` | **BLOCKED** | `'eslint' is not recognized as an internal or external command, operable program or batch file.` |
| `Push-Location frontend; npm run test:unit; $result=$LASTEXITCODE; Pop-Location; exit $result` | **PASS** | 16 tests passed, 0 failed, 0 skipped; duration `29424.4618ms`. |

The 16 passing tests are existing CSV/spreadsheet unit tests. They do not exercise the NAS Health screen or SNMP configuration. Node emitted `MODULE_TYPELESS_PACKAGE_JSON` warnings for the two test files; the tests still passed.

## External validation still required

- Install dependencies from each package’s lockfile on an unrestricted/healthy runner.
- Run Prisma generation and schema validation. If Prisma engine downloads return HTTP 403, capture the exact command and full error on that runner; that result was **not observed here**.
- Run backend typecheck, production build and the complete Stage 1/Stage 2 plus relevant regression suites.
- Run frontend typecheck, production build, lint and NAS Health/SNMP UI verification.
- Apply migrations only in staging after backup and review.
- Complete the real MikroTik SNMPv3 authPriv pilot; no device test was run here.
