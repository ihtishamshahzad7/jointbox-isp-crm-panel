# Uplinko Update 1E Targeted Fixes

**Branch:** `uplinko/update1b-integration`  
**Baseline:** `30ca7c8d33f1a1051f17a90d03c2b7fd83c01ba4`  
**Outcome:** **PARTIAL**

## Changes made

- `backend/src/billing-ext/billing-ext.service.ts`
  - Derives a fixed-length SHA-256 ledger idempotency key from the subscriber ID, operation type, and supplied payment key/reference.
  - Keeps the existing database unique constraint and transaction rollback behavior.
  - Checks the matched ledger row's subscriber and operation before returning it as an already-applied duplicate.
- `backend/src/billing-ext/billing-ext-wallet.spec.ts`
  - Adds regressions for a shared payment reference across subscribers and reuse of a key across subscriber/operation scopes. Retains the repeated-callback exactly-once test.
- `backend/src/telemetry/snmp-monitor.service.ts`
  - Stops swallowing poll-slot reservation errors. On reservation failure, logs a safe warning and skips SNMP collection.
  - Releases `inFlight` in a `finally` block covering reservation, polling, state writes, and event handling.
- `backend/src/telemetry/snmp-monitor.spec.ts`
  - Adds a failed-reservation regression proving the poll is skipped, the warning is safe, and the NAS can be polled on a subsequent successful reservation.
- `uplinko-update1e-fixes-report.md` — this report.
- `uplinko-update1e-test-results.md` — appended this run's results; its pre-existing contents were retained.

Pre-existing untracked Update 1E artifacts were left untouched. No production database, migration, or live MikroTik operation was performed.

## Checks and results

| Check | Result | Details |
|---|---|---|
| Wallet and SNMP regression suites | **PASS** | `npm test -- --runInBand src/billing-ext/billing-ext-wallet.spec.ts src/telemetry/snmp-monitor.spec.ts` — 2 suites, 23 tests passed. |
| Full backend Jest suite (Windows) | **PARTIAL** | 135 suites: 134 passed, 1 failed; 1,490 tests passed, 2 failed, 1 skipped. The only skipped test is the Unix-domain socket test, guarded on Windows. The failures were two 5-second timeouts in `src/nas/radius-vault.spec.ts`. |
| RADIUS test file rerun | **PASS** | `npm test -- --runInBand src/nas/radius-vault.spec.ts` — 1 suite, 27 tests passed. |
| Backend typecheck | **PASS** | `npm run typecheck`. |
| Backend production build | **NOT RUN** | The build script first removes `backend/dist`; that ignored directory already existed, so it was preserved rather than cleaned or overwritten. |
| Frontend unit tests | **PASS** | `npm run test:unit` — 18 passed. |
| Frontend typecheck | **PASS** | `npm run typecheck`. |
| Frontend production build | **PASS** | `npm run build`. |
| Frontend lint | **FAIL** | `npm run lint` reports 1,217 errors and 326 warnings across the frontend. No frontend files were changed. |
| ESLint on changed backend files | **FAIL** | 590 errors and 39 warnings across the four files, predominantly formatting/style diagnostics. |
| Whitespace check | **PASS** | `git diff --check`. |

## Remaining risks and limitations

- The full backend suite is not green because of the two RADIUS test timeouts, despite that file passing when run alone. This run does not establish a fully passing backend suite.
- Lint remains failing; the lint totals are reported rather than addressed because unrelated files and formatting are outside this targeted fix.
- The backend production build was not run to avoid deleting/overwriting the pre-existing ignored `backend/dist` artifacts.
- No Linux-only checks were run or represented as passing.
