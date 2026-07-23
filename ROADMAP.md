# Jointbox Panel — Gap Analysis vs. Zal Ultra ISP CRM

Date: 2026-07-15 · Reference: docs.onezeroart.com/zalultra · Stack: NestJS + Prisma/PostgreSQL + FreeRADIUS · Next.js 16

## Where we are (implemented)

| Area | Status | Notes |
|---|---|---|
| RADIUS / AAA | ✅ Strong | Full FreeRADIUS schema (radcheck, radacct, etc.), per-subscriber sync, session & auth-log lookup, bulk sync, missing-from-radius repair, PPPoE sessions |
| Subscribers | ✅ Strong | CRUD, import/export, search, expiring list, bulk delete, bulk service settings, renewal activation (29 endpoints) |
| Packages | ✅ Strong | CRUD + policies, taxes, allocations (22 endpoints) — matches Zal's Package module |
| NAS | ✅ Good | 14 endpoints; frontend page present |
| IP Pools | ✅ Good | CRUD + stats |
| Areas | ✅ Good | CRUD + stats |
| Invoices | 🟡 Basic | CRUD-level only (6 endpoints) |
| Payments | 🟡 Basic | Manual payments only; PaymentMethod enum exists |
| Vouchers | 🟡 Basic | Model + CRUD; no batch generation / reseller distribution / PIN |
| Tickets | 🟡 Basic | Categories, priorities, messages; no assignment workflow, templates, email notify |
| Users & Roles | 🟡 Partial | Role enum incl. RESELLER/SUB_RESELLER/RETAILER, but no granular permissions |
| Logs | ✅ Strong | Login, activity, session, system, network logs |
| Reports | 🟡 Basic | 4 endpoints; jspdf export on frontend |
| Frontend pages | ✅ | dashboard, subscribers, packages(+3 sub), nas, ip-pools, areas, invoices, payments, vouchers, complaints, users, logs, reports, settings, login |

## What's missing (vs. Zal Ultra)

### 1. Accounting depth — highest priority
Ledger, cashflow, expenses, subscriber balance/wallet, extra fees, invoice reversal, refunds, tax reports, multi-currency, hierarchical reseller profit distribution.
- Backend: `Ledger`, `Expense`, `Balance/Wallet`, `ExtraFee` models + modules; double-entry postings on every invoice/payment.
- Frontend: ledger, cashflow, expenses pages under an Accounting section.

### 2. Automation (billing engine)
Auto-invoice generation, auto-renewal, expiry suspension, overdue handling.
- Backend: `@nestjs/schedule` cron jobs (invoice run, renewal run, expiry disconnect via RADIUS/CoA, reminder dispatch). `activate-renewal` endpoint exists — needs a scheduler around it.

### 3. Communication — missing entirely
SMS + Email services, templates, notices, bulk messaging, payment reminders, expiry alerts, delivery reports.
- Backend: notification module with pluggable SMS/SMTP gateways, template CRUD, send queue.
- Frontend: templates, notices, bulk-send pages; settings tabs for SMS/Email.

### 4. Online payment gateways — missing
Only manual payment methods now. Zal supports bKash, Nagad, SSLCommerz, Stripe, PayPal, Razorpay, etc.
- Backend: gateway abstraction + webhooks + auto payment confirmation + reconciliation.
- Frontend: gateway settings page; pay-now flow.

### 5. Subscriber self-service portal — missing
Separate login for subscribers: usage, invoices, online payment, package upgrade, tickets.
- Backend: subscriber auth (separate JWT scope) + portal endpoints.
- Frontend: new route group (e.g. `/portal`) or separate app.

### 6. Multi-tenancy — missing
Zal's core selling point: unlimited ISPs → branches → resellers with isolated accounting.
- Backend: `Isp`, `Branch` models; tenant scoping on all queries; reseller wallet & profit chain.
- Frontend: ISP/branch switcher, branch management pages.

### 7. Granular RBAC & security
Permission-level access control, 2FA, departments, password policies, active session management.
- Backend: `Permission`/`RolePermission` tables + guards; TOTP 2FA.

### 8. Network extras
NAS groups, MAC binding, OLT/ONU management, bandwidth profiles/FUP, CoA (verify disconnect/speed-change works), IPv6 attributes.

### 9. Inventory — missing
Items, categories, suppliers, storage/stock movements.

### 10. Captive portal / Hotspot — missing
Customizable login page, voucher login, MikroTik hotspot integration.

### 11. Reports expansion
Financial (revenue/profit/collection), subscriber growth, top bandwidth users, reseller performance; PDF/Excel/CSV export server-side.

## Suggested build order (backend → frontend per phase)

1. **Accounting core + billing automation** (ledger, balance, expenses, invoice reversal; cron auto-invoice/renewal/suspension) — unlocks real ISP operations.
2. **Communication** (SMS/email gateways, templates, reminders) — required by billing automation.
3. **Payment gateways + subscriber portal** — self-service payments reduce ops load.
4. **RBAC/2FA + multi-tenancy** (ISP/branch scoping, reseller profit chain).
5. **Network extras** (NAS groups, MAC binding, CoA hardening, OLT/ONU, IPv6).
6. **Inventory, captive portal/hotspot, reports expansion** — parity completion.
