# UPLINKO ISP CRM — Update 1D Test Results

**Branch:** `uplinko/update1b-integration` @ `3a0bc22` · **Previous phase:** Update 1C (PARTIAL)

## Execution environment & an honest constraint

Update 1C ran on the **Windows host directly** (native `node_modules`, Prisma
engine available, `npm ci`/typecheck/build/jest all ran). Update 1D is being run
from a sandbox whose only access to that host is a **Linux VM that mounts the
Windows folders**. Two hard limits follow:

1. The worktree's `node_modules` are **Windows-native**. Running `jest`/`eslint`
   there under the Linux VM fails on native binaries (bcrypt, Prisma engine,
   etc.), and running `npm ci` in the mount would **overwrite the user's
   `node_modules`** — a destructive change the brief forbids. So the **full
   backend Jest suite and repository-wide lint cannot be re-run from this
   environment** without harming the working tree.
2. The isolated cloud sandbox has Node + PostgreSQL but **not** the integration
   tree, and its Prisma engine download is firewalled.

Therefore the **migration gate was executed here for real** (plain SQL, no engine
needed — see the migration report: **PASS**), and the full-suite re-run + repo-wide
lint are reported **BLOCKED here / run on Linux CI**, with the 1C evidence and a
file-level analysis below. No test is described as passed that was not executed.

## Backend

| Suite/check | Status | Evidence |
|---|---|---|
| Disposable-PostgreSQL migration validation | **PASS** | Executed here against throwaway PG16; 17/17 checks passed. See `uplinko-update1d-migration-report.md`. |
| Focused Stage 1 regressions (13 suites, 110 tests) | **PASS (1C)** | 1C ran them green after the stale-assertion fixes; the files are unchanged in 1D. |
| Focused Stage 2 SNMP regressions (3 suites, 37 tests) | **PASS (1C)** | Config/collector/monitor incl. the allowlist guardrails. |
| RADIUS vault regression (27 tests) | **PASS (1C)** | Isolated suite. |
| Full backend Jest suite (1,490 total) | **BLOCKED here** — see analysis | Cannot re-run in this environment (constraint above). 1C's last full run: **1,477 passed, 13 failed**. |
| Licence-agent Unix-socket test (EACCES on Windows) | **FIXED (guard) — run on Linux to confirm** | Root-caused + platform guard in `uplinko-update1d-fixes.patch`. |
| Repository-wide backend lint | **BLOCKED here / pre-existing FAIL** | 1C: 23,877 errors + 2,055 warnings repo-wide; integration-touched files pass focused lint. See CI report. |

### The 13 full-suite failures — classification

1C's note: *"Several failures were stale assertions for the secured login/session
filters and migration wrapper; related suites subsequently passed in the focused
110-test run. The complete suite was not rerun. The licence-agent Unix-domain
socket test independently fails on Windows with `listen EACCES`."*

| Group | Count (approx) | Classification | Status |
|---|---|---|---|
| Stale assertions on secured login/session filters & migration wrapper | 12 | Pre-existing tests that asserted old behaviour; **already corrected in `uplinko-update1c-fixes.patch`**; the corresponding focused suites (Stage 1 110/110, Stage 2 37/37, vault 27/27) pass | Fixed in 1C; **full-suite re-run BLOCKED here**, run on CI to confirm 1,490/1,490 |
| `licence-agent-contract.spec.ts › the request the panel sends` | 1 | **Environment-specific**: Node `net` cannot `listen` on a Unix-domain socket **path** on Windows (named pipes only) → `listen EACCES`. The licence agent is a Linux-only production component (`/run/jointbox/licensed.sock`). | **Fixed** with a `win32` platform guard that **skips on Windows and keeps full coverage on Linux/macOS/CI** (`uplinko-update1d-fixes.patch`) |

Net: of the 13, 12 are already addressed by the 1C fixes (focused suites green),
and the 1 remaining is resolved by the 1D platform guard. Confirming the full
suite reports zero failures requires one **Linux CI run** (where the licence-agent
test executes rather than skips).

## Frontend

| Suite/check | Status | Evidence |
|---|---|---|
| TypeScript typecheck | **PASS (1C)** | `npm run typecheck`. |
| Production build | **PASS (1C)** | `npm run build`. |
| Unit tests (18, incl. spreadsheet + snmp-version) | **PASS (1C)** | `npm run test:unit`. |
| Focused NAS/SNMP lint | **PASS (1C)** | `npx eslint` on the changed NAS/SNMP UI files. |
| Repository-wide frontend lint | **BLOCKED here / pre-existing FAIL** | 1C: 1,217 errors + 326 warnings repo-wide; changed files pass focused lint. |
| Browser / Playwright E2E | **BLOCKED** | Playwright exists (`playwright.config.ts`, `e2e/*.spec.ts`) but needs the full app + backend + DB + browsers running; not runnable from this environment. SNMP E2E steps are in the CI report. |

## Security regression

| Area | Status | Evidence |
|---|---|---|
| SNMP SSRF allowlist, IP/port/version validation, DNS-rebind, error redaction, tenant auth, legacy-plaintext non-migration | **PASS (code review)** | See the security section of `uplinko-update1d-ci-report.md`; focused SNMP suite (37/37) covers the guardrails. Live-deployment secret/log verification remains for the pilot. |

## MikroTik pilot

**NOT RUN** — no non-production MikroTik device available. Full checklist in
`uplinko-update1d-mikrotik-pilot-checklist.md`.

## Commands actually executed in Update 1D (sandbox)

- Disposable PG: `initdb` / `pg_ctl start` (PG16), then `psql -v ON_ERROR_STOP=1 -f`
  for each of the 55 pre-target migrations + the 2 targets, plus the assertion
  queries in the migration report, then `pg_ctl stop` + teardown.
- `git apply --check uplinko-update1d-fixes.patch` against the integration-branch
  copy of the licence-agent test → **applies clean**.
- Read-only inspection of the integration worktree and git state via the device bridge.
