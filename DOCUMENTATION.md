# Jointbox — Operator & Administrator Documentation

ISP management panel: subscribers, RADIUS, billing, reseller hierarchy, network
diagnostics and compliance.

Stack: **NestJS** (backend, :3001) · **Next.js** (frontend, :3000) ·
**PostgreSQL 16** · **FreeRADIUS 3.2** · **MikroTik RouterOS**

---

## 1. Installation

```bash
git clone <repo> && cd "Jointbox panel"

# Backend
cd backend
npm install
cp .env.example .env          # set DATABASE_URL and JWT_SECRET
npm run db:push               # creates tables + generates the Prisma client
npm run start:dev

# Frontend
cd ../frontend
npm install
npm run dev
```

**`npm run db:push` chains three things**: fix database ownership → push the
schema → regenerate the Prisma client. Any schema change needs this, or the
code will not compile.

`npx prisma generate` alone needs **no database connection** — useful when the
database is down and you only need the build to pass.

### Required environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Session signing. **Change it from the default.** |
| `RADIUS_DB_URL` | RADIUS database, if separate from the main one |
| `BACKUP_DIR` | Nightly dump location (default `./backups`) |
| `DB_AUTO_SETUP` | `false` disables automatic schema maintenance on boot |
| `TOPOLOGY_AUTODETECT` | `false` disables learning the network path |
| `FUP_ENABLED` | `false` disables data-allowance throttling |

---

## 2. Setup order

Each step depends on the previous one.

1. **Administration → Organization** — your ISP, then franchises/dealers below.
2. **Network → NAS / Routers** — each MikroTik with IP, RADIUS secret, **API
   username and password**.
3. **Network → IP Pools** — names must match the router **exactly**
   (case-sensitive). The page verifies this against the live router and warns
   you when a name does not exist there.
4. **Plans & Stock → Packages** — speed, price, duration, optional data
   allowance and FUP speed.
5. **Plans & Stock → Areas** — coverage areas.
6. **Subscribers → Add** — the customer can dial in immediately.

### Router prerequisites

```
/ip pool add name=pppoe-pool ranges=10.10.10.2-10.10.10.254
/ppp profile set [find name=default] local-address=10.10.10.1
/radius add service=ppp address=<panel-ip> secret=<secret>
/radius incoming set accept=yes port=3799
```

API access must be enabled (`/ip service enable api`) or the panel cannot read
logs, verify pools, or disconnect sessions.

---

## 3. Architecture

```
Customer CPE
   │  PPPoE
   ▼
ONU ──── PON port / splitter ──── OLT ──── BRAS (MikroTik)
                                              │ RADIUS
                                              ▼
                                   FreeRADIUS ── PostgreSQL
                                                     ▲
                                              Jointbox backend
                                                     ▲
                                              Jointbox frontend
```

**Multi-tenancy** is enforced server-side by `ScopeService` using a recursive
subtree query. Every account sees only its own descendants. Only `SUPER_ADMIN`
is global. This is applied in the service layer, not the UI, so it cannot be
bypassed by calling the API directly.

---

## 4. Key behaviours worth knowing

### Addressing
RADIUS sends **either** `Framed-Pool` **or** `Framed-IP-Address`, never both.
Sending both makes the router take the literal address, fail, and drop the
session in a loop. The subscriber's RADIUS tab flags this if it ever occurs.

### Suspension and renewal
Suspension **deletes** the RADIUS credentials and kicks the live session —
removing credentials alone only blocks the *next* login, which on PPPoE can
mean days of free service. Renewal restores them; both the automatic and manual
paths re-sync to RADIUS.

### Renewal modes
`FULL` · `DAYS` · `DATE` · `BALANCE` · `CREDIT`. Renewals extend from the
existing expiry when it is still in the future, so paying early never costs the
customer days. The daily rate divides by the package's own duration, not a flat
30 — a 7-day package at 200 is 28.57/day.

### Reseller pricing
A price row is what **that account pays**. Margin = what the child pays minus
what you pay. A child never sees upstream pricing.

### FUP
Passing the data allowance **throttles** rather than disconnects: the customer
stays connected and billable. Usage is measured over the customer's own billing
period, so a renewal resets it. Requires both a quota and a reduced speed on the
package — without both, nothing is enforced.

---

## 5. Diagnostics

The panel is built so you never need to SSH into a router.

| Screen | Answers |
|---|---|
| Subscriber → **Router Log** | What the MikroTik itself says, with an automatic plain-language diagnosis and the fix |
| Subscriber → **RADIUS** | `radcheck` and `radreply`; flags conflicting addressing and missing address source |
| **Insights → Analytics** | Whether a fault is one customer or a whole VLAN, area, router or dealer |
| **Network → IP Pools** | Whether each pool actually exists on the router |
| `/topology/trace/:id` | Full ONU → splitter → OLT → BRAS path with a verdict |

### Fault correlation
Read top-down — the widest failure wins, because a dead OLT also makes every
splitter beneath it look dead:

| Observed | Cause | Action |
|---|---|---|
| <20% of a BRAS online | BRAS | Check router and uplink. Do not dispatch. |
| <25% of an OLT online | OLT or its uplink | Check OLT power and uplink fibre |
| <34% of one splitter | PON / splitter | One truck roll fixes everyone |
| Only this customer | Customer end | Drop cable, ONU power, fibre bend |

Topology is learned automatically from the circuit-id the OLT stamps into each
session. **This requires PPPoE Intermediate Agent on the OLT.** Without it the
path must be entered manually, and the panel says so rather than guessing.

Optical power (Rx/Tx dBm) is **not** in RADIUS. Those fields stay null until
something polls the OLT over SNMP. Null means "not measured", deliberately
distinct from "bad signal".

---

## 6. Security model

| Control | Behaviour |
|---|---|
| Scope isolation | Every account sees only its own subtree, enforced server-side |
| Self-privilege | An account cannot see or edit its own wallet, commission or permissions |
| Upstream pricing | Hidden from children by design |
| Password export | ISP owner only; every export is logged with who and what |
| API keys | SHA-256 hashed; plaintext shown once at creation |
| Webhooks | HMAC-SHA256 signed, exponential backoff, auto-disabled after 20 failures |
| Infrastructure | OLT management IPs and backup controls are ISP-only |

**If a dealer reports seeing data that is not theirs, treat it as a bug.**

---

## 7. Scheduled jobs

| Job | Schedule | Purpose |
|---|---|---|
| Router log collection | every 2 min | Pull `/log print` from each MikroTik |
| Session reconciliation | every 30 s | MikroTik is the source of truth for online state |
| Topology learning | every 10 min | Parse circuit-ids into OLT/port/ONU |
| FUP enforcement | hourly | Throttle customers past their allowance |
| Auto-renewal | daily | Renew from wallet balance |
| Suspension | daily | Suspend past the grace period |
| Static IP billing | daily 03:45 | Monthly add-on charges |
| KYC expiry sweep | daily 05:00 | Flag expired CNICs |
| Credit defaults | daily 06:30 | Flag unpaid credit extensions |
| Database backup | daily 02:00 | `pg_dump -Fc`, 14-day retention |
| Log pruning | daily 04:20 | Drop router logs older than 14 days |
| Integrity reconcile | daily 03:20 | Wallet↔ledger + RADIUS↔billing drift (also runnable on demand) |

Bulk and long-running work runs through a durable **background job queue**
(`Job` table) rather than blocking the request. Jobs survive a restart — an
interrupted `RUNNING` job is requeued on boot. See §11.

---

## 8. Troubleshooting

**Customer reconnects every few seconds**
Router log will say `could not determine remote address` (the pool does not
exist on the router) or show `255.255.255.254` being issued. Check
Network → IP Pools for the mismatch warning.

**`Property 'x' does not exist on type 'PrismaService'`**
The Prisma client is stale. `npx prisma generate`.

**`Can't reach database server`**
PostgreSQL is down. Check `df -h` **before** restarting — a full disk from
accumulated backups is a common cause, and restarting without freeing space
just repeats the crash.

**`AddrParseError(Ip)`**
A non-IP value is being matched against an `INET` column. Usually a
`nasipaddress` carrying a prefix (`192.168.1.1/32`).

**Renewed customer still cannot connect**
Their RADIUS credentials were deleted by suspension and not restored. Press
**Force Sync** on the subscriber's RADIUS tab.

**Router log tab is empty**
The NAS is missing its API username and password.

---

## 9. Scale

Tested design targets: **200+ NAS**, **large subscriber counts**.

- Bounded worker pools (`mapLimit`) — never all routers at once
- Split poll cycles: fast 30 s for sessions, slow 5 min for health
- Bulk `UPDATE … FROM (VALUES …)` instead of per-subscriber writes
- Aggregate queries per page rather than per row
- Caching on analytics with short TTLs
- Router logs deduplicated by fingerprint and pruned at 14 days

**Postgres `BIGINT` arrives in JavaScript as a string.** Always `Number()`
before arithmetic — `+` concatenates otherwise, which is how a usage figure
becomes `7.7e+251 GB`.

---

## 10. Support

In-app: **Help & Guide** in the sidebar, organised by task.
Diagnostics: **Insights → Logs** for RADIUS checks and backup status.

---

## 11. Money-integrity controls

These features protect the ledger from the everyday mistakes and disputes that
otherwise create silent drift. All of them post **offsetting** entries and never
edit an original record, so the audit trail always reconstructs the full history.

### Refunds — full and partial
**Where:** Billing → Payments → Refund. **When:** a customer overpaid, was
double-charged, or cancelled.

A reason is mandatory and logged. Leave the amount blank to refund the whole
remaining balance, or enter a smaller figure for a partial refund; the same
payment can be refunded in several slices until it is fully returned. Choose
*refund to wallet* to credit the subscriber's balance or leave it off for cash.
The invoice reverts to PARTIAL/UNPAID to match, and any reseller **commission**
earned on the refunded money is clawed back proportionally. A refund is refused
if the payment falls inside a closed accounting period.

### Refund approval threshold
**Where:** Billing → Accounting → *Refund approval limit* card (ISP owner only).
**When:** you want a second pair of eyes on large refunds.

Set a figure; any staff refund above it is **queued** instead of posting, and the
staff member is told it needs sign-off. Pending refunds show on the same card —
Approve posts the refund (and the commission clawback), Reject closes it with
nothing posted. The ISP owner always bypasses the limit. Set it to 0 to disable.

### Accounting-period lock (close the books)
**Where:** Billing → Accounting → *Close the books* card (ISP owner only).
**When:** month-end, once figures are final.

Lock through a date and no one can record or backdate a payment or refund into
that period. Reopen briefly to post a late correction, then close again. This is
enforced server-side for every financial writer, not just in the UI.

### Auditor role (read-only books)
**Where:** Administration → Users → Add → *Auditor* account type (ISP owner only).
**When:** an accountant, regulator, or new hire needs visibility without control.

An auditor sees everything in the subtree it is attached to — attach at ISP level
for the whole business, or under a franchise to scope it — but every write is
refused on the server. Auditors have no wallet and cannot touch customers or money.

### Background job queue
**Where:** Administration → Background Jobs (ISP owner only).
**When:** bulk or long-running work you don't want to block on.

Jobs run off the request path with a live progress bar (Queued → Running → Done),
are durable across restarts, and are tenant-scoped. The built-in
`integrity.reconcile` job checks wallet-vs-ledger balances and cuts any RADIUS
session billing says should be off; `demo.progress` is a harmless queue test.
Other services register their own handlers via `JobsService.register(type, fn)`.
