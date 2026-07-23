# JOINTBOX — End-to-End Test Script (real ISP workflow)

Follow in order. Each step says **Do** and **Expect**. If a step fails, stop and note the step number.

Prep: both servers running — backend `npm run start:dev` in `F:\Jointbox panel\backend`, frontend `npm run dev` in `F:\Jointbox panel\frontend`. Open `http://localhost:3000`. Have the backend terminal visible (SIMULATED messages and job logs print there).

---

## 0. Login & health
1. **Do:** open `http://localhost:3000/login`, sign in with your admin account.
   **Expect:** lands on Dashboard; sidebar shows Trace Search, Subscribers, Payments, Invoices, Accounting, Communication, Organization, Packages, IP Pools, Vouchers, NAS, Live Network, Areas, Complaints, Reports, Users, Logs, Security, Settings.

---

## 1. Organization (multi-tenant base)
2. **Do:** Organization → ISPs → type "My ISP" → Add ISP.
   **Expect:** row appears with 0 branches.
3. **Do:** Organization → Branches → name "Head Office", pick "My ISP" → Add branch.
   **Expect:** branch listed under the ISP, 0 subscribers / 0 staff.

## 2. Package & pool
4. **Do:** IP Pools → create a pool (e.g. name `pool1`, network/subnet per your setup).
   **Expect:** pool saved.
5. **Do:** Packages → create "Home 20M", price 1000, duration 30, download 20 / upload 10, assign `pool1`.
   **Expect:** package appears with pool name shown.

## 3. Area & reseller
6. **Do:** Areas → add an area "Zone A".
   **Expect:** saved.
7. **Do:** Users → create a reseller: role RESELLER, name "Ehtisham", email/phone, password (min 8, letters+numbers).
   **Expect:** created. (A too-weak password should be rejected — that's the policy working.)
8. **Do:** Organization → Resellers → set Ehtisham's commission to 10 → Save.
   **Expect:** "Commission saved".

## 4. Create a subscriber (the core ISP action)
9. **Do:** Subscribers → New. Fill name "Test Customer", phone, username `test01`, password, pick package "Home 20M", area "Zone A", set salesperson = Ehtisham. Save.
   **Expect:** subscriber created; backend log shows RADIUS sync lines for `test01`. If a WELCOME communication template is active, backend prints a SIMULATED SMS.
10. **Do:** Subscribers → open `test01`.
    **Expect:** profile shows package, area, status ACTIVE.

## 5. Verify RADIUS wiring
11. **Do:** on the subscriber, use the RADIUS status/check action (or Subscribers list "check radius").
    **Expect:** `existsInRadius: true`, a Cleartext-Password entry and a Mikrotik-Rate-Limit reply. (If your FreeRADIUS + a real router is connected, `test01` can now actually dial in.)

## 6. Billing — invoice & payment
12. **Do:** Invoices → create an invoice for `test01` (amount = package price), or use the subscriber's activate/renew.
    **Expect:** invoice UNPAID; backend prints INVOICE_CREATED SIMULATED message if that template is active.
13. **Do:** Accounting → Ledger.
    **Expect:** two new rows for the invoice — ACCOUNTS_RECEIVABLE debit and REVENUE credit, equal amounts.
14. **Do:** Payments → record a payment against that invoice (method CASH, full amount).
    **Expect:** invoice becomes PAID.
15. **Do:** Accounting → Ledger again.
    **Expect:** CASH debit + ACCOUNTS_RECEIVABLE credit for the payment; plus a COMMISSION debit + RESELLER_BALANCE credit of 100 (10% of 1000).
16. **Do:** Organization → Resellers.
    **Expect:** Ehtisham's wallet balance is now 100. Click Wallet → history shows a COMMISSION row.

## 7. Accounting extras
17. **Do:** Accounting → Expenses → add "Bandwidth" 5000.
    **Expect:** listed; Ledger shows EXPENSE debit / CASH credit.
18. **Do:** Accounting → Cashflow.
    **Expect:** today shows inflow (the payment) and outflow (the expense), net = inflow − outflow.
19. **Do:** Accounting → Balances → find `test01` → Top up 500.
    **Expect:** balance 500; history shows TOPUP.

## 8. Communication
20. **Do:** Communication → Templates → create SMS, event EXPIRY_REMINDER, body `Hi {name}, your {package} expires {expiry}. Due {amount}.` → toggle ON.
    **Expect:** saved, preview fills sample values.
21. **Do:** Communication → Send → Send test (SMS, your phone, any text).
    **Expect:** header shows SMS = simulated; Log tab shows the message with status SIMULATED. (Backend prints `[SIMULATED SMS]`.)
22. **Do:** Communication → Send → bulk to status ACTIVE, short message → Queue broadcast.
    **Expect:** "Queued N of N"; messages appear in Log.

## 9. Subscriber portal (customer side)
23. **Do:** open a new tab `http://localhost:3000/portal`, log in as `test01` (its username + password).
    **Expect:** portal loads (no admin sidebar); Overview shows package, expiry, wallet 500.
24. **Do:** portal → Invoices. If you left one unpaid, click "Pay (test)" → on the sandbox page click "Pay now".
    **Expect:** redirected back with "Payment received"; that invoice now PAID; subscriber expiry extended; backend shows the payment + commission chain again.
25. **Do:** portal → Support → open a ticket.
    **Expect:** appears; and in admin Complaints it shows up.

## 10. Billing automation (the hands-off engine)
26. **Do:** Accounting → Automation → keep "Dry run" checked → click "Run auto-invoice".
    **Expect:** a run row appears (dry), processed/succeeded counts, no real invoices created.
27. **Do:** same with "Run auto-renewal" and "Run suspension" (dry).
    **Expect:** run rows with details listing which subscribers *would* be affected.
    (Only uncheck Dry run once the dry previews look correct.)

## 11. Live network (needs online sessions)
28. **Do:** Live Network. If a real router/RADIUS is feeding sessions, online users appear.
    **Expect:** live list with rate + data; Disconnect and MAC buttons. With no live RADIUS traffic this is empty — that's fine in a dry lab.

## 12. Security / RBAC
29. **Do:** Security → Two-Factor Auth → Set up 2FA → add the key to Google Authenticator → enter the 6-digit code → Activate.
    **Expect:** "active". Log out, log back in → it now asks for the code.
30. **Do:** Security → Permissions → pick SALES → tick only `subscribers.read` + `subscribers.write` → Save. Log in as a SALES user.
    **Expect:** that user can use Subscribers but gets "Missing permission" on, say, Accounting. (SUPER_ADMIN is never restricted.)
31. **Do:** Security → Active Sessions.
    **Expect:** your sessions listed; Force logout kills one.

## 13. Trace search (the differentiator)
32. **Do:** Trace Search → type the customer's phone number (or `test01`).
    **Expect:** matches across subscribers/invoices/payments. Click the subscriber.
33. **Expect:** timeline drawer shows the whole story in order — created, invoice, payment, wallet top-up, ticket, messages, sessions.

---

## Quick pass/fail checklist
- [ ] Login + sidebar complete
- [ ] ISP + branch created
- [ ] Package + pool + area created
- [ ] Reseller + commission set
- [ ] Subscriber created + RADIUS synced
- [ ] Invoice → ledger balanced
- [ ] Payment → invoice PAID → commission to reseller wallet
- [ ] Expense + cashflow + subscriber wallet top-up
- [ ] Template + test SMS (SIMULATED) + bulk send
- [ ] Portal login + pay (sandbox) + ticket
- [ ] Automation dry-runs produce run reports
- [ ] 2FA enrol + enforced at login
- [ ] Permission matrix restricts a role
- [ ] Trace search + timeline show full history

If every box ticks, the core ISP loop works end to end. Real-money gateways and real RADIUS disconnects need live credentials/hardware, but everything else is verified in the lab.
