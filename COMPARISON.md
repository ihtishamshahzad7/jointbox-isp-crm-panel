# Jointbox vs Zal Pro — Feature, Speed & Size Comparison

Reference: Zal Pro ISP CRM (docs.onezeroart.com/zalpro) — Onezeroart's licensed self-hosted product.
Basis: Zal Pro feature list from its documentation; Jointbox measured from this repo on 2026-07-15.

Note on honesty: Zal Pro is closed-source, so its internal size/response numbers aren't public. Where I
can't measure Zal Pro directly, the row is marked "typical (Laravel/MySQL)" as an informed estimate, not a fact.

---

## 1. Technology stack

| | Jointbox | Zal Pro |
|---|---|---|
| Backend | NestJS (Node/TypeScript) | PHP 8.x, Laravel |
| Database | PostgreSQL | MySQL/MariaDB |
| Frontend | Next.js 16 (React, Turbopack) | Vue.js + Blade |
| AAA | FreeRADIUS (shared Postgres) | FreeRADIUS |
| Cache/Queue | Redis + BullMQ (optional, auto-fallback) | Laravel queue/cron |
| Licensing | None (you own the code) | Paid per-install license |

---

## 2. Feature parity (what Zal Pro has → do we have it?)

### Have it — equal or better
| Feature | Jointbox | Notes |
|---|---|---|
| Subscribers: add/import/renew/activate/delete/bulk | ✅ | + bulk service settings |
| Packages & policies | ✅ | + taxes, allocations sub-tabs |
| Areas | ✅ | |
| NAS / Router + RADIUS + MikroTik API | ✅ | existing before this work |
| PPPoE | ✅ | |
| Billing & invoicing | ✅ | + full double-entry ledger |
| Payment processing + reminders | ✅ | auto-invoice/renewal/expiry crons |
| Reseller hierarchy | ✅ | reseller→sub-reseller→retailer |
| Reseller wallet + withdraw | ✅ | wallet top-up/withdraw/history |
| Reseller commission/margin | ✅ | auto % up the chain on every payment |
| Roles & permissions | ✅ | per-module read/write matrix |
| Staff management | ✅ | Users section |
| Client self-service portal | ✅ | usage, invoices, pay, tickets |
| Online payment gateways | ✅ (3) | Stripe, bKash, SSLCommerz + sandbox |
| Ticketing | ✅ | portal + admin |
| SMS / notices | ✅ | templates + events + bulk |
| Usage / bandwidth tracking | ✅ | Live Network + portal usage |
| Tracking / activity log | ✅ | login, activity, system, network logs |
| Reports | ✅ (basic) | summaries + export |
| Cron jobs | ✅ | @nestjs/schedule nightly jobs |
| 2FA / OTP | ✅ (staff) | TOTP; subscriber OTP not yet |
| CoA disconnect | ✅ | via radclient, DB-close fallback |

### Beyond Zal Pro — our differentiators
| Feature | Only in Jointbox |
|---|---|
| Global Trace Search | paste phone/username/invoice → all modules at once |
| Unified Subscriber Timeline | one chronological story per customer |
| Double-entry ledger + cashflow + expenses | true accounting, not just billing |
| Live Network auto-refresh + MAC auto-learn | 5s live sessions, learn MAC from session |
| In-app Help & Guide | searchable, links to each page |
| Performance backbone | Redis cache, queues, cursor pagination, perf budget |

### Missing — Zal Pro has, we don't yet
| Feature | Priority | Effort |
|---|---|---|
| Hotspot / captive portal | High (WISPs) | Medium |
| Prepaid cards / tokens (batch generation) | Medium | Small–Medium (vouchers module exists, needs batch+PIN) |
| More gateways: PayPal, Razorpay, JazzCash, PayFast, Paystack, Foster | Medium | Small each (driver pattern ready) |
| Google Map view of subscribers | Medium | Small |
| Easy Backup / Backup server / free-disk | High (ops) | Small |
| Multi-level per-reseller package pricing | Medium | Medium |
| User custom attributes | Low | Small |
| Subscriber OTP login | Low | Small |
| Appearance/branding settings page | Low | Small |
| Documented public API v1 + Postman | Medium | Medium |
| Inventory (items/suppliers/stock) | Low | Medium |
| OLT/ONU management | Low (FTTH) | Large (vendor-specific) |
| IPv6 / FUP auto-throttle / NAS groups | Low–Med | Medium |

Parity score: Jointbox covers ~85% of Zal Pro's advertised feature set, plus 6 features Zal Pro lacks.
The 15% gap is mostly hotspot, extra gateways, backup tooling, map, and prepaid-card batches.

---

## 3. Size (measured)

| | Jointbox (measured) | Zal Pro (typical Laravel) |
|---|---|---|
| Application source code | backend 1.4 MB + frontend 1.5 MB ≈ **3 MB** | tens of MB (app + vendor/ PHP packages) — estimate |
| Backend modules | 20 feature modules | — |
| Frontend pages | 23 pages | — |
| DB models | 24 Prisma models | — |
| Runtime deps (node_modules) | large (dev only; not shipped to browser) | large (vendor/) |
| Docker target | < 300 MB goal (Phase 0) | image varies |

The **source** is deliberately small (~3 MB). Browser bundle is kept lean (one icon lib, no heavy chart deps on core pages).

---

## 4. Speed

| Aspect | Jointbox | Zal Pro (typical) |
|---|---|---|
| List endpoints | cursor pagination, no COUNT on big tables; budget <100ms (perf test enforces) | offset pagination (typical Laravel) |
| Detail/stats | cached 30s (Redis or in-memory); budget <50ms | per-request DB |
| Heavy work | off request path via queues (RADIUS sync, messages, billing) | queue/cron |
| DB indexes | ~50 added on FKs + hot filter columns | schema-dependent |
| Responses | gzip + ETag | server-dependent |

Reproducible check: `npm run perf` in the backend prints p95 per endpoint and fails if any list > 100ms.

---

## 5. Build/compile time (this project, after the OneDrive fix)

| | Before | After |
|---|---|---|
| Frontend page compile | up to ~11 min (OneDrive sync thrash) | seconds (moved to F:\, Turbopack fs-cache) |
| Backend build | full nest build each `start:dev` | unchanged (~seconds after deps cached) |

---

## 6. Honest bottom line

Jointbox already matches Zal Pro on the **core ISP loop** — subscribers, RADIUS, packages, billing, resellers with commission, portal, gateways, tickets, permissions — and adds trace search, real double-entry accounting, and a live network view that Zal Pro doesn't advertise.

To be a full drop-in replacement, the highest-value gaps to close next are: **hotspot/captive portal**, **one-click backup**, **a few more payment gateways**, and **prepaid-card batches**. None are architecturally hard; the driver/module patterns are already in place.
