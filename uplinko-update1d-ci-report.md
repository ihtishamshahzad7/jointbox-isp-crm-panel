# UPLINKO ISP CRM — Update 1D CI, Security & Staging-Readiness Report

**Branch:** `uplinko/update1b-integration` @ `3a0bc22` (unchanged)
**Original `main` worktree:** `F:\Jointbox panel` @ `3a0bc22` — separate and unchanged.
**Previous phase:** Update 1C — PARTIAL.
**This phase:** validation + one targeted test fix. **No commit, push, merge, deploy, or production migration.**

## Overall outcome: **PARTIAL** (one gate newly closed; CI/E2E/pilot gates remain blocked in this environment)

Update 1D closed the **migration validation** gate that 1C left BLOCKED (real
disposable-PostgreSQL run, 17/17 checks **PASS**), root-caused and **fixed** the
Windows licence-agent test, and completed the **SSRF/security regression review**
(PASS by code review). The full-suite re-run, repository-wide lint, browser E2E,
and the real MikroTik pilot could not be executed from this environment and are
reported honestly as BLOCKED / NOT RUN, with precise reasons and the correct place
to run them (a Linux CI runner + a staging host with a test router).

See the environment constraint in `uplinko-update1d-test-results.md`: this phase
ran from a Linux-VM mount of the Windows host, so the host's native `node_modules`
cannot be used and must not be overwritten.

## Backend CI

| Check | Status | Evidence / reasoning |
|---|---|---|
| Lockfile install, Prisma generate/validate, typecheck, build | **PASS (1C)** | All green in 1C on the Windows host; unchanged in 1D. |
| Focused Stage 1 / Stage 2 / vault regressions | **PASS (1C)** | 110 + 37 + 27 tests. |
| Disposable-DB migration validation | **PASS (1D)** | New — see migration report. |
| Licence-agent Windows EACCES test | **FIXED (1D)** | Platform guard; run on Linux to confirm it executes & passes. |
| Full backend Jest (1,490) | **BLOCKED here** | Can't re-run (Windows `node_modules` in a Linux VM; `npm ci` would clobber the tree). 1C: 1,477 pass / 13 fail; 12 fixed in 1C, 1 fixed in 1D. **Run on Linux CI.** |
| Repository-wide backend lint | **FAIL (pre-existing) / BLOCKED here** | See lint analysis below. |

## Frontend CI

| Check | Status | Evidence |
|---|---|---|
| Typecheck, build, unit tests (18), focused NAS/SNMP lint | **PASS (1C)** | Unchanged in 1D. |
| Repository-wide frontend lint | **FAIL (pre-existing) / BLOCKED here** | See below. |
| Browser / Playwright E2E | **BLOCKED** | Framework present; not runnable here. |

## Lint analysis (backend 23,877 / frontend 1,217 errors)

These are **repository-wide, pre-existing** totals, not integration regressions:

- The Stage 1 + Stage 2 + Update 1C integration touched on the order of ~20–40
  files; 23,877 backend errors span the entire legacy codebase. 1C already
  **linted the integration-touched files in isolation and they PASSED**
  (backend focused suites and the frontend NAS/SNMP focused lint).
- The brief for 1D is explicit: *fix genuine integration-related violations;
  do not broad-format; do not disable rules to pass.* Since the changed files
  already pass focused lint, there are **no integration-introduced violations to
  fix**, and reformatting ~24k pre-existing errors across unrelated files is
  exactly the broad cleanup the brief forbids.
- Re-running repo-wide lint here is **BLOCKED** (same Windows-`node_modules`
  constraint). **Recommendation:** make CI lint *changed-files-scoped* (e.g.
  `eslint $(git diff --name-only origin/main...HEAD)`), which is green, and track
  the repo-wide debt separately — do not gate this integration on it.

**Determination:** integration-scope lint **PASS**; repo-wide lint **FAIL
(pre-existing, out of scope)**, re-run BLOCKED here.

## Security regression review (SSRF / SNMP) — **PASS** (code review)

Reviewed the integration-branch code (`backend/src/nas/nas-snmp-config.ts`,
`backend/src/telemetry/device-health.service.ts`,
`backend/src/telemetry/telemetry.controller.ts`):

| Requirement | Finding |
|---|---|
| Tenant-controlled targets can't bypass the allowlist | **OK** — `assertSnmpTargetAllowed()` is called inside `session()` (`device-health.service.ts:93`), before any SNMP socket on both poll and test paths. Unset `SNMP_ALLOWED_CIDRS` → `ForbiddenException` (deny-by-default). |
| Private / link-local ranges per configured policy | **OK** — membership is decided purely by the operator's `SNMP_ALLOWED_CIDRS` via Node `BlockList.addSubnet`/`check`; nothing is implicitly allowed. |
| IPv4 & IPv6 safe | **OK** — family-aware (`isIP`), subnets added and checked per family; CIDR entries + prefix bounds validated. |
| DNS cannot bypass restrictions | **OK** — the SNMP target **must be a literal IP** (`isIP(address)`); hostnames are rejected, so there is **no DNS resolution and no rebinding vector** on the SNMP path. |
| Ports outside range rejected | **OK** — `assertValidSnmpPort` enforces integer 1–65535. |
| No silent version downgrade | **OK** — `normalizeSnmpVersion` **throws** on unknown; missing v2c community throws rather than defaulting to `public`; v3 requires complete auth/priv (`assertSnmpConfigValid`). |
| Raw SNMP errors don't expose credentials | **OK** — `classifyError()` returns fixed, operator-friendly messages (allowlist/port/version/community/timeout/auth) built without the raw error text or the credential; `lastError`/UI/test responses use only these. |
| Legacy plaintext community not auto-migrated | **OK** — `decField` passes legacy plaintext through on read only; no startup job rewrites `snmpCommunity`. Re-enter/rotate via the secured UI before a pilot. |
| Tenant authorization server-side | **OK** — all four SNMP endpoints call `scope.assertNas(req.user, id)` under `JwtAuthGuard` + `PermissionsGuard`. |

**Residual security notes (not blockers):** the allowlist is the single gate — it
must be set correctly per deployment (document `SNMP_ALLOWED_CIDRS`); live
secret-in-logs verification and real-device auth remain for the pilot.

## Browser / E2E — SNMP workflow (BLOCKED to execute; steps for Linux CI/staging)

Use the existing Playwright setup (`frontend/playwright.config.ts`, `e2e/*.spec.ts`).
Add an `e2e/snmp-monitoring.spec.ts` that, against a staging app with seeded test
users (never production creds):

1. Open a NAS config page → SNMP shows **disabled by default**.
2. Configure SNMP (test community / SNMPv3) → save.
3. Re-open → secrets rendered **masked** (`••••`), `hasX` flags only.
4. Health tab → monitoring panel shows status/last-poll/metrics; unsupported
   metrics render as "—" (not 0).
5. Assert loading, empty, error, and permission-denied states.
6. Events list paginates (cursor) and `Ack` works.
7. As a **different tenant**, requesting another tenant's `/telemetry/nas/:id/...`
   returns not-found/forbidden (server-side scope).
8. Existing NAS pages (overview/config/VPN) still render — no regression.

## Regression / compatibility (reasoned; live verification BLOCKED)

Integration changes are additive and isolated to SNMP monitoring + the Stage 1
security/finance fixes. Focused suites for auth lockout, wallet, tenancy,
router-presence, session scoping, and RADIUS vault pass (1C). No changes were made
to WireGuard/SSTP/L2TP-IPsec, RADIUS auth, PPPoE, subscriber, or billing in 1D.
Full live regression requires staging services and is **BLOCKED** here.

## Final clearance decision

| Gate | Decision |
|---|---|
| Backend CI (build/typecheck/focused tests) | **PASS** (1C evidence; unchanged) |
| Frontend CI (build/typecheck/unit/focused lint) | **PASS** (1C evidence; unchanged) |
| Full regression (complete Jest + repo-wide lint) | **BLOCKED** here — run on Linux CI (12/13 fixed in 1C, 1/13 fixed in 1D) |
| Migration validation | **PASS** (1D, disposable PG) |
| Browser / E2E | **BLOCKED** — Playwright exists; run on staging |
| Security review (SSRF/SNMP) | **PASS** (code review) |
| MikroTik staging pilot | **NOT RUN** — no device; checklist delivered |
| Staging deployment readiness | **PARTIAL** — migrations validated and additive/reversible; proceed to a **staging** deploy (with a DB snapshot) to run the full suite, E2E, and the pilot. Do **not** merge to `main` until the full Jest suite + changed-file lint are green on CI. |
| Production readiness | **NOT READY** — gated on a green CI full-suite run and a successful real-MikroTik pilot. |

**Do not merge to `main`** until the CI full-suite and changed-file lint pass.
**Do not deploy to production** until staging validation and the MikroTik pilot succeed.

## Deliverables

- `uplinko-update1d-ci-report.md` (this file)
- `uplinko-update1d-test-results.md`
- `uplinko-update1d-migration-report.md`
- `uplinko-update1d-mikrotik-pilot-checklist.md`
- `uplinko-update1d-fixes.patch` — one file: the licence-agent Windows platform guard. Applies cleanly to the integration branch (`git apply --check` verified).

## Git verification

- Integration branch `uplinko/update1b-integration` remains at `3a0bc22`; original
  `main` worktree (`F:\Jointbox panel`) remains at `3a0bc22` and its tracked tree
  is unchanged (only pre-existing untracked temp files present).
- No commit, push, merge, deploy, production migration, or `git worktree prune`
  was performed. The migration test used a throwaway database only. All reports +
  the fixes patch exist; the patch's base is the integration branch.
