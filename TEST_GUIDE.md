# Jointbox — ISP Self-Test Guide & What-If Audit

A hands-on walkthrough to test every major flow yourself, with exact numbers and
the expected result at each step, followed by 100+ "what if" checks covering
edge cases, current limitations, and how to resolve them.

---

## 0. Before you start (one-time)

Any time the backend `schema.prisma` changes, regenerate the Prisma client
**before** building:

```
cd backend
npm run db:push     # creates DB columns + regenerates TypeScript types
npm run build
npm start           # NOT "npm start run:dev"
```

Frontend:
```
cd frontend
npm run build       # or: npm run dev
```

Recommended env for testing (backend `.env`):
```
FUP_ENABLED=true
FUP_MODE=BLOCK               # BLOCK = stop net over quota; THROTTLE = reduce speed
FUP_DEFAULT_QUOTA_GB=1500    # blanket cap when a plan has none
RENEW_REMINDER_DAYS=3,1
RENEW_GRACE_DAYS=0
RENEW_AUTOSUSPEND=false      # start OFF so nothing is cut while you watch it
CONSOLE_SHELL_ENABLED=false  # keep the root console disarmed unless in use
```

---

## 1. The test network (build this first)

Create this tree (Users page → Add, or "Act as" to descend a level):

```
ISP (you, SUPER_ADMIN)
└── Chitral Franchise      (RESELLER)     wallet: 50,000
    ├── Booni Dealer       (SUB_RESELLER) wallet: 10,000
    │   └── Laspure        (RETAILER)     wallet: 0   ← deliberately empty
    └── Rashun Dealer      (SUB_RESELLER) wallet: 10,000
```

Package to test with: **Home 4Mbps**, base price **500**, 30-day cycle.
Also make **Home 6Mbps** base **700**, and **Home 2Mbps** base **300**.

Set the wholesale ladder (Pricing page, price each DIRECT child):
- ISP → Chitral pays **800** for 4Mbps (yes, above base — that's your margin)…
  actually keep it simple: ISP → Chitral **400**, → 6Mbps **600**, → 2Mbps **250**.
- Chitral → Booni **500** (4Mbps), Chitral → Rashun **500**.
- Booni → Laspure: **leave unset** (test inheritance).

Expected: on the Pricing "ladder" for 4Mbps you should see
ISP(owns, cost 0) → Chitral pays 400 → Booni pays 500 → Laspure pays **500**
(inherited from Booni, because Booni's price is Laspure's cost until Booni sets one).

---

## 2. Pricing & visibility

| # | Do this | Expected |
|---|---------|----------|
| 2.1 | Act as **Laspure**, open Plans & Stock | Sees 4/6/2 Mbps packages, "You pay" = **500 / inherited** — NOT the ISP base |
| 2.2 | Laspure sets a retail price 1,200 on 4Mbps | Saves; profit shows **+700** (1200 − 500) |
| 2.3 | Laspure tries retail **400** (below 500 cost) | Rejected: "you would lose 100 per subscriber" |
| 2.4 | Act as **Rashun**, check Laspure's price | Not visible — siblings can't see each other |

---

## 3. Activation accounting (the core)

**Scenario A — retailer with money.** Top up Laspure to 2,000 (as Booni or ISP).

| # | Do this | Expected |
|---|---------|----------|
| 3.1 | Act as Laspure → add subscriber on 4Mbps, sell price 1,200 | Subscriber ACTIVE and in RADIUS |
| 3.2 | Check Laspure wallet | −500 (their buy price), now 1,500 |
| 3.3 | Check Booni wallet | +0 margin (Booni's cost 500 = what Laspure pays) — unchanged if Booni's buy = Laspure's cost |
| 3.4 | Check Chitral wallet | +100 (500 − 400) |
| 3.5 | Check ISP | +400 received |
| 3.6 | Subscriber record | costPrice 500, sellPrice 1,200, profit 700 |

**Scenario B — retailer with NO money (your exact question).** Laspure wallet = 0.

| # | Do this | Expected |
|---|---------|----------|
| 3.7 | As **ISP**, create a subscriber owned by Laspure | Record is created but **INACTIVE**, never reaches RADIUS |
| 3.8 | Message | "Insufficient balance…" / created unpaid |
| 3.9 | Top up Laspure, then Activate | Now goes ACTIVE, wallet debited 500 |

This is the prepaid rule: **the retailer's wallet is always the one charged, at
their buy price — even when the ISP creates the subscriber.** No free service.

---

## 4. ISP top-up debits the direct parent

| # | Do this | Expected |
|---|---------|----------|
| 4.1 | As ISP, Organization → open **Laspure's** wallet → add 1,000 | Laspure +1,000 |
| 4.2 | Check **Booni** wallet | **−1,000** (Booni is Laspure's direct parent — it funds it) |
| 4.3 | Check ISP / Chitral | unchanged |
| 4.4 | Ledger on Booni | "Funded Laspure (initiated by ISP)" |
| 4.5 | Empty Booni, retry | Refused: "Booni's wallet has X, not enough…" |

---

## 5. Package change — pro-rata (your upgrade/downgrade question)

Assume Laspure's sub is on **4Mbps**, 30-day cycle, **4 days used, 26 left**.
Buy prices: 4Mbps = 500, 6Mbps = 700-ish (use Booni→Laspure inherited), 2Mbps = 300.

| # | Do this | Expected |
|---|---------|----------|
| 5.1 | Upgrade to **6Mbps** | Charged only the **26/30** of the *difference*, not a full month. Wallet −(newCost−oldCost)×26/30 |
| 5.2 | Insufficient wallet on upgrade (non-admin) | Rejected: "Upgrade costs X more for the 26 days left…" |
| 5.3 | Downgrade to **2Mbps** | **Refund** unused 26 days of 4Mbps, charge 26 days of 2Mbps; net credited to wallet |
| 5.4 | Expiry date | **Unchanged** — same renewal date, remaining days moved onto new plan |
| 5.5 | Subscriber record | costPrice/sellPrice/profit updated to new plan; ledger shows "Plan change … pro-rata 26/30d" |
| 5.6 | RADIUS | new speed applied immediately (session kicked) |

**Known limitation:** pro-rata settles the **owner's** wallet only. Upstream
tiers keep what they earned on the original activation. Ask if you want full
multi-tier re-settlement.

---

## 6. Quota / FUP (1500 GB, stop net, extend)

Set a small quota to test fast: put **quota = 1** GB on one subscriber (Service
Settings), or set `FUP_DEFAULT_QUOTA_GB=1`.

| # | Do this | Expected |
|---|---------|----------|
| 6.1 | Subscriber page → data allowance card | Shows Used / cap / Remaining, % |
| 6.2 | Let usage exceed the cap (or lower the cap under current use) → wait for the hourly sweep, or call `POST /compliance/fup/run` isn't there — the sweep is `@Cron('15 * * * *')` | With `FUP_MODE=BLOCK`: state → **BLOCKED**, removed from RADIUS, SMS sent |
| 6.3 | With `FUP_MODE=THROTTLE` | state → THROTTLED to the plan's FUP speed |
| 6.4 | Click **"+ Extend quota"**, add 50 GB | bonus added; if now under cap, service **auto-restored** |
| 6.5 | Click **"Restore net / full speed"** | Manually lifts the block |

---

## 7. Dunning / auto-suspend & expiry

| # | Do this | Expected |
|---|---------|----------|
| 7.1 | Set a subscriber expiry to **3 days** out | Next daily sweep (07:10) sends "expires in 3 days" SMS |
| 7.2 | Set expiry to **yesterday**, `RENEW_AUTOSUSPEND=true` | Sweep flips them EXPIRED + cuts RADIUS + "please pay" SMS |
| 7.3 | Trigger now instead of waiting | `POST /subscribers/lifecycle/run` (ISP only) |
| 7.4 | Take a payment / renew | Reactivates, extends expiry, re-adds to RADIUS |

---

## 8. NAS / IP-pool sharing isolation

| # | Do this | Expected |
|---|---------|----------|
| 8.1 | As ISP, NAS → Share NAS-1 → "Only this account" → tick Booni | Booni sees NAS-1; Rashun does NOT |
| 8.2 | Share NAS-2 → Rashun only | Rashun sees NAS-2; Booni does NOT |
| 8.3 | Act as Rashun, open NAS list | Sees only NAS-2 |
| 8.4 | Same test on IP Pools | Same isolation |

---

## 9. Log isolation & drill-down

| # | Do this | Expected |
|---|---------|----------|
| 9.1 | Act as Booni → Logs | Sees only Booni + its downline; NOT ISP logins, NOT Rashun |
| 9.2 | As ISP → Logs → account picker → "Booni" | Sees just Booni's activity |
| 9.3 | Network logs as Rashun | Only its own subscribers'/routers' events |

---

## 10. Notes, Console, misc

| # | Do this | Expected |
|---|---------|----------|
| 10.1 | Subscriber page → Notes → add "transmission: rooftop dish → SXT" | Saved with author + time; pin/delete work |
| 10.2 | Same note as a sibling | Not visible; parent sees it |
| 10.3 | ISP → Server Console → Backend logs | Shows live backend output |
| 10.4 | Console terminal, shell disarmed | Refuses to run until `CONSOLE_SHELL_ENABLED=true` |

---

## 100 What-Ifs — edge cases, limits, and fixes

### Accounts & hierarchy
1. What if a dealer tries to create a franchise? → Blocked (one level down only).
2. What if you delete a dealer with live subscribers? → Use ISP purge; children detach / move to ISP; RADIUS cleaned.
3. What if two accounts have the same email? → Rejected (email is the login, unique).
4. What if a reseller has no parent? → Only the ISP is parentless; everyone else must have one.
5. What if you move a subscriber to another account? → Transfer flow with pro-rata settlement.
6. What if a retailer creates a sub-account? → Retailers are the last selling tier — staff only.
7. What if an account is set inactive? → It cannot sign in; its subscribers keep running until expiry.
8. What if you impersonate ("Act as") then create a user? → Created under the impersonated account.
9. Limitation: no per-account 2FA enforcement policy — add if needed.
10. Limitation: no bulk user import — one at a time or via API.

### Pricing
11. What if a package isn't priced to anyone? → Only the ISP (owner) sees it.
12. What if the ISP prices a franchise but not the dealer? → Dealer/retailer inherit the franchise's cost until priced.
13. What if a reseller sets retail below cost? → Rejected with the exact loss amount.
14. What if you change a wholesale price after activations exist? → Only affects future activations; existing subscribers keep their stored costPrice.
15. What if a package base price changes? → New activations use it; the ladder recomputes.
16. What if a dealer has no retail price set? → Sell defaults to base; profit may read low — set retail.
17. Limitation: no scheduled/future price changes.
18. Limitation: no volume/tiered discounts per reseller.
19. What if currency differs per reseller? → Single system currency; set in Settings.
20. What if you delete a package that's priced to resellers? → Blocked until price rows removed.

### Wallet & activation
21. What if the retailer's wallet is exactly equal to the cost? → Allowed (>=).
22. What if two clerks activate at once from one wallet? → Atomic check; the second is refused (no negative).
23. What if the ISP activates for a broke retailer? → Created INACTIVE; retailer charged only once funded.
24. What if you top up then immediately activate? → Works; balance is live.
25. What if a wallet goes negative? → Shouldn't with enforcement on; only admin overrides can.
26. What if you withdraw balance from a dealer? → walletWithdrawScoped pulls it back up the chain, audited.
27. What if activation succeeds but RADIUS is down? → Charged + created; RADIUS sync retried/logged; fix router then re-sync.
28. What if you double-click Save on activation? → Idempotent settlement — charged once.
29. Limitation: refunds on delete aren't automatic — handle via withdraw/manual.
30. Limitation: no wallet transfer between siblings (only parent↔child).

### Package change (pro-rata)
31. What if you change plan on day 1? → ~full-cycle difference charged/refunded.
32. What if on the last day? → ~0 pro-rata (few days left).
33. What if no expiry date is set? → Treated as a fresh full cycle.
34. What if upgrade and wallet is short (reseller)? → Rejected with the shortfall.
35. What if the ISP does the upgrade? → Allowed; owner wallet debited (may go negative).
36. What if you downgrade to a cheaper plan? → Net refund to owner wallet.
37. What if you change plan twice in a day? → Each settles pro-rata from the current state.
38. Limitation: upstream tiers aren't re-settled on plan change (owner only).
39. What if the new plan has a different pool? → RADIUS re-synced with new pool/speed.
40. What if the customer is offline during change? → Speed applies on next connect; session kicked if online.

### Quota / FUP
41. What if a plan has no quota and no default? → Unlimited, never enforced.
42. What if `FUP_DEFAULT_QUOTA_GB=1500`? → Every un-capped subscriber gets 1500 GB.
43. What if a subscriber has a per-user quota? → Overrides the package/default.
44. What if you extend quota while blocked? → Auto-restores if now under the (raised) cap.
45. What if the cycle renews? → Usage window resets (bonus GB should be reset — currently persists; reset manually).
46. What if usage data (radacct) is missing? → Treated as 0 used; not enforced.
47. What if BLOCK mode but the router won't disconnect? → RADIUS removal still cuts new sessions; CoA best-effort.
48. What if THROTTLE but the plan has no FUP speed? → Skipped in throttle mode (nothing to slow to).
49. Limitation: quota is per-cycle, not rolling; resets with the billing cycle.
50. Limitation: no per-app/time-of-day quota.

### Expiry & dunning
51. What if `RENEW_AUTOSUSPEND=false`? → Reminders only; nothing cut.
52. What if expiry passes with grace days > 0? → Cut only after expiry + grace.
53. What if payment arrives after suspension? → Reactivate flow restores service.
54. What if the sweep runs twice? → Idempotent-ish; already-EXPIRED are skipped.
55. What if no phone number? → SMS skipped; status still changes.
56. What if the SMS gateway is unset? → Send fails silently; status/enforcement still happen.
57. Limitation: no email/WhatsApp reminders yet (SMS only) — WhatsApp is next.
58. Limitation: no configurable reminder message templates per event (uses built-in text).
59. What if a customer is mid-session at expiry? → Kicked on the sweep (BLOCK) or at next renewal.
60. What if you want reminders at 7 days too? → `RENEW_REMINDER_DAYS=7,3,1`.

### NAS / network
61. What if a router's API creds are wrong? → "no API access"; sessions/logs can't be read; RADIUS still works.
62. What if you share a NAS to a dealer then delete the dealer? → Assignment cascades away.
63. What if a franchise re-shares a NAS the ISP gave it? → Allowed (holder can re-share); "Only this account" isolates it.
64. What if two dealers need the same router? → Share to each, or share to the franchise with propagate.
65. What if the router is offline? → Reachability shows down; live sessions empty; RADIUS auth may still work if router caches.
66. What if you disconnect a user? → CoA/RADIUS removal drops the session.
67. Limitation: no SNMP graphs / bandwidth monitoring (NOC) yet.
68. Limitation: no automatic router config push beyond RADIUS/PPP profile.
69. What if pool CIDR doesn't match the router? → Addresses won't route; fix the pool name to match MikroTik.
70. What if a subscriber has a static IP? → Managed under Static IPs; released on deactivate.

### Logs & audit
71. What if a dealer opens System logs? → ISP-only; refused.
72. What if a dealer queries another's username in RADIUS logs? → Scoped out; only their subtree.
73. What if you need one child's logs? → Logs page account picker.
74. What if login attempts fail from an unknown IP? → Recorded ISP-only (security signal).
75. Limitation: no log export to SIEM; use the API.
76. What if the console shows "(no backend output captured yet)"? → Logs appear as the server prints; buffer fills over time.
77. What if you're on Windows and want system logs? → Uses Windows Event Log automatically.
78. Limitation: frontend logs need `FRONTEND_LOG_PATH` or pm2 to show in the console.

### Notes
79. What if a sibling adds a note? → Not visible to you; your parent sees both.
80. What if you pin a note? → Floats to the top.
81. What if you delete someone's note? → Only your own (or your downline's) — else refused.
82. Where else can notes go? → Any record: `<RecordNotes entityType="INVOICE" entityId={id} />`.

### Billing & invoices
83. What if auto-invoice is unwanted on create? → Pass `skipInvoice: true`.
84. What if a payment is recorded? → Commission cascades to salesperson + upline.
85. What if an invoice is partially paid? → Tracked (PARTIAL); due amount shown.
86. What if a gateway (Stripe/bKash) callback fails? → Idempotent; transaction stays INITIATED until success.
87. Limitation: no automated statements/PDF batch emailing.
88. Limitation: no accounting-software (QuickBooks/Xero) export.

### Vouchers / portal
89. What if you generate vouchers? → Voucher module + captive portal hook.
90. Limitation: customer self-care portal is thin (pay/usage/ticket) — a target upgrade.

### Data / ops
91. What if the DB restarts mid-activation? → Transaction rolls back; no half-charge.
92. What if BIGINT usage overflows JS? → Coerced with Number() before math (fixed).
93. What if backups fail on Windows? → `pg_dump` path is Linux-style; fix to a Windows path (open item).
94. What if you exceed 100 accounts? → Tree views (Act-as, Users, Hierarchy) with search + dense mode.
95. What if the mount/OneDrive is slow? → Builds are slow; move repo off OneDrive for dev.
96. Limitation: no multi-language UI yet.
97. Limitation: no white-label per franchise (logo/domain) — high-value next step.
98. Limitation: no mobile app (technician/customer).
99. Limitation: AI features intentionally deferred.
100. What if you need a feature not here? → It's modular; most additions are one service + one endpoint + one screen.

---

## Priority fixes / next features (my recommendation)
1. WhatsApp reminders (reuse the dunning engine).
2. Windows backup path fix.
3. Customer self-care portal/app.
4. Reseller white-labeling.
5. Multi-tier pro-rata on plan change.
6. Basic NOC (device up/down + outage banner).
