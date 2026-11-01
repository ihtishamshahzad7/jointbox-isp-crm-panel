# UPLINKO ISP CRM — Update 1E Test Results

> Historical entries below are preserved from earlier work. Their branch and check
> statuses are superseded where they conflict with the verified “Update 1E targeted
> fixes — current run” section at the end of this file.

**Branch:** `uplinko/update1b-integration` @ `3a0bc22`

Legend: PASS / FAIL / BLOCKED / NOT RUN / RUN-BY-USER (command provided; must run in the
Windows VS Code terminal because the agent's Linux bridge cannot run the Windows toolchain
and `npm ci` exceeds the bridge's 180s cap — see the CI report §B).

## Backend
| Check | Status | Evidence |
|---|---|---|
| Disposable-PostgreSQL migration validation | **PASS** | Update 1D, 17/17 — not repeated. See `uplinko-update1d-migration-report.md`. |
| Stage 1 focused regressions (110) | **PASS (1C)** | Files unchanged since; `npm test -- <stage1 specs>` to reconfirm. |
| Stage 2 SNMP focused regressions (37) | **PASS (1C)** | `npm test -- src/nas/nas-snmp-config.spec.ts src/telemetry/snmp-collector.spec.ts src/telemetry/snmp-monitor.spec.ts` |
| RADIUS vault (27) | **PASS (1C)** | `npm test -- src/nas/radius-vault.spec.ts` |
| Licence-agent Unix-socket test (`the request the panel sends`) | **FIXED** | Windows `describe.skip` guard now in local source; on Windows it SKIPS cleanly, on Linux/CI it RUNS. Confirm with `npm test -- src/licence/licence-agent-contract.spec.ts`. |
| Full backend Jest (~1,490) | **RUN-BY-USER** | `npm test`. Expectation: green — 12/13 prior failures fixed in 1C (focused suites pass), the 13th (licence socket) now guarded. |
| TypeScript typecheck | **RUN-BY-USER / PASS (1C)** | `npm run typecheck` |
| Production build | **RUN-BY-USER / PASS (1C)** | `npm run build` |

## Frontend
| Check | Status | Evidence |
|---|---|---|
| Unit tests (18) | **PASS (1C) / RUN-BY-USER** | `npm run test:unit` |
| TypeScript | **PASS (1C) / RUN-BY-USER** | `npm run typecheck` |
| Production build | **PASS (1C) / RUN-BY-USER** | `npm run build` |
| Browser / Playwright E2E | **NOT RUN** | needs the running app + browsers; SNMP E2E steps are in `uplinko-update1d-ci-report.md`. |

## Security review
| Area | Status |
|---|---|
| Stage 1 (wallet atomic+idempotency, lockout fail-closed, bootstrap creds, router-presence, session scope) | **PASS (code present in current source)** |
| Stage 2 (SNMPv3 authPriv, allowlist, masking, tenant auth, dedup/backoff) | **PASS (code review)** |
See `uplinko-update1e-integration-security-review.md`.

## Agent-executed this phase
- Applied the licence-agent Windows guard to the local source (clean +7/−1 diff).
- Verified Stage 1/2 security markers in the current local source (greps/code read).
- Normalized the one edited file to LF so `git diff` is clean.
No test is reported as passed that was not actually executed; items needing the Windows
toolchain are marked RUN-BY-USER with the exact command.

## Update 1E targeted fixes — current run

**Workspace:** `uplinko/update1b-integration` at baseline `30ca7c8d33f1a1051f17a90d03c2b7fd83c01ba4`  
**Overall:** **PARTIAL**

| Check | Result | Evidence |
|---|---|---|
| Wallet + SNMP targeted regressions | **PASS** | `npm test -- --runInBand src/billing-ext/billing-ext-wallet.spec.ts src/telemetry/snmp-monitor.spec.ts` — 2 suites, 23 tests passed. |
| Full Windows backend Jest suite | **PARTIAL** | 134/135 suites passed; 1,490 passed, 2 failed, 1 skipped. The only skipped test is the Unix-domain socket test. Two 5-second timeout failures were in `src/nas/radius-vault.spec.ts`. |
| RADIUS test file rerun | **PASS** | `npm test -- --runInBand src/nas/radius-vault.spec.ts` — 27 tests passed. |
| Backend typecheck | **PASS** | `npm run typecheck`. |
| Backend build | **NOT RUN** | `npm run build` cleans existing ignored `backend/dist`; preserved that pre-existing directory. |
| Frontend unit tests | **PASS** | `npm run test:unit` — 18 passed. |
| Frontend typecheck | **PASS** | `npm run typecheck`. |
| Frontend production build | **PASS** | `npm run build`. |
| Frontend lint | **FAIL** | 1,217 errors and 326 warnings across the frontend; no frontend files changed. |
| Changed-backend-files ESLint | **FAIL** | 590 errors and 39 warnings across the four checked files. |
| `git diff --check` | **PASS** | No whitespace errors. |

The full backend suite and lint checks remain incomplete/failing; see
`uplinko-update1e-fixes-report.md` for exact changed files and remaining risks.
No production database, migration, or live MikroTik operation was performed.
