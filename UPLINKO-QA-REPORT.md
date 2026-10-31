# Uplinko — QA Fixes Report

Base: `origin/main` @ `1d76830`. **No commit or push made** (per instruction). Changes are in the working tree and captured in `uplinko-qa-fixes.patch` (apply with `git apply uplinko-qa-fixes.patch` on a clean `main`).

## Files changed (4)
| File | Change |
|------|--------|
| `frontend/app/logs/disconnects-panel.tsx` | Breakdown always-visible; removed toggle/aria-hidden/inert; removed 6 summary cards + duplicate title + redundant reason block; compact toolbar; records moved to bottom |
| `frontend/app/logs/page.tsx` | 5→4 main tabs; Disconnect Analysis under Sessions; legacy `overview` URLs still resolve |
| `frontend/app/network-center/page.tsx` | Removed the two redundant tab hints (NAS/Routers, IP Pools) |
| `frontend/e2e/logs-tabs.spec.ts` | Rewritten to enforce the correct behavior |

## Confirmed issues fixed

**1. Disconnect Analysis (disconnects-panel.tsx)**
- Breakdown now renders **expanded by default** — the toggle button, `aria-hidden={!…}` and `inert={!…}` are all removed. The container keeps the `breakdownExpanded` style class permanently so it is always open.
- Removed: duplicate "Disconnect log" heading + "Ended sessions…" description; the six summary cards (Sessions ended, Customers affected, Need attention, Online now, Average session, Most common); the redundant Reason summary / "Show all 18 reasons" block.
- Kept: compact toolbar (time range + NAS filter + search + clear-filter), Breakdown for this window, Who/what ended them (+ "Click a part to filter the log"), Over time, By NAS/router, All reasons, Customers who disconnected most, All 18 termination causes with RFC 2866 descriptions/counts/%/classification, Expected/Info/Check/Fault legend, and the actual disconnect records + pagination.
- Final order: compact controls → Breakdown → charts & reason categories → all 18 causes → actual records. (Summary cards are gone, not above the breakdown.)
- Removed now-dead state (`breakdownExpanded`, `allReasons`, `reasonChips`, `t`) and the unused `Stat` component.

**2. Playwright tests (logs-tabs.spec.ts)** — rewritten to assert: breakdown heading visible immediately; container not `aria-hidden="true"` and not `inert`; no Show/Hide toggle; the summary cards absent; all 18 cause entries present; reason filter re-queries with `cause=`; records region accessible; exactly four main tabs with no "Overall Stats"; Disconnect Analysis reachable under Sessions. Runs at 6 widths (375/430/768/1024/1280/1440) and also asserts no horizontal overflow.

**3. Logs navigation (page.tsx)** — `LOG_VIEWS` is now exactly **Connections, Sessions, Authentication & AAA, Audit Trail**. "Overall Stats"/overview removed as a main tab; Disconnect Analysis is a sub-tab under **Sessions** (it already existed there). URL compatibility preserved: `LEGACY_LOG_TABS` maps `overview`/`stats`/`overall-stats`/`disconnects` → `sessions`, and `LEGACY_LOG_FEATURES` maps them → `disconnects`, so old links (`?logTab=overview&logFeature=disconnects`) still open the Disconnect Analysis view. No hidden 5th tab (the nav renders from `LOG_VIEWS`, now length 4 — verified by test).

**4. Network Center hints (network-center/page.tsx)** — removed the two named redundant hints ("Your MikroTiks and their RADIUS settings.", "Address ranges handed out to customers automatically."). `Hub`'s `hint` is optional and only renders when present, so no empty space. **`backend/src/ai/knowledge.generated.json` was deliberately NOT modified** — those strings also exist there as assistant knowledge; per instruction, assistant knowledge was not blindly deleted.

**5. Feature guide (feature-guide.tsx)** — **already compliant, no change needed.** It defaults to `closed` and renders only a compact floating "How to use" button; the full panel appears only on click, resets to closed on every page/tab change, returns just the button when hidden (no empty space), and keeps full instructions + ARIA labels. It does not auto-show large panels on any page.

## Other pages audited (item 6)
Swept all pages for marketing/hero copy and label-restating hints. Findings: the hub/wizard hints across packages, users, billing-center, ip-pools, segments **add real operational value** (e.g., the IP-pool "must match the pool name on the router character for character" warning) and were kept. The "Create your first … to get started" strings are legitimate empty-state guidance, not marketing. No further redundant content warranted removal. The only label-restating hints found were the two in Network Center (fixed).

## Tests actually executed
- **TypeScript typecheck** (`tsc --noEmit`): **PASS** (exit 0).
- **ESLint** on changed files: **no new errors introduced** — error counts identical or lower vs base on every changed file (page.tsx 34=34, network-center 2=2, disconnects-panel ≤10, e2e spec 0). Pre-existing `any`/effect-setState debt remains; the repo's CI gate only fails on *new* errors in changed files.
- **Production build** (`next build`): **PASS** (exit 0) — all routes compile, including `/logs` and `/network-center`.
- **Frontend unit tests** (`npm run test:unit`): **PASS** 16/16.
- **Playwright e2e** (`logs-tabs.spec.ts`), run against the built app with `/api` mocked:
  - **chromium: 9/9 PASS**
  - **mobile (Pixel 7): 9/9 PASS**
  - Covers breakdown-always-visible, no toggle, no summary cards, 18 causes, reason filter, 4 tabs, Disconnect Analysis under Sessions, and no horizontal overflow at all 6 widths.

## Responsive checks (item 7)
The restructured Logs page was verified for no horizontal overflow at 375/430/768/1024/1280/1440 via the e2e suite (chromium + mobile). Branding/colors/app-shell untouched. A full manual sweep of every other module at all breakpoints was **not** performed — those pages were not modified by this work; the one page I restructured is covered.

## Remaining / not done
- Full per-module responsive manual QA across all routes (Dashboard, Subscribers, Accounting, etc.) at every breakpoint — not executed; out of scope of the files changed here.
- Pre-existing lint debt (`no-explicit-any`, a `set-state-in-effect` in network-center that predates this work) left as-is to avoid scope creep.
- No commit/push made — deliver via `uplinko-qa-fixes.patch`.
