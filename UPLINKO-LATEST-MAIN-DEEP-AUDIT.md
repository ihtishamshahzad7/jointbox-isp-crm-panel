# Uplinko ISP CRM — Latest `main` Deep Audit

Audit date: 2026-11-20 · Audited commit: `af61caa` (`origin/main`) · Audit only. No application source, schema, migration, configuration, commit, push or deploy changes were made.

How this audit was run:
- Git commands were run read-only on `F:\Jointbox panel`. `git fetch origin` was the only network operation.
- Source was inspected directly. Report documents in the repo were treated as claims, not as evidence.
- Builds and tests ran on an exact copy of the committed tree (`git archive HEAD`, `af61caa`) in an isolated workspace. Dependencies were linked from an identical `package.json` (checked for both `frontend` and `backend`).
- **Disclosure:** several of the commits reviewed here (`42adc25`, `a077ebd`, `e226246`, `3ff21de`, `b986c19`, `1634484`, `e616cce`, `ec4fc2a`, `af61caa`) were written by me (Claude) earlier in this session. Their findings are reported with the same standard as everything else.

---

## 1. Exact repository state

| Item | Value |
|---|---|
| Branch | `main` |
| Local HEAD | `af61caa5c2bb7a94e40d1a9b7db90e4f968cf618` |
| `origin/main` after fetch | `af61caa5c2bb7a94e40d1a9b7db90e4f968cf618` |
| Ahead / behind | 0 / 0 |
| Local commits not pushed | None |
| Uncommitted (tracked) | `backend/prisma/seed.ts`, `backend/src/prisma/prisma.service.ts`. These are line-ending differences only (CRLF vs LF). With `core.autocrlf=true` they are still listed, but they contain no content change. |
| Untracked | Four 0-byte files named `backend/C:UsersadminAppDataLocalTempjbx-rad-*restarts`. A Windows temp path was used as a relative filename by a test or script. |

Committed on `origin/main` since `6ad5f02` (newest first):

| Commit | Subject |
|---|---|
| `af61caa` | Sidebar flyout: size to its text |
| `ec4fc2a` | Build frontend non-interactively |
| `e616cce` | Sidebar: WinBox-style parent groups |
| `1634484` | Platform product switches on by default |
| `b986c19` | Fix AiModule missing PrismaModule; pre-reload wiring check |
| `3ff21de` | Fix field-jobs/tasks build |
| `fe707b3` | Merge install hardening (`42adc25`) |
| `e226246` | Fix leave migration |
| `a077ebd` | Disconnects: show all 18 causes first, collapse secondary breakdown |

---

## 2. Recent commit review

| Commit | Files | Intended | Actual / risk |
|---|---|---|---|
| `42adc25` install hardening | `backend/src/main.ts`, `common/platform-account.ts`, `prisma/connection-policy.ts`, `prisma/prisma.service.ts`, `licence/licence.service.ts`, `ecosystem.config.js`, `install.sh`, `update-jointbox.sh`, `scripts/uplinko-doctor.sh` | Uplinko logins; the backend should not crash on a DB-pool mismatch; keep the PM2 scale; login self-test | Works as intended. The backend still has a hard-coded `admin123` fallback (`main.ts:51,69`; `platform-account.ts:31`). This is mitigated because `mustChangePassword` is enforced (`auth/jwt.strategy.ts:92`). See S-3. |
| `a077ebd` disconnects | `frontend/app/logs/disconnects-panel.tsx` | All 18 causes first | Removed the "Breakdown for this window" heading. Moved Who/what, Over time, By NAS and Customers into a `<details>` toggle (lines 447–548). This **conflicts with the current requirements** and **breaks 10 Playwright tests**. See L-1. |
| `e226246` leave migration | `migrations/20261102135900_*`, `20261102140000_crm_advanced_leave`, `scripts/db-deploy.sh` | Fix PostgreSQL 55P04 | Correct. Also edits an existing migration file. That is safe only because the migration could never apply anywhere. The auto-resolve in `db-deploy.sh` is scoped to that one migration name. |
| `3ff21de` field-jobs/tasks | `field-jobs/page.tsx`, `field-jobs/reports/page.tsx`, `tasks/page.tsx` | Build fix | A misplaced `useEffect` was moved back into place, and type narrowing was added. Low risk. The type errors were hidden by casts (`options as Record<string, unknown>`) rather than typed responses. |
| `b986c19` DI fix | `ai/ai.module.ts`, `scripts/check-di.js`, `update-jointbox.sh` | Fix crash loop; catch DI errors before reload | Correct, and confirmed on the server ("✓ backend wiring check passed"). |
| `1634484` product defaults | `migrations/20261120120000_product_feature_defaults`, `companies/page.tsx` | Platform switches ON by default | **Product decision taken in code**: the global kill-switch is now ON on every server. Companies still need their own plan feature, so nothing is granted to any company. `ON CONFLICT DO NOTHING` preserves an explicit OFF. See S-5. |
| `e616cce` / `af61caa` sidebar | `app/components/app-shell.tsx` | WinBox-style groups; flyout sized to text | Works in a browser (see §6). The "size to text" change does **not** take effect (measured 260px = `maxWidth`). Keyboard and rail-mode access gaps. See N-1 to N-5. Also breaks one Playwright test. |
| `ec4fc2a` non-interactive build | `update-jointbox.sh:143`, `install.sh` | Stop Next's upgrade prompt failing updates | Correct for the TTY prompt path. It does not address the underlying advisory: Next **16.4.2 is flagged vulnerable**. See S-2. |

---

## 3. Critical bugs (summary)

| ID | Severity | Finding |
|---|---|---|
| V-1 | **CRITICAL** | No host-side L2TP/IPsec client dialer exists on `main`. The panel never dials a NAS. |
| V-2 | **CRITICAL** | The L2TP architecture in code is **inverted**: the panel is set up as the L2TP *server* (LNS) and the NAS as the *client*. |
| V-3 | HIGH | The dialer exists only as an **unapplied patch file** committed at the repo root. Committed reports describe it as implemented. |
| D-1 | HIGH | Deploy order: code is reset and migrations applied before builds succeed. `dist/` is deleted before the backend build. There is no automatic code rollback. |
| S-2 | HIGH | Next.js 16.4.2 is flagged by the npm advisory database as having a known vulnerability (16.4.6 is available). |
| L-1 | HIGH | The Disconnect Analysis breakdown is hidden behind a toggle and its heading removed, against the stated requirements. 10 of 12 Playwright failures come from this. |

---

## 4. VPN architecture findings (highest priority)

**Required:** the Uplinko Linux server is the L2TP/IPsec **client** (strongSwan + xl2tpd + pppd) and dials the MikroTik NAS public IP. The NAS is the L2TP/IPsec **server**, with a dedicated `/ppp secret service=l2tp` and a matching IPsec PSK.

### V-1 CRITICAL — No host-side dialer on `main`
- **Evidence:**
  - `backend/src/nas/l2tp-client-dialer.service.ts` **does not exist** on `main`, and no branch's history has ever touched it (`git log --all -- <path>` returned nothing).
  - `NasL2tpConfigService.applyApproved()` (`nas-l2tp-config.service.ts:423–467`) returns `{ applied:false, simulated:true, deviceVerified:false, applyStatus:'not_configured' }` with the message "Preview-only simulation — no live RouterOS command was executed".
  - `capabilityCheck()` (`:522–537`) returns hard-coded `supported:{l2tp:false, ipsec:false, radius:false}`.
  - `rollback()` (`:469–489`) is also a no-op ("No live RouterOS rollback was executed").
- **Expected:** a per-NAS client that loads the IPsec config, starts the L2TP session, brings PPP up and verifies the interface.
- **Actual:** configuration is saved, validated and previewed only. Nothing is executed on the host or on the NAS.
- **Impact:** L2TP management connectivity does not exist. It is honestly labelled as simulated, so there is no fake Connected state for L2TP.
- **Fix:** implement or apply the dialer (see V-3), then verify it against a real MikroTik before turning on any "Connected" state.

### V-2 CRITICAL — Architecture inverted in the VPN installer
- **Evidence:** `backend/src/vpn/vpn.service.ts:424–451` (`l2tpInstall`) generates an **LNS** config (`[lns default]`, `ip range`, `local ip`) for the panel. `:453–462` (`l2tpMikrotik`) gives the NAS `/interface/l2tp-client … connect-to=<panel-host>`. The same pattern is at `:731–740`.
- **Expected:** the panel is the LAC/client and the NAS is the server.
- **Actual:** the panel is the server and the NAS dials in.
- **Impact:** the opposite of the required design. Following the generated scripts produces a NAS-initiated tunnel, which cannot work for NAS devices behind NAT that the panel must reach, and contradicts the agreed design.
- **Fix:** remove or replace the LNS installer text, or explicitly mark it as legacy; generate the client-side swanctl/xl2tpd LAC config and the NAS-side `/interface l2tp-server server` + `/ppp secret service=l2tp` + `/ip ipsec` settings.

### V-3 HIGH — The dialer exists only as an unapplied patch; the reports claim otherwise
- **Evidence:**
  - `uplinko-vpn-phase1-2.patch` (1,928 lines) and `uplinko-vpn-phase1.patch` are committed at the repo root.
  - `git apply --check uplinko-vpn-phase1-2.patch` against `af61caa` exits **0**, meaning it applies cleanly and has therefore **not** been applied.
  - It adds `l2tp-client-dialer.service.ts`, migration `20261101090000_nas_l2tp_client`, PPP-secret creation (`/ppp/secret … service=l2tp`, patch lines 8, 39, 793, 823) and `nas-vpn-panel.tsx`.
  - `UPLINKO-VPN-PHASE1-2-REPORT.md:6` says these "were all in place". On `main` they are not.
  - The report's own line 48 says it is "Not production-ready" until tested against a real MikroTik.
- **Impact:** a reader of the repository would believe the VPN is implemented.
- **Fix:** decide whether to apply the patch on a branch and review it (it was **not** reviewed line by line in this audit). Correct or remove the misleading report.

### Answers to the 15 VPN questions (for `main` as committed)

| # | Question | Result |
|---|---|---|
| 1 | Real host-side dialer? | **No** (V-1) |
| 2 | Backend manages strongSwan/xl2tpd? | **No.** They appear only inside generated shell-script text (`vpn.service.ts:431–448`). `execFile` is used for WireGuard (`tunnel.service.ts:224`) and probes only. |
| 3 | Packages, privileges, systemd, paths handled? | **No.** Neither `install.sh` nor `update-jointbox.sh` installs strongswan or xl2tpd, or sets up privileges. |
| 4 | Panel dials the NAS public IP? | **No.** Inverted (V-2) |
| 5 | Dedicated NAS PPP secret, `service=l2tp`? | **No** on `main` (only in the patch). `NasL2tpConfig` (`schema.prisma:652–691`) has **no PPP username or password columns**. |
| 6 | NAS IPsec secret matches the client? | Not implemented. The PSK is stored, but no NAS write and no client config exist. |
| 7 | Credentials encrypted at rest? | PSK: **yes** (`ipsecPskEnc`, `nas-l2tp-config.service.ts:246–247`). RADIUS secret: **yes**. PPP credentials: **not stored at all**. |
| 8 | Secrets excluded from API responses? | PSK masked as `********` (`:150`). Logs and diagnostics were not exhaustively checked. |
| 9–12 | Per-NAS isolation, simultaneous tunnels, no default-route change | **Not applicable on `main`**: no tunnels exist. |
| 13 | "Connected" means a verified tunnel? | L2TP: never claimed. WireGuard: shows "Connected" when `status.online` (`frontend/app/nas/tunnel-panel.tsx:197`), which comes from handshake recency (`tunnel.service.ts:485–505`), not an end-to-end check. |
| 14 | Error handling for disconnect, auth or IPsec failures? | Not implemented for L2TP. |
| 15 | Neighbour discovery uses the tunnel? | It uses the RouterOS API client against the NAS address (`mikrotik-sync.service.ts:392–453`), not an L2TP tunnel. |

---

## 5. Logs and Disconnect Analysis findings

What is correct:
- Exactly four main tabs (`frontend/app/logs/page.tsx:35–38`): Connections, Sessions, Authentication & AAA, Audit Trail.
- Disconnect Analysis is under Sessions (`:48`).
- The legacy URL `/logs/session/disconnect-analysis` redirects to `/logs?logTab=sessions&logFeature=disconnects`.
- All 18 causes, the Expected/Info/Check/Fault legend (`disconnects-panel.tsx:427–445`), and the disconnect log with pagination (`:554+`) are present.

### L-1 HIGH — The required breakdown is hidden behind a toggle and its heading is removed (regression from `a077ebd`)
- **Evidence:**
  - `disconnects-panel.tsx:447–548` wraps "Who or what ended them" (`:452`), "Over time" (`:467`), "By NAS / router" (`:473`) and "Customers who disconnected most" in `<details>` with the summary "More breakdown…" (`:448`).
  - The visible heading "Breakdown for this window" was deleted. Only `aria-label` remains (`:369`).
- **Expected:** the breakdown, "Who or what ended them", Over time and By NAS are visible by default, and nothing required sits behind a toggle.
- **Actual:** collapsed by default.
- **Impact:** violates the stated requirements. `e2e/logs-tabs.spec.ts:48,177,347,738` still expects the heading, so **10 Playwright tests fail** (§8).
- **Context:** this was done at the user's request earlier today ("hide this and show in first view the second image"). The new requirements reverse that request, so the owner must choose one.
- **Fix:** restore the visible heading and remove the `<details>`. If 18-causes-first is still wanted, put the causes grid at the top **while keeping** the breakdown visible beneath it.

### L-2 MEDIUM — Sessions time-range test fails (cause not established)
- **Evidence:** `logs-tabs.spec.ts:659–664` expects a `/logs/radius-sessions?sinceHours=6` request after selecting the Sessions tab and "6h". No such request was observed.
- **Note:** the Sessions default sub-feature is Disconnect Analysis, which calls `/logs/disconnects`. This could be an outdated test or a real filter bug. It was **not** run against the pre-`a077ebd` tree, so attribution is not established.

---

## 6. Sidebar and navigation findings

**Method:** a Playwright run against the production build, with mocked APIs and a forged client-side JWT (role ADMIN, SUPER_ADMIN or DEALER) at 375/430/768/1024/1280/1440px. This is **mock-only**: it shows client menu logic, not backend authorisation. For every run the requested URL equalled the final URL (no redirects), for example `/logs?logTab=sessions&logFeature=disconnects` → the same URL, and `/companies` → `/companies`.

**Observed menus:**
- ADMIN and DEALER: Dashboard · My Work · Subscribers · CRM› · Support› · Network› · Plans & Stock · Billing & Accounting · Reports› · HR› · AI Assistant · System›.
- SUPER_ADMIN: Companies · Plans & Pricing · Licence · Message Templates · Server›.
- All item IDs from `menuGroups` and `platformMenuGroups` appear in `NAV_TREE` and `PLATFORM_NAV_TREE` (`app-shell.tsx:150+`), so no route is dropped.
- The active group (Network, on /logs) auto-expands. The hover flyout appears at ≥1024px.

| ID | Severity | Finding |
|---|---|---|
| N-1 | MEDIUM | **Rail mode is not keyboard- or click-operable.** `onClick` only expands when `!rail` (`app-shell.tsx:1006`). In the collapsed rail, children are reachable only by mouse hover (`:992`). Keyboard and touch users of a collapsed sidebar cannot reach grouped pages. |
| N-2 | MEDIUM | **Breaks `e2e/insights-navigation.spec.ts:53`**, which expects a top-level "Logs" nav button. Logs is now a child of Network and is only rendered when that group is open. Either the test or the design needs updating. |
| N-3 | LOW | **The flyout "size to text" change has no effect.** The measured width is 260px (the `maxWidth`) at every viewport, because `.nav-item { width:100% }` (`globals.css:557`) makes `max-content` resolve to the cap (`app-shell.tsx:1016`). |
| N-4 | LOW | Accessibility: the parent button has `aria-expanded` but no `aria-haspopup`. The flyout `role="menu"` has no `menuitem` roles, no focus management and no Escape-to-close. |
| N-5 | LOW | After a user closes a group, `openParent` becomes `''`, so the group holding the active page no longer auto-opens on later navigation (`:987`). |
| N-6 | LOW | Duplicate-looking labels: Support› contains "Support", and Network› contains "Network". |
| N-7 | INFO (pre-existing) | No role- or entitlement-based menu filtering beyond `ispOnly`. DEALER sees HR, System and AI Assistant, and companies without `crm-advanced` see CRM. The backend still refuses those requests (`ProductEntitlementService.assertEnabled`), so this is a UX issue, not a security leak. `ispOnly` items are never shown to company accounts, because SUPER_ADMIN uses the platform tree. |

---

## 7. Security and deployment findings

| ID | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| D-1 | HIGH | Non-atomic deploy. `git reset --hard` runs **before** migrations and builds (`update-jointbox.sh:62`). Migrations run before builds (`:126`). The backend `clean` script deletes `dist/` before compiling (`backend/package.json:9`). On a failed build, the old processes keep running, but the checkout, schema and `dist/` no longer match them. A PM2 restart or server reboot then starts broken code. This happened several times today: build failures after migrations had already been applied. | `update-jointbox.sh:45,62,126–143` | Build in a separate directory or release folder, swap only after success, and keep the previous release for rollback. |
| D-2 | MEDIUM | `git reset --hard` silently discards any local server edits in `/opt/jointbox` on every update. This is documented in a comment (`:5`) but not guarded. | `update-jointbox.sh:62` | Abort if `git status --porcelain` is non-empty, or back up the diff first. |
| S-2 | HIGH | Next.js **16.4.2** is reported as vulnerable by the npm advisory database during `next build` ("SecurityFatalError … known security vulnerability"). `npm view next@16` lists 16.4.5 and 16.4.6. The server also reports "10 vulnerabilities (8 moderate, 2 high)". | Build log, first attempt | Plan an upgrade to the latest 16.4.x and run `npm audit`. Not done here (audit only). |
| S-3 | MEDIUM | Default credentials `admin123` are hard-coded as a fallback in the backend and written to `.env` by `install.sh:324,327`. Mitigated by enforced `mustChangePassword` (`jwt.strategy.ts:92`) and the startup check for `admin123` (`main.ts:105–115`). The risk window is the time between install and first login. | as cited | Generate a random first-boot password and print it once. |
| S-4 | LOW | Repo hygiene: 14 zero-byte stray files at the root (`sudo`, `cd`, `del`, `DATABASE_URL`, `SELECT`, …). About 30 `.bundle` and `.patch` files, `Claude outputs/` (licence-server PHP source and a screenshot), and `ai-engine/` (93 MB) are committed. No private keys or secrets were found (the `PRIVATE KEY` grep matched nothing, and `jbx-license/lib/config.php` holds no values). The checkout is 993 MB. | repo root | Remove the stray files and add them to `.gitignore`. |
| S-5 | INFO | `20261120120000_product_feature_defaults` turns the global AI and CRM switches ON for every server. This is intended, but it is a product decision now embedded in a migration. | migration line 7 | Confirm it is acceptable. |
| S-6 | INFO | The DB pool is self-correcting: `safeDatabaseUrl` lowers `connection_limit` when over budget, with a minimum of 2 (`connection-policy.ts:247–258`). `POSTGRES_MAX_CONNECTIONS` is backfilled by the update script. Verified on the server today (health 200). | — | — |
| S-7 | MEDIUM | The `db-push-safety` ratchet test fails against the current `update-jointbox.sh`. A comment contains `--accept-data-loss` (`:122`), and the literal `prisma migrate deploy` is split across a line break (`:121–122`), so both assertions in `common/db-push-safety.spec.ts:52,57` fail. Behaviour is safe (it uses `npm run db:deploy`), but the guard test is red. | as cited | Reword the comment. |

---

## 8. Test results (commands actually run)

All runs used a copy of commit `af61caa` in an isolated workspace.

| Check | Command | Exit | Result |
|---|---|---|---|
| Frontend TypeScript | `tsc --noEmit -p frontend` | **0** | Passed, 0 errors |
| Frontend ESLint (changed files) | `eslint app-shell.tsx disconnects-panel.tsx field-jobs/page.tsx field-jobs/reports/page.tsx tasks/page.tsx companies/page.tsx` | **1** | **Failed**: 52 errors, 12 warnings. Mostly `no-explicit-any` and `react-hooks/set-state-in-effect`, much of it pre-existing. The new sidebar code adds `no-explicit-any` errors (`app-shell.tsx` ~940–950). ESLint is not part of `next build`. |
| Production build, attempt 1 | `CI=1 next build` | **1** | **Failed**: "SecurityFatalError: known security vulnerability" (S-2). This happened after compilation and type-checking had passed. |
| Production build, retry | same | **0** | Passed (84 routes) |
| Playwright | `playwright test e2e/logs-tabs.spec.ts e2e/insights-navigation.spec.ts` (Chromium + mobile, against `next start`, mocked API) | **1** | **12 failed, 4 passed, 2 skipped**. 10 failures: missing "Breakdown for this window" heading (L-1). 2 failures: `insights-navigation` expects a top-level Logs button (N-2). 2 of the 10 L-1 tests (`:562`) fail at the Sessions `sinceHours` assertion instead (L-2). |
| Sidebar viewport and role script | Custom Playwright (6 widths × 3 roles) | 0 | Mock-only. Results in §6. |
| Backend unit tests | `jest` (ts-jest, isolatedModules) over `backend/src` | **1** | 1,430 passed, **34 failed**, 17 suites failed. **Environment-limited:** the Prisma client could not be regenerated for the current schema, because engine downloads are blocked in the audit workspace. This causes the HR, payments and tenancy enum failures and "Prisma did not initialize" errors. `outbound-guard` failures are DNS lookups (no network). Failures that look real and are independent of the environment: `common/db-push-safety.spec.ts` (S-7), and `ai/ai-agent.service.spec.ts` (expected `ForbiddenException`, received `BadRequestException` for "refuses sensitive payroll requests"). |
| Backend TypeScript | — | — | **Not tested** (stale Prisma client types would make the result meaningless) |
| Real MikroTik / L2TP | — | — | **Not tested**. No dialer exists on `main`. |
| Server checks | (from the user's console today) | — | Real infrastructure: migrations applied, wiring check passed, health 200 after the AiModule fix. |

---

## 9. Recommended fixes, ordered by severity

1. **CRITICAL V-1, V-2:** agree the VPN plan:
   - review the unapplied `uplinko-vpn-phase1-2.patch` on a branch, or reimplement it;
   - remove or relabel the inverted LNS installer in `vpn.service.ts:424–462`;
   - add a PPP credential model, NAS-side `/ppp secret service=l2tp` and IPsec writes, and host package and privilege setup;
   - test against a real MikroTik before showing any Connected state.
2. **HIGH V-3:** correct `UPLINKO-VPN-PHASE1*-REPORT.md` so it no longer claims code that `main` does not contain.
3. **HIGH D-1:** make deploys atomic: build first, then switch. Keep the previous release, and do not delete `dist/` before a successful build.
4. **HIGH S-2:** upgrade Next.js to the latest 16.4.x and triage `npm audit`.
5. **HIGH L-1:** restore the visible "Breakdown for this window" and remove the `<details>` toggle. This needs a decision from you, because it reverses today's request.
6. **MEDIUM N-1, N-2:** make rail-mode parents keyboard- and click-operable, and update `insights-navigation.spec.ts` or the design.
7. **MEDIUM S-7, L-2, the AI-agent spec failure, S-3, D-2.**
8. **LOW N-3 to N-6, S-4.**
