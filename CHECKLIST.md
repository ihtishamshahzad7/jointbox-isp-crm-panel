# JOINTBOX — Master Upgrade Checklist (Zal Ultra → Beyond)

Goal: fastest, most traceable, most advanced, smallest-footprint ISP panel.
Rule: every phase ships backend first, then frontend page. Tick as you go.

Legend: 🟢 enhance existing · 🆕 build new · ⚡ speed · 🔍 traceability

---

## PHASE 0 — Foundation: Speed, Size & Traceability (do first, everything inherits it)

### ⚡ Performance backbone
- [x] Add Redis (cache + queues): cache dashboard stats, package lists, settings (TTL 30–60s) — CacheService with automatic in-memory fallback when REDIS_URL unset
- [x] Add BullMQ job queues (invoice runs, SMS/email, RADIUS sync) — QueueService; RADIUS bulk sync now queued (`POST /subscribers/sync-all-to-radius/queue`)
- [x] Prisma: add indexes on every FK + frequently filtered columns (status, expiryDate, createdAt, areaId) — ~50 indexes; run `npx prisma migrate dev --name phase0_indexes`
- [x] Cursor-based pagination everywhere (subscribers `?limit=&cursor=`, login/activity/system logs `?cursor=`) — legacy shapes kept when params absent
- [x] Enable Nest compression + ETag; gzip JSON responses
- [x] DB connection pooling (connection_limit/pool_timeout in DATABASE_URL, pgBouncer-ready)
- [x] Response time budget: every list endpoint < 100ms, detail < 50ms — `npm run perf` (test/perf.mjs)
- [x] Bonus: wired 5 dead modules into AppModule (payments, tickets, reports, ip-pool, service-settings — their endpoints were 404 before)

### 🔍 Traceability backbone (the "not exist in world" part)
- [ ] Request ID middleware: every API call gets a trace ID, returned in header, stored in every log row
- [ ] Unified AuditTrail model: who / what / before→after diff (JSON) / trace ID / IP / timestamp — auto-captured by a Prisma middleware, zero per-module code
- [ ] Every entity gets `createdBy`, `updatedBy`, `deletedBy` + soft delete (`deletedAt`) — nothing is ever lost
- [ ] Subscriber Timeline: single merged stream per subscriber (payments, renewals, sessions, tickets, config changes, SMS sent) — one query, one page
- [ ] Live event bus (WebSocket/SSE): sessions up/down, payments, logins stream to dashboard in real time

### 📦 Size discipline
- [ ] Frontend: remove FontAwesome (keep lucide only — one icon lib)
- [ ] Replace recharts if bundle > target with lightweight chart lib; analyze with `next build` + bundle analyzer
- [ ] Route-level code splitting + dynamic imports for heavy pages (reports, charts)
- [ ] Target: first load JS < 150 kB per page; check in CI
- [ ] Backend: single Docker image < 300 MB; remove backend-fixed/, *.zip artifacts from repo

---

## PHASE 1 — Accounting Core + Billing Automation

### 🆕 Backend: accounting module
- [x] `LedgerEntry` model (double-entry, balanced-posting guard)
- [x] Auto ledger postings on: invoice create, payment, refund, reversal, expense, renewal
- [x] `Expense` model + categories
- [x] Subscriber `balance` wallet (top-up, deduct, BalanceTransaction history)
- [ ] `ExtraFee` model (one-off fees on invoices) — activateRenewal already supports ad-hoc extra fee; catalog model later
- [x] Invoice reversal endpoint `POST /accounting/invoices/:id/reverse` (mandatory reason → activity log)
- [x] Refund processing `POST /accounting/payments/:id/refund` (cash or to-wallet)
- [x] Cashflow endpoint `GET /accounting/cashflow?days=30`

### 🆕 Backend: billing automation (cron via @nestjs/schedule + queues)
- [x] Nightly auto-invoice run (00:30, INVOICE_LEAD_DAYS env, skips already-invoiced)
- [x] Auto-renewal run (01:00, wallet balance → PAID invoice → extend expiry → RADIUS re-add)
- [x] Expiry suspension run (02:00, RADIUS remove + isBlocked; CoA disconnect in Phase 5)
- [x] Grace period (BILLING_GRACE_DAYS env)
- [x] Dry-run mode + BillingRun report rows (`GET /billing/runs`, `POST /billing/run/:type?dryRun=1`)

### 🟢 Frontend pages
- [ ] `/invoices` — reversal button wired to new API (API live; UI button pending)
- [ ] `/payments` — refund button wired to new API (API live; UI button pending)
- [x] 🆕 `/accounting` — Ledger tab (filter + cursor load-more)
- [x] 🆕 `/accounting` — Cashflow tab (30/60/90d bars + totals)
- [x] 🆕 `/accounting` — Expenses tab (add/delete with ledger reversal)
- [x] 🆕 `/accounting` — Balances tab (wallets, top-up, history)
- [x] 🆕 `/accounting` — Automation tab (trigger jobs, dry-run toggle, run history)
- [ ] `/dashboard` — revenue today/month, collection %, overdue amount (live via SSE)

---

## PHASE 2 — Communication Engine

### 🆕 Backend
- [x] Notification module: pluggable gateway interface (SMS + SMTP email)
- [x] Gateway drivers: generic HTTP SMS (env-configured, GET/POST), SMTP via nodemailer; unset = SIMULATED mode
- [x] `MessageTemplate` model (SMS + email, {name} {expiry} {amount} {invoiceNo} … variables)
- [x] Send queue with retry + delivery status per message 🔍 (Message table)
- [x] Auto-triggers: invoice created, payment received, expiry reminders (09:00, EXPIRY_REMINDER_DAYS=3,1,0), suspension, renewal, welcome
- [x] `Notice` model (broadcast audit with audience + count)
- [x] Communication log per subscriber (Message.subscriberId — Timeline-ready)

### 🆕 Frontend
- [x] `/communication` Templates tab — CRUD, event binding, live preview, ON/OFF toggle
- [x] `/communication` Send tab — bulk by status/area/package + test send
- [x] `/communication` Log tab — delivery status, retry failed, cursor pagination
- [x] Gateway status indicator (configured/simulated) shown in page header; config via backend .env

---

## PHASE 3 — Payment Gateways + Subscriber Portal

### 🆕 Backend
- [x] Gateway abstraction (initiate / callback / idempotent success-fail)
- [x] Drivers: SANDBOX (end-to-end testable), Stripe, bKash (tokenized), SSLCommerz — Nagad later on demand
- [x] Callbacks with idempotency keys; Stripe webhook signature helper ⚡
- [x] Auto payment confirmation → invoice paid (ledger+notify) → extend expiry → reactivate → RADIUS re-add 🔍
- [x] Reconciliation report `GET /gateway/reconcile` (SUCCESS transactions vs payment rows)
- [x] Subscriber auth: separate JWT scope 'subscriber', login rate-limited (5/10min per user+IP)

### 🆕 Frontend: subscriber portal (`/portal`)
- [x] Login (connection username/password; OTP later with SMS gateway live)
- [x] My usage: online status, per-session download/upload/time, totals
- [x] My invoices + Pay now (gateway redirect, paid/cancelled banner on return)
- [x] My tickets (create, track, see staff replies, reply API ready)
- [ ] Package upgrade self-service (Phase 6)
- [x] Tiny standalone page — no admin shell, no chart libs 📦

### 🟢 Admin
- [ ] `/settings` — payment gateway config tab (config via backend .env for now)
- [ ] `/payments` — gateway transactions view + reconciliation page (APIs live: /gateway/transactions, /gateway/reconcile)

---

## PHASE 4 — RBAC, Security & Multi-Tenancy

### 🆕 Backend: RBAC (Phase 4A — done)
- [x] `RolePermission` model + auto-keyed PermissionsGuard on every controller (resource.read/write derived from route — zero per-endpoint decorators)
- [x] 2FA (TOTP, dependency-free, Google Authenticator compatible) with enroll → confirm → enforced-at-login flow
- [x] Password policy (min length + letters/numbers, PASSWORD_MIN_LENGTH env) on user create/update
- [x] Active session list + remote logout (`/security/sessions`)
- [x] Login anomaly flag — first login from a new IP writes NEW_IP_LOGIN activity row 🔍

### 🆕 Backend: multi-tenancy (Phase 4B)
- [x] `Isp` + `Branch` models; `branchId` on subscribers/users; branch filter on subscriber list; bulk-assign endpoint
- [x] Reseller wallet (UserBalanceTransaction) + automatic commission chain on every payment (salesperson → parents, per-user %) with ledger postings (COMMISSION ↔ RESELLER_BALANCE) 🔍
- [ ] Package assignment per user/reseller with custom pricing (later)
- [ ] Per-branch accounting isolation (later — ledger rows carry subscriberId → branch derivable)

### 🟢 Frontend
- [x] 🆕 `/security` — permissions matrix editor, 2FA enrollment, active sessions with force-logout (login page asks for the 6-digit code when 2FA is on)
- [x] 🆕 `/organization` — ISPs + Branches CRUD with counts (navbar switcher later)
- [x] 🆕 `/organization` Resellers tab — hierarchy tree, per-user commission %, wallet top-up/withdraw + history

---

## PHASE 5 — Network Superpowers

### 🟢 Backend (Phase 5 — core done)
- [x] CoA disconnect via radclient (freeradius-utils) with radacct-close fallback when radclient absent
- [x] MAC binding (radcheck Calling-Station-Id ==) with auto-learn from live session + unbind
- [x] Live session watcher: radacct → per-subscriber live throughput + top talkers ⚡🔍
- [ ] NAS groups/zones (later)
- [ ] Bandwidth profiles + FUP auto speed-drop (later)
- [ ] IPv6 framed-ipv6-prefix in RADIUS replies (later)
- [ ] 🆕 OLT/ONU module (later — needs vendor SNMP/telnet adapters)

### 🟢 Frontend (Phase 5)
- [x] 🆕 `/network` — live sessions with auto-refresh (5s), per-session rate, disconnect button, MAC binding dialog (bind/auto-learn/unbind), online + top-talker stats
- [ ] `/subscribers/[id]` — embed live graph + kill button (later)
- [ ] 🆕 `/network/olt` — ONU list (later)

---

## PHASE 6 — Parity Completion + Intelligence

### 🆕 Inventory
- [ ] Backend: items, categories, suppliers, storage, stock movement (with 🔍 audit)
- [ ] Frontend: `/inventory` section (4 pages)
- [ ] Link items to subscriber (ONU serial handed to customer → shows in Timeline)

### 🆕 Captive portal / Hotspot
- [ ] Voucher login flow (MikroTik hotspot integration)
- [ ] Branded portal page builder (logo, colors, T&C)
- [ ] Voucher batch generation + PIN + reseller distribution (upgrade existing vouchers module)

### 🟢 Reports (server-side, queued, cached ⚡)
- [ ] Financial: revenue, profit, collection, gateway-wise, area-wise
- [ ] Subscribers: growth, churn, expired, area/package distribution
- [ ] Network: top bandwidth users, uptime, NAS load
- [ ] Reseller performance
- [ ] Export: PDF/Excel/CSV generated in queue, downloadable 
- [ ] 🆕 Scheduled reports (daily summary emailed to admin)

### 🆕 Beyond Zal Ultra (the differentiators)
- [x] Global trace search: paste any phone / username / invoice # / payment # / name / id → matches across subscribers, invoices, payments, tickets, staff in one view 🔍 (`/trace`)
- [x] Subscriber Timeline — one merged chronological stream (created, invoices, payments, tickets, messages, wallet moves, sessions, config changes) in a slide-in drawer from any search hit 🔍
- [ ] Anomaly alerts: payment drop, mass offline in an area, unusual login (partial — NEW_IP_LOGIN done in 4A)
- [ ] Command palette (Ctrl+K) (later)
- [ ] Offline-tolerant PWA admin app (later)
- [ ] ai-engine/ churn prediction (later)

---

## Cross-cutting definition of done (every phase)
- [ ] All new endpoints have permission guards + audit trail + trace ID
- [ ] List endpoints paginated + indexed + < 100ms
- [ ] Frontend page lazy-loads, no new heavy deps without bundle check
- [ ] Seed data + happy-path test per module
- [ ] CHANGELOG.md entry

---

### Current page map (for reference)
Existing: dashboard, login, subscribers(+[id]), packages(+policies/taxes/allocations), nas, ip-pools, areas, invoices, payments, vouchers, complaints, users, logs, reports, settings
New by end: accounting(4), communication(3), portal(5), organization, resellers, network(olt/live), inventory(4), trace-search, timeline
