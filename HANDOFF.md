# Jointbox — Engineering Handoff

**Written:** 23 August 2026
**Purpose:** carry the working context that lives in a chat session into the repository, where it survives an account change, a new machine or a new engineer.

Read this with `Jointbox_Engineering_Handbook.docx` (architecture, case studies, roadmap). This file is the *current state*: what is done, what is deployed, what is decided, and what is still open.

---

## 1. THE MOST IMPORTANT THING

> **Large amounts of finished work have never reached the production server, and some has never been committed.**

Almost every "this feature is broken" report during August traced back to this, not to the code. Verify deployment *before* debugging anything.

### 1.1 Why it kept happening

`update-jointbox.sh` was **not executable** (`Permission denied`). Every "update" the operator ran silently did nothing. Fixed by:

```bash
chmod +x /opt/jointbox/update-jointbox.sh
```

There is a second, related trap still present: the script runs

```bash
git pull --ff-only 2>/dev/null || true
```

which **swallows a failed pull** and then rebuilds the *old* code. It looks like a successful update and changes nothing. If the server has local modifications, `git stash` first.

### 1.2 How to verify a deploy actually landed

```bash
cd /opt/jointbox
git log --oneline -1          # must match origin/main
git status --short            # local edits here will block --ff-only
cd backend && npx prisma generate && npm run build
cd ../frontend && rm -rf .next && npm run build
pm2 restart all
```

Then hard-refresh the browser (`Ctrl+Shift+R`) — the frontend bundle is cached and will otherwise show the old UI.

---

## 2. UNCOMMITTED WORK — DO THIS FIRST

The sandbox used for the last several changes went down mid-session, so the following is **written to disk but never committed and never type-checked**. This is the single biggest risk in the repo right now.

| Area | Files | Status |
|---|---|---|
| Network Devices redesign | `frontend/app/monitoring/devices/page.tsx` | uncommitted, unbuilt |
| Device drawer | same file (`DeviceDrawer`) | uncommitted, unbuilt |
| Per-device monitoring method | `backend/prisma/schema.prisma`, `backend/src/ndm/port-polling.service.ts`, `ndm.service.ts`, `frontend/app/monitoring/ndm.ts` | uncommitted, unbuilt |
| Syslog rule matching | `backend/src/ndm/ndm.constants.ts`, `syslog-receiver.service.ts` | uncommitted, unbuilt |
| Syslog forwarding | `schema.prisma`, `syslog-receiver.service.ts`, `ndm.service.ts`, `ndm.controller.ts` | uncommitted, unbuilt |
| Rule builder UI | `frontend/app/monitoring/alerts/page.tsx` | uncommitted, unbuilt |
| Migrations | `20260823020000_device_monitor_method`, `20260823030000_syslog_forwarding` | uncommitted |

**Action:**

```bash
cd "F:\Jointbox panel"
cd backend && npx prisma generate && npm run build     # generate FIRST — new models
cd ../frontend && npm run build
cd .. && git add -A && git commit -m "..." && git push
```

`prisma generate` must run before the backend build: `syslogForwardTarget` and the new `NetworkDevice` columns do not exist on the Prisma client until it does. The receiver deliberately uses `(this.prisma as any)` in the forwarding path to tolerate that ordering, but the service layer does not.

---

## 3. OPEN DECISIONS (these are yours, not the code's)

### 3.1 Ownerless subscribers

Seven subscribers have `userId = NULL`: `u`, `v`, `x`, `h`, `e`, `d`, `c`. Three (`u`, `v`, `x`) are **ACTIVE and online with nobody billed**.

- They appear in no reseller's books (a scoped query cannot return a row that belongs to nobody).
- Activation charged nobody, because `quote()` needs an owner.

**Do not use Move to fix this** — `transferOwnership()` suspends the customer and cuts internet, which is correct for a real dealer handover but wrong for a missing field on a live customer.

Use instead:

```bash
GET  /subscribers/audit/ownerless
POST /subscribers/assign-owner   { subscriberIds, ownerId, reason }
```

or Edit → Owner → Save (the field appears only while the subscriber is ownerless). Nothing is charged and nobody is disconnected.

`x` is *sold by Super Admin* and probably belongs to Super Admin, not D1. Decide per subscriber.

### 3.2 Back-charging

Once they have owners, `GET /organization/pricing/unbilled` lists genuinely unbilled activations. `POST /organization/pricing/backcharge` collects them — idempotent, prepaid-enforced per dealer, service untouched.

**This takes real money from D1's wallet for customers already running.** It is a commercial decision, not a technical one. The guard in `d574617` prevents recurrence either way, so doing nothing is a legitimate choice.

### 3.3 Rate-limit rx/tx order

`buildRateLimit()` was emitting `download/upload`; MikroTik expects `rx/tx` = **upload/download**. Every asymmetric package had its two speeds applied to the wrong directions. Fixed in `c7eeb4b`.

**Before any bulk re-sync**, run `GET /packages/rate-limit/audit`. If an operator previously compensated by entering speeds swapped in the package form, the fix flips those packages to genuinely wrong values. Correct the package fields first.

---

## 4. MANUAL STEPS THE CODE CANNOT DO

### 4.1 MikroTik API permissions — blocks disconnects

The API user (`test`) lacks the `write` policy, so `/ppp/active/remove` is refused. This is why sessions could not be cut from the panel.

Winbox → **System → Users → Groups** → the group for `test` → tick `api`, `read`, `write`, `test`.

Verify: `node /opt/jointbox/tools/check-mikrotik-api.js 192.168.88.17 test '<password>'`

### 4.2 CoA — likely disabled

RouterOS ships with `/radius incoming accept=no` and silently drops Disconnect-Requests.

```
/radius incoming print
/radius incoming set accept=yes port=3799
```

Verify: `GET /network/nas/:id/test-coa` — any reply (ACK **or** NAK) proves the port and secret are good.

### 4.3 Interim accounting — usage shows ~0

`radacct` counters only advance when the NAS sends Interim-Updates:

```
/radius set [find service=ppp] interim-update=1m
```

### 4.4 Monitoring method on internet targets

After deploying §2, every `NetworkDevice` remains `SNMP`. DNS / google.com / youtube.com will keep reporting *SNMP timeout* until switched:

```bash
curl -X PUT localhost:3001/monitoring/ndm/devices/<id> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"monitorMethod":"ICMP"}'
```

There is **no UI control for this yet** — see §5.

---

## 5. KNOWN GAPS / NEXT WORK

Ordered by value.

1. **`monitorMethod` selector** in the Add Device wizard and device settings. Without it, §4.4 is curl-only.
2. **Syslog log-to-file archiving** — Kiwi writes dated files to disk. Needs path, rotation and retention policy.
3. **Forwarding UI** — `SyslogForwardTarget` API works; no screen exists.
4. **JSON package/policy store → PostgreSQL.** `backend/data/packages-management.json` holds package settings and RADIUS policies. No transactions, no audit, and it can race across the 11 pm2 instances. Highest-severity architectural debt.
5. **Startup assertion for unguarded crons.** 25 cron jobs once ran on all 12 pm2 processes because `isPrimaryInstance()` was never called. Fixed, but nothing prevents a new cron from omitting it — make it structural.
6. **Encrypt the router API password.** Ten consumers; the RADIUS shared secret must stay plaintext (FreeRADIUS reads the table directly).
7. **Automated tests on the money paths.** `settleActivation` has specs; activation, RADIUS sync, disconnect and FUP rely on manual verification.
8. **CI type-check.** `tsc` cannot run over the Windows mount from the dev sandbox, so the server is currently the first place code is compiled.

---

## 6. THINGS THAT LOOK BROKEN BUT ARE NOT

Checked and confirmed working; do not "fix" these again.

- **Port up/down alerts and sound.** `PORT_DOWN` defaults to critical *with sound*, `PORT_UP` to info, recovery closes the incident, per-port `soundEnabled` / `soundUpEnabled` gates exist, and alert keys dedupe so a port that stays down does not re-alert every 30s.
- **Syslog server.** UDP, TCP **and TLS** listeners driven by `syslog_server_setting`.
- **SNMP uptime.** `sysUpTime` ticks ÷ 100, with a self-heal that rewrites legacy tick-scaled rows. The "1179d for an 11d device" bug is fixed.
- **PPPoE exclusion.** `classifyInterface()` returns `PPPOE_SESSION` for anything matching `/pppoe/`, strips Winbox `<>` brackets, and the default policy is a strict allowlist: PHYSICAL + VLAN only.
- **First-poll noise.** `UNKNOWN → UP` initialises state without raising an event.
- **Profit vs wallet.** Margin writes `ProfitEntry` only; it never credits a wallet.

---

## 7. ENGINEERING PRINCIPLES THIS CODEBASE LEARNED THE HARD WAY

Each came from a real production defect. They are in the handbook with full write-ups.

1. **Verify against reality; never assume an action succeeded.** Query the router.
2. **Do not assume the shape of a schema you do not own.** `ON CONFLICT` on `radcheck` aborted every RADIUS sync because the stock FreeRADIUS schema has no such index.
3. **Fail loudly rather than plausibly.** A wrong-but-reasonable fallback ("now − 30 days") is worse than an error.
4. **One writer per concern.** Duplicated logic drifts, and the copy is usually the stale one.
5. **Refuse impossible configuration at the boundary.** A warning that still saves is an error with extra steps.
6. **Diagnostics must distinguish failure modes.** Preserving the RouterOS `=message=` found a root cause faster than any code reading.
7. **Enforce invariants structurally, not by documentation.** A comment claiming "every cron gates on this" was false for 25 crons.
8. **When a fix changes behaviour for every customer, ship the audit before the change.**
9. **Money and network state change together, or neither changes.**
10. **Surface discrepancy; never conceal it.** The Owner column's `?? salesperson` fallback hid a whole class of billing bugs.

---

## 8. QUICK REFERENCE

```bash
# Deploy
cd /opt/jointbox && git pull && bash update-jointbox.sh

# Is a subscriber's RADIUS profile right?
cd /opt/jointbox/backend && export $(grep RADIUS_DATABASE_URL .env | xargs)
psql "$RADIUS_DATABASE_URL" -c "SELECT attribute,op,value FROM radreply WHERE username='<u>';"
# EMPTY radreply = the sync is failing. Check logs for 'Failed to sync RADIUS profile'.

# Why was this activation free / who pays?
curl -s localhost:3001/organization/pricing/explain/<subscriberId> -H "Authorization: Bearer <t>"

# Router API healthy?
node /opt/jointbox/tools/check-mikrotik-api.js <host> <user> '<pass>'

# Rate-limit impact before a bulk re-sync
curl -s localhost:3001/packages/rate-limit/audit -H "Authorization: Bearer <t>"
```

**Paths:** repo `/opt/jointbox` · env `backend/.env` · JSON store `backend/data/` · backups `/var/backups/jointbox` · FreeRADIUS `/etc/freeradius/3.0/`

**Topology:** 11 × `jointbox-backend` (`JOINTBOX_ROLE=web`), 2 × `jointbox-frontend`, 1 × `jointbox-worker` (`JOINTBOX_ROLE=worker`, runs all 32 crons).
