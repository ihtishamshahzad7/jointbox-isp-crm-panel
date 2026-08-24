# Jointbox — Master Completion Roadmap (Consolidated)

**Written:** 24 August 2026
**Purpose:** one prioritized plan that reconciles ROADMAP.md, ADVANCED_FEATURES_ROADMAP.md, CHECKLIST.md, ADVANCEMENT.md and HANDOFF.md into a single build order — including the internationalization work needed to take Jointbox from a strong South-Asia/Gulf regional product to a complete international ISP CRM.

Cross-check against CHECKLIST.md first: Phases 0–5 there are mostly already shipped (marked `[x]`). This roadmap does not repeat that work — it picks up from what's actually left, in the order it should be done.

---

## Phase 0 — Stop the bleeding (do this before anything else)

This phase exists because HANDOFF.md already flags these as live risk, not hypothetical risk.

| # | Item | Why it's first |
|---|---|---|
| 0.1 | Commit, `prisma generate`, build, and deploy the work listed in HANDOFF.md §2 (network device redesign, per-device monitoring method, syslog rule matching/forwarding, two pending migrations) | Written to disk, never committed, **never type-checked**. This is the single biggest risk in the repo right now, by the handoff doc's own words. |
| 0.2 | Fix `update-jointbox.sh`'s silent `git pull --ff-only \|\| true` | It swallows failed pulls and silently rebuilds old code — every "the update didn't work" report traces here. |
| 0.3 | Resolve the 3 open decisions in HANDOFF §3 | Ownerless subscribers (`u`,`v`,`x`,`h`,`e`,`d`,`c` — three ACTIVE and billing nobody), back-charging for pre-fix unbilled activations, and a rate-limit rx/tx audit before any bulk RADIUS re-sync. These are commercial/data decisions, not code — but they block anything downstream that touches billing. |
| 0.4 | Repo hygiene | Delete the two junk files at repo root (`h origin main` and the one whose name is a stray commit message — both are just `less` pager output, no real content), remove the three committed zip files (`backend/src.zip`, `backend/backend-fixed.zip`, `backend/src/nas.zip`) and `.gitignore` that pattern, replace the root `README.md` (currently just a `git clone` line) with a real one. |
| 0.5 | CI type-check gate | HANDOFF §5 calls this "the single largest risk in the workflow" — every change since Phase 9 shipped without a compiler ever running except on the production server. Add `tsc --noEmit` (backend and frontend) as a required CI step before merge. |
| 0.6 | Tests on the money paths | `settleActivation` has specs; activation, RADIUS sync, disconnect, and FUP currently rely on manual verification only. |

---

## Phase 1 — Reliability safety net (1–2 weeks)

| Item | Detail |
|---|---|
| One-click backup & restore | ADVANCEMENT.md Tier 1 #1 — flagged as *the* #1 operational fear for any ISP running this. Scheduled `pg_dump` to a timestamped file, optional push to S3/Drive, a "Backup now" button, a restore flow. |
| Finish the loose ends already listed as unchecked in CHECKLIST.md Phases 1–3 | Invoice-reversal button wired in `/invoices` UI, refund button in `/payments` UI, dashboard live revenue/collection/overdue tiles over SSE, payment-gateway settings tab (currently `.env`-only), gateway transactions + reconciliation page, syslog archive retention/path control in the UI (currently env-driven only). |
| CI pipeline | Lint + type-check + test on every PR, not just locally. |

---

## Phase 2 — Go international (the specific gap you asked about)

This is the concrete work behind "complete international ISP product." Two things already exist and don't need rebuilding: language i18n (5 languages incl. RTL) and multi-tenancy (ISP/Branch). Everything below is genuinely missing.

| Item | Current state | Target |
|---|---|---|
| Multi-currency ledger | One display currency per tenant (`currency` field, no conversion). Ledger/invoice/payment amounts are single-currency. | Per-transaction currency + captured FX rate at posting time; ledger entries store both original and base-currency amounts; reports can roll up across currencies. |
| Tax profiles | One flat `PackageTax` model, no jurisdiction concept. | `TaxProfile`/`TaxRule` keyed by country/region, supports compound and VAT-style tax, assignable per ISP/branch. |
| Payment gateway coverage | bKash, SSLCommerz (Bangladesh), Stripe. | Add PayPal, Razorpay (India), JazzCash/PayFast (Pakistan), Paystack (Africa) — ADVANCEMENT.md already scopes this as "~1-file addition" per the existing driver pattern in `gateway.service.ts`. |
| White-label branding | Multi-tenancy exists structurally; no per-tenant branding. | Logo/colors/custom domain per ISP tenant — needed for resellers to resell this as their own product internationally. |
| i18n completeness | ~540 keys across en/ur/ar(RTL)/es/fr. | Audit for coverage gaps (new features since it was built), add languages for any additional target markets. |

---

## Phase 3 — Network superpowers, the parts not yet done

From CHECKLIST.md Phase 5's unchecked items:

- NAS groups/zones
- Bandwidth profiles + FUP auto speed-drop via CoA (package model already has the speed fields)
- IPv6 (`Framed-IPv6-Prefix` in RADIUS replies)
- OLT/ONU module — vendor SNMP/telnet adapters (Huawei, VSOL, C-Data) for FTTH ISPs
- A UI control for per-device monitoring method (right now it's `curl -X PUT` only, no screen for it — see HANDOFF §4.4)

---

## Phase 4 — Parity completion (Zal Ultra parity, and past it)

From CHECKLIST.md Phase 6 and ROADMAP.md's gap list, still open:

- Inventory: items, categories, suppliers, stock movements, linked to subscriber Timeline (e.g. ONU serial handed to a customer)
- Captive portal / hotspot: branded login page builder, voucher **batch generation + PIN**, redeem page, MikroTik hotspot integration (the vouchers table exists — needs batch + PIN + the login flow)
- Reports expansion: financial (revenue/profit/collection, gateway-wise, area-wise), subscriber (growth/churn/distribution), network (top bandwidth users, uptime), reseller performance — server-side, queued, exportable PDF/Excel/CSV, plus a scheduled daily summary email
- Per-reseller custom package pricing
- Per-branch accounting isolation (ledger rows already carry `subscriberId`, branch is derivable — needs the isolation logic)
- Public API v1 + API keys + rate limits + Postman collection (most service methods already exist — this is a thin documented surface)

---

## Phase 5 — Differentiators (competitive edge, do after the above is solid)

- Anomaly & fault detection: mass-offline-in-an-area alerts, revenue-drop-vs-last-week flags, unusual usage spikes — surfaced on the dashboard, optionally SMS'd to admin
- Subscriber map view (Leaflet/Google), colored by status, click-through to Timeline
- Command palette (Ctrl+K) reusing the existing trace search
- Full real-time push (WebSocket/SSE) replacing the remaining 5-second polling
- Subscriber mobile PWA with push notifications for expiry
- Churn prediction (`ai-engine/`) from payment + usage patterns

---

## Phase 6 — Next-generation platform (longer horizon)

Everything in ADVANCED_FEATURES_ROADMAP.md that's still "Planned" or "Research": an AI assistant for operator troubleshooting, ML-based network optimization, blockchain-based identity/security, edge computing/IoT integration, gamification and social/collaboration features. Treat this as the strategic layer to revisit once Phases 0–5 are done — it's explicitly framed in that doc as coming *after* the operations baseline is stable.

---

## Why this order

Phase 0 isn't optional-first, it's mandatory-first: shipping new "international" features on top of uncommitted, un-type-checked billing code is how the August incidents happened, by the repo's own account. Phase 1 buys a safety net (backups, CI) before more surface area gets added. Phase 2 is deliberately placed right after that — it's the specific thing you asked for, and it doesn't depend on Phases 3–6. Phases 3–6 are ordered by how directly they affect revenue/parity (network + parity features) versus how much they're pure differentiation (Phase 5) or forward-looking research (Phase 6).

## Suggested immediate next step

Phase 0 items 0.1–0.4 are mechanical and low-risk to start on right away (repo hygiene, README, deploying already-written code). 0.3 (the ownerless-subscriber and back-charging decisions) needs your call before any code touches it, since it moves real money.

Tell me which phase (or which specific item) to start building, and I'll work on the files here — you'll pull the finished changes and push them from your end.
