# Jointbox — Advancement Roadmap (making it the most advanced ISP panel)

Written 2026-07-15. Ordered by value-to-effort for a real ISP. Each item says WHY it matters
operationally, not just what it is.

---

## Just shipped (this round)
- **Automatic audit trail** — a global interceptor now logs every create/update/delete across
  every module (who, what, entity, id, IP, before-safe detail), including failed attempts.
  This fills the Logs → Activity tab automatically and gives you real forensic traceability.
  Passwords/secrets/OTP codes are stripped from the recorded detail.

---

## Tier 1 — highest value, low/medium effort (do next)

### 1. One-click backup & restore
WHY: the #1 operational fear for an ISP is losing the subscriber/billing DB. Zal Pro sells this.
WHAT: `pg_dump` to a timestamped file on a schedule, downloadable from Settings; optional push to
S3/Google Drive; a restore button. A nightly cron + a "Backup now" button.

### 2. Hotspot / captive portal + prepaid cards
WHY: opens the entire WiFi/WISP market (cafes, hotels, events) — a segment you can't serve today.
WHAT: MikroTik hotspot login page (branded), voucher/prepaid-card **batch generation** with PIN,
card-based login, and a public voucher redeem page. The vouchers table already exists — needs
batch + PIN + a captive login flow.

### 3. More payment gateways
WHY: each gateway you're missing is a country/market you can't bill in.
WHAT: add PayPal, Razorpay (India), JazzCash/PayFast (Pakistan), Paystack (Africa). The driver
pattern in `gateway.service.ts` makes each a ~1-file addition.

### 4. Subscriber map view
WHY: field teams and planning need to see customers geographically; complaints cluster by area.
WHAT: a Google/Leaflet map plotting subscribers by their lat/long (already stored), coloured by
status, with area filters. Click a pin → open their timeline.

### 5. Dashboard that actually breathes
WHY: the first screen should answer "how's the business right now?" at a glance.
WHAT: live tiles — revenue today/this month, collection %, overdue total, online now, new signups,
expiring in 3 days — plus a 30-day revenue sparkline and an alerts strip. Data already exists in
accounting + insights; this is assembly.

---

## Tier 2 — strong differentiators (medium effort)

### 6. Anomaly & fault detection (the "not in the world" edge)
WHY: catch problems before customers call.
WHAT: watch radacct — if many users in one NAS/area drop within minutes, raise a "possible outage"
alert; flag revenue drops vs last week; flag a subscriber's unusual usage spike. Surface as an
alerts feed on the dashboard + optional SMS to the admin.

### 7. FUP / bandwidth automation
WHY: fair-usage enforcement is expected on modern plans.
WHAT: when a subscriber crosses a data quota, auto-push a slower Mikrotik-Rate-Limit via CoA and
notify them; reset on renewal. Package model already has the speed fields.

### 8. Public API v1 + API keys
WHY: resellers and third-party apps (mobile apps, shops) want to integrate; it's a selling point.
WHAT: documented, versioned REST endpoints with per-user API keys and rate limits, plus a Postman
collection. Most service methods already exist — this is a thin, documented surface + key auth.

### 9. Command palette (Ctrl+K)
WHY: power users (support staff) move 5x faster with keyboard nav.
WHAT: press Ctrl+K anywhere → jump to any subscriber/invoice/page instantly (reuses trace search).

### 10. Scheduled & richer reports
WHY: owners want a daily/weekly summary without logging in.
WHAT: revenue/churn/collection/reseller-performance reports generated server-side (queued),
exportable PDF/Excel, and a "daily summary emailed to admin at 8am".

---

## Tier 3 — scale & polish (larger / later)

- **Real-time live network via WebSocket/SSE** — push session up/down instantly instead of 5s polling.
- **OLT/ONU management** — SNMP/telnet adapters per vendor (Huawei, VSOL, C-Data) for FTTH ISPs.
- **IPv6** — framed-ipv6-prefix / delegated prefix in RADIUS replies.
- **Per-reseller package pricing** — each reseller sets their own resale price per package.
- **Subscriber mobile app / PWA** — installable portal with push notifications for expiry.
- **Churn prediction (ai-engine/)** — flag customers likely to leave from payment + usage patterns.
- **Multi-currency & tax profiles** — for ISPs operating across borders.
- **White-label branding** — logo/colors/domain per ISP tenant (multi-tenancy already in place).

---

## Suggested next sprint (2 weeks of focused work)
1. One-click backup (Tier 1.1) — protects the business.
2. Dashboard live tiles + alerts strip (Tier 1.5 + start of 2.6) — visible daily value.
3. 2–3 more payment gateways (Tier 1.3) — unlock markets.
4. Hotspot + prepaid card batches (Tier 1.2) — new customer segment.

These four turn Jointbox from "feature-complete core" into "clearly ahead of Zal Pro" for most ISPs.
