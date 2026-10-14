# RADIUS tenancy policy — one company's router never logs in another company's subscriber

What the policy is, where it is enforced, the operator tool, and the staging /
production runbook (monitor first; enforcement only on explicit authorisation).

| Thing | Where |
|---|---|
| Decision | PostgreSQL functions from migration `20261013130000_radius_tenancy_policy`: `jointbox_radius_tenancy(kind, username, source address, claimed NAS-IP)`, `jointbox_radius_tenancy_onoff(claimed, source)`, helpers `jointbox_radius_authz`, `jointbox_radius_claim`, … (all `SECURITY DEFINER`, `search_path` pinned) |
| Switch | table `radius_tenancy_setting` (one row): `off` / `monitor` / `enforce` — **every database starts in `monitor`** |
| What it refused | table `radius_tenancy_event` (kind, reason, subscriber username or empty, router source address, mode, count, first/last seen) |
| FreeRADIUS policy | `/etc/freeradius/3.0/policy.d/jointbox-tenancy` (installed from `backend/scripts/radius-tenancy.policy`) |
| FreeRADIUS hooks | `sites-enabled/default`: `jointbox_tenancy` right after `-sql` in `authorize`, `jointbox_tenancy_accounting` right before `-sql` in `accounting`; `sites-enabled/inner-tunnel`: `jointbox_tenancy` right after `-sql` in `authorize` |
| Operator tool | `sudo bash backend/scripts/radius-tenancy.sh --report / --status / --install [--force] / --monitor / --enforce [--force] / --off / --uninstall` |
| Audit | every mode change, install and uninstall: `SystemLog` (source `radius-tenancy`) and syslog tag `jointbox-radius-tenancy` |
| Backups | `/var/backups/jointbox-radius/tenancy/<stamp>-<action>/` (0700; newest 30 kept) |
| Panel guard | `radiusTenancyAllows()` (`backend/src/nas/radius-tenancy.ts`), kind `coa` |

## 1. The problem

FreeRADIUS identified the router by the packet's source address and checked
only that router's shared secret, then looked the user up in `radcheck` **by
username alone**. Nothing tied the subscriber's company to the router's
company, so:

* any company's router authenticated any other company's subscriber — with
  PAP, CHAP, MS-CHAPv2, EAP-MD5, and inside EAP-TTLS / PEAP tunnels (the outer
  identity can name one of the router's own subscribers while the inner,
  authenticated identity is another company's);
* the same router could write accounting for the other company's subscriber;
* `NAS-IP-Address` is whatever the router writes into the packet: a router
  claiming another company's router address filed its sessions and login log
  rows under that router (visible to that company) and steered later CoA /
  Disconnect-Requests at it; an `Accounting-On/Off` claiming it closed that
  router's open sessions;
* the panel sent CoA / Disconnect-Requests, and fell back to the MikroTik API
  (with that router's API login), to whatever router a subscriber's session or
  assignment pointed at — including another company's.

## 2. The policy

A request is allowed only when the subscriber and the router belong to the
same company, or the router has been **explicitly** shared into the
subscriber's company. Everything else — missing, disabled, ambiguous,
orphaned, platform-owned — is refused.

Ownership comes only from database relationships:

| Fact | Source |
|---|---|
| Which router | the packet's **source address** — the address FreeRADIUS matched the client and its shared secret by — → `nas."nasIp"`. An IPv4 router seen through a dual-stack socket (`::ffff:a.b.c.d`) is the same router. |
| NAS-IP-Address | only the router's **claim**: it never makes a request allowed; a claim naming *another company's* router (active or not) is refused (`nas-ip-foreign`). Its own address, a router of the same company, or an address no router has (a private address behind NAT) is harmless. |
| Router's owner | `nas."ownerId"` |
| Subscriber | the username the sql module looks `radcheck` up by (`sql_user_name`) → `"Subscriber".username` (exact) → `"Subscriber"."userId"` |
| Company | an account's top-most ancestor below the platform account (same rule as `ScopeService.companyRootId()`) |
| Explicit share | a `"NasAssignment"` row for that router: to the subscriber's owner (any `propagate`), or to an account above the owner **inside its company** with `propagate = true`. It counts across companies only if its author (`assignedById`) belongs to the router's company or is the platform account. |

Reasons, in decision order (shown in `radius_tenancy_event.reason`,
`--report`/`--status`, and the FreeRADIUS auth log as
`Login incorrect (jointbox tenancy reject:<reason>)`):

| Reason | When |
|---|---|
| `nas-unknown` | the source address is no router (a hand-made client, `127.0.0.1`) |
| `nas-disabled` | the only routers on that address are inactive |
| `nas-ambiguous` | two **active** routers share the address |
| `subscriber-unknown` | no subscriber has that username |
| `subscriber-no-owner` | the subscriber has no owner, or the owner account is gone |
| `subscriber-no-company` | the owner is the platform account, or its parent chain loops / is deeper than 64 |
| `nas-no-owner` / `nas-no-company` | no share, and the router has no owner / is owned by the platform account |
| `cross-company` | no share, and the router belongs to another company |
| `nas-ip-foreign` | everything else allowed, but `NAS-IP-Address` names another company's router |
| `onoff-foreign-sessions` | an `Accounting-On/Off` would close open sessions (under the claimed address) of subscribers the sending router may not carry |
| `check-error` | the check itself failed (a query error): refused when enforced, allowed and recorded in monitor — an error never switches enforcement off |

**EAP.** An EAP Identity or NAK round verifies no credential (FreeRADIUS
always answers it with an Access-Challenge) and its name is often a
placeholder (`anonymous` outside a TTLS / PEAP tunnel). On those rounds
(`EAP-Type` Identity/NAK — set by FreeRADIUS from the packet, a router cannot
send it) the router and its claim are judged as always, and so is a name that
**is** a subscriber; a name that is no subscriber is left to the round that
verifies the credential — the EAP-MD5 / MSCHAPv2 round, or the identity inside
the tunnel (`inner-tunnel` hook) — and is not recorded.

**No platform bypass.** The platform account owns no company: a router or
subscriber it owns directly passes nothing, and a share *to* it reaches
nobody. It can only author an explicit share (recorded in `assignedById`,
listed by `--report`). Access groups are visibility filters inside one company
and authorise nothing across companies.

## 3. Where it is enforced

| Path | What happens | Code |
|---|---|---|
| FreeRADIUS `authorize`, default server (PAP, CHAP, MS-CHAP(v2), EAP-MD5) | Access-Reject with the reason; the post-auth log records the router the request came **from** | `policy.d/jointbox-tenancy` → kind `auth` (`auth-eap-id` on EAP Identity/NAK rounds) |
| FreeRADIUS `authorize`, `inner-tunnel` (EAP-TTLS / PEAP inner identity) | the tunnel's inner authentication is refused | same policy; the inner request carries the outer source address |
| FreeRADIUS `accounting` (Start / Interim / Stop) | acknowledged (no retry storm), **nothing written** | `jointbox_tenancy_accounting` → kind `acct`, `ok` + `return` before `-sql` |
| FreeRADIUS `Accounting-On/Off` | acknowledged; sessions closed only when the claim is not another company's router and every open session under it belongs to a subscriber the sender may carry | `jointbox_radius_tenancy_onoff` |
| Panel CoA / Disconnect / live re-rate, duplicate-session sweep, `NetworkService.disconnect` | nothing sent to a router the policy refuses that subscriber on; the MikroTik-API fallback and its verification skipped | `radiusTenancyAllows()` in `CoaService`, `NetworkService` |
| Panel router-API calls in the subscriber lifecycle (suspend, expiry, delete, password/package change kicks) | the router's API login is never used for another company's subscriber | `SubscribersService` (4 call sites) |
| Panel FreeRADIUS config editor | refuses to edit `policy.d/jointbox-tenancy`, and refuses any save of a site file that would drop a tenancy hook | `RadiusAdminService.writeFile` |
| Panel static IP (pin / un-pin the PPP secret, verify, health check) | never written to or read from a router the policy refuses that subscriber on; RADIUS still gets the address; the health check falls back to accounting | `StaticIpService` |
| Panel live traffic of one subscriber, subscriber router log (live and on-demand refresh) | not read through a refused router's API login | `SubscribersService.readMikrotikCounter`, `LogsService.getRouterLogsForSubscriber`, `RouterLogsService.forSubscriber` |
| Panel "Sync sessions" (company run) | closes ghost sessions of the company's own subscribers only; another company's rows on its router are left for the platform run (`leftForPlatform`) | `IntegrityService.reconcileSessionsWithRouter` |
| Panel network logs | a company sees events of its routers about its own subscribers (or about no subscriber), never another company's | `LogsService.getNetworkLogs` |
| Panel stored router logs | every line of a router the company owns; on a router only shared with it, only lines about its own subscribers | `RouterLogsService.list` |

Two ratchet tests (`src/nas/radius-tenancy-boundary.spec.ts`) fail the build if
application code ever reads or writes the switch, or a CoA or any router-API
call that can concern one subscriber (`sendCoa`, PPP secret / active-session /
address / log / session-list reads and writes, 12 methods) appears without the
tenancy check; router-level uses are exempted by name, each with its reason.

**Modes** — one database row read on every request; no restart:

| Mode | Login / accounting / CoA | Recorded |
|---|---|---|
| `off` | as before the policy | nothing |
| `monitor` | as before the policy | every would-be refusal |
| `enforce` | refused as above | every refusal |

**Failure behaviour** (never "open"):

| Situation | FreeRADIUS | Panel CoA / API |
|---|---|---|
| switch row missing, or switch table unreadable | treated as `enforce` | refused |
| a query inside the check fails | `check-error`: refused when enforced, allowed + recorded in monitor | refused |
| function missing / database unreachable / FreeRADIUS's DB account cannot execute it | no answer → **refused in every mode** | refused |
| event table unwritable | decision unchanged (recording is best effort) | — |

With the database unreachable `radcheck` cannot be read either, so logins fail
regardless of the policy; FreeRADIUS reconnects its SQL pool after
`retry_delay` (30 s in the stock `mods-available/sql`) once the database is
back.

**Install and update.** The migration seeds `monitor` and never changes an
existing row. FreeRADIUS consults none of this until `--install` adds the
hooks. `install.sh` runs `--install` (a new server is therefore in monitor
mode); `update-jointbox.sh` re-runs `--install` only where the policy is
already installed, to keep the policy file current — it never installs it on
its own and never changes the mode. Every refresh validates a staged copy and
restores the previous configuration on any failure.

**Logging and privacy.** Events hold kind, reason, the username only when it
is a subscriber's (never anything else a router sends — a mistyped password, a
probe), the router's source address and counts; one row per
kind/reason/username/router. No passwords, secrets, framed addresses or MACs.
FreeRADIUS's auth log line carries the reason and no password
(`auth_badpass = no`). The panel logs `Not sent to router <address>: <reason>`
without the username. Audit rows contain from/to mode, the operator (`SUDO_USER`,
else `root`), host, and for a forced enforcement the blocking count — never a
secret or a connection string.

## 4. The operator tool

`sudo bash backend/scripts/radius-tenancy.sh <action>` (as root; reads
`DATABASE_URL` from the environment or `backend/.env`; passwords travel in
the environment, never on a command line).

| Action | Does | Changes |
|---|---|---|
| `--report` | summary (below) + detail tables | nothing |
| `--status` | mode (when / by whom), installed and loaded (default + inner-tunnel), policy file current, FreeRADIUS DB account can execute the policy, other virtual servers, last 24 h of events | nothing |
| `--install [--force]` | preflight: migration present, FreeRADIUS's own DB account can execute the functions, no other enabled virtual server handles logins/accounting (`--force` to accept that they are not covered); staged copy validated as the FreeRADIUS user (`freeradius -XC`); then live; restart; confirm loaded | FreeRADIUS config (backed up) |
| `--monitor` / `--off` | set the mode, read it back, audit | one row |
| `--enforce [--force]` | requires: installed, running and loaded, DB account OK (not overridable); then the gate (below); then set, read back, audit | one row |
| `--uninstall` | removes hooks and policy (site files return byte-for-byte), validated, restart | FreeRADIUS config (backed up) |

Exit codes: 0 done · 1 usage / not root / no database / migration missing ·
2 layout or database access not as expected (nothing changed) · 3 FreeRADIUS
rejected the new configuration (live untouched) · 4 FreeRADIUS did not restart
(previous configuration restored) · 5 another FreeRADIUS update holds the lock
· 6 `--enforce` stopped (nothing changed).

**The gate.** `--enforce` stops (exit 6, listing the report) while anything in
*BLOCKS ENFORCEMENT* is non-zero. `--enforce --force` then asks for the word
`ENFORCE` (typed at a terminal; without one only
`JOINTBOX_TENANCY_CONFIRM=ENFORCE` in the environment is accepted, exactly).
Anything else: nothing changed. A forced enforcement is audited with the
blocking count.

**Reading `--report`.** The summary decides the gate:

| Line | Category | Meaning / action |
|---|---|---|
| S1 would-be refusals in 7 days (auth / acct / on-off) | **blocks** | real subscribers on real routers that enforce refuses. Read the *Recorded* table: `cross-company` → move the subscriber or share the router deliberately; `nas-ip-foreign` → the router sends another company's router address as NAS-IP-Address (fix the router's RADIUS source address, or a wrong `nasIp`); `subscriber-no-*` / `nas-no-*` → give an owner; `check-error` → investigate the database first |
| S2 online sessions whose next login would be refused | **blocks** | same fixes, before their next re-authentication |
| S3 addresses with more than one active router | **blocks** | deactivate or re-address the duplicate |
| S4 subscribers in no company, active in 30 days | **blocks** | give them an owner inside a company |
| S5 inactive subscribers in no company | fix soon | refused at their next login |
| S6 active routers with no owner / outside any company | fix soon | assign an owner |
| S7 subscribers whose assigned router refuses them | fix soon | the panel sends them no CoA / disconnect through that router; reassign |
| S8 `radcheck` usernames with no subscriber | fix soon | stale RADIUS rows; refused as `subscriber-unknown` |
| S9 online sessions behind NAT | info | the reported address matches no router; login is judged by the real source |
| S10 harmless records | info | unknown usernames, local `radtest` |
| S11 closed sessions in 30 days enforce would have refused | info | history only; still visible in logs |
| S12 / S13 cross-company shares that count / do not | info | review the listed shares |

## 5. Staging and production runbook

Run on **staging first**, with real MikroTik routers of two companies. Do not
enforce, retire remaining plaintext secrets, modify production data, or run
destructive commands without explicit approval. Production stays in
**monitor** until enforcement is authorised.

### 5.1 Discover the real layout (do not assume the sandbox's)

```bash
# install directory: /opt/jointbox by default, or the checkout install.sh ran from
pm2 describe jointbox-backend | grep -E 'exec cwd|script path'
cd <install dir>                                  # all later commands run from here
git rev-parse --short HEAD; git status --short    # the version actually deployed
# FreeRADIUS
freeradius -v | head -1                           # policy verified on 3.2.5
systemctl status freeradius --no-pager | head -5
ps -o user= -C freeradius                         # service account (Debian/Ubuntu: freerad)
ls -l /etc/freeradius/3.0/sites-enabled/ /etc/freeradius/3.0/mods-enabled/sql
grep -E '^\s*(server|port|login|radius_db)\s*=' /etc/freeradius/3.0/mods-enabled/sql   # never print the password line
grep -c '^client ' /etc/freeradius/3.0/clients.d/jointbox-nas.conf                     # router count, no secrets
grep -E '^\s*auth(_badpass|_goodpass)?\s*=' /etc/freeradius/3.0/radiusd.conf           # auth_badpass must be no
```

Note anything that differs from §3 (another enabled virtual server, a
non-default sql module name, `auth_badpass = yes`): `--install` stops on the
first two; the third would put passwords in the log and must be fixed first.

### 5.2 Preflight and backups

```bash
sudo -u postgres pg_dump -Fc -d <db> -f /var/backups/jointbox-pre-tenancy-$(date +%F).dump
tar -C /etc -czf /var/backups/freeradius-pre-tenancy-$(date +%F).tgz freeradius     # contains router secrets: keep 0600
chmod 600 /var/backups/freeradius-pre-tenancy-*.tgz
cd backend && npx prisma migrate status            # must be clean before deploying (see MIGRATIONS-FRESH-INSTALL.md §6 for P3009)
```

### 5.3 Deploy (monitor)

```bash
./update-jointbox.sh                                # migrations incl. 20261013130000; mode stays as stored (new: monitor)
cd backend && npx prisma migrate status             # "Database schema is up to date!"
psql "$DATABASE_URL" -Atc "SELECT pg_get_function_identity_arguments('public.jointbox_radius_tenancy'::regproc)"
#   → p_kind text, p_username text, p_nas_ip text, p_claimed_ip text   (4 arguments)
psql "$DATABASE_URL" -Atc "SELECT mode, updated_by FROM radius_tenancy_setting"   # → monitor
```

If a draft of this migration was ever applied on that server under the same
name, Prisma will not re-run it: the identity check above shows 3 arguments.
Re-apply the file (idempotent; keeps the stored mode) with
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/migrations/20261013130000_radius_tenancy_policy/migration.sql`.
`--install` refuses (exit 1, "migration missing") until the 4-argument
function exists, so FreeRADIUS is never pointed at a missing function.

### 5.4 Report, install, validate

```bash
sudo bash backend/scripts/radius-tenancy.sh --report    > /root/tenancy-report-$(date +%F).txt
sudo bash backend/scripts/radius-tenancy.sh --install   # monitor: nothing is refused
sudo bash backend/scripts/radius-tenancy.sh --status    # "installed and loaded (default + inner-tunnel)", "can execute the policy"
sudo -u freerad freeradius -XC | tail -1                # "Configuration appears to be OK"
grep -n jointbox_tenancy /etc/freeradius/3.0/sites-enabled/default /etc/freeradius/3.0/sites-enabled/inner-tunnel
cmp backend/scripts/radius-tenancy.policy /etc/freeradius/3.0/policy.d/jointbox-tenancy && echo policy current
```

A FreeRADIUS restart takes about a second; PPPoE sessions live on the routers
and are not dropped — only requests in that second are retried.

### 5.5 Counters and logs (no secrets)

```bash
sudo bash backend/scripts/radius-tenancy.sh --status
psql "$DATABASE_URL" -c "SELECT kind, reason, username, nas_ip, mode, count, last_at FROM radius_tenancy_event ORDER BY last_at DESC LIMIT 50"
grep 'jointbox tenancy' /var/log/freeradius/radius.log | tail -20
psql "$DATABASE_URL" -c "SELECT \"createdAt\", level, message FROM \"SystemLog\" WHERE source = 'radius-tenancy' ORDER BY id DESC LIMIT 20"
journalctl -t jointbox-radius-tenancy --since today
```

### 5.6 Tests on real MikroTik routers (staging) — NOT VERIFIED until run

Prepare: router A (company A) and router B (company B) as RADIUS clients of the
server, `/radius set [find] src-address=<the address registered as nasIp>`,
`/ppp aaa set use-radius=yes accounting=yes interim-update=1m`; a **dedicated
test subscriber** in each company (`tenancy_test_a`, `tenancy_test_b`), not a
customer.

| # | Mode | Action | Expect |
|---|---|---|---|
| 1 | monitor | PPPoE `tenancy_test_a` on router A | connects; online in the panel on router A; no event |
| 2 | monitor | `tenancy_test_b` on router A | connects; `--status` shows `auth cross-company`, router A's address |
| 3 | monitor | 1–2 with PAP, CHAP, MS-CHAPv2 (`/interface pppoe-server server set authentication=…`) | same |
| 4 | monitor | accounting of #2 (interim) | still written; event `acct cross-company` |
| 5 | monitor | panel (company A): Disconnect, then change bandwidth of `tenancy_test_a` | CoA-ACK; rate changes live |
| 6 | monitor | reboot router B (`Accounting-On`) | company A's sessions stay online |
| 7 | **enforce (authorised staging only)** | repeat #2 | refused (`/log print where topics~"ppp"`); `Login incorrect (jointbox tenancy reject:cross-company)`; nothing in the panel for that login |
| 8 | enforce | #1, #5 again | unchanged: connects; CoA works |
| 9 | enforce | assign `tenancy_test_a` to router B in the panel, Disconnect | `Not sent: this router is not one of the subscriber's company's routers`; router B receives nothing (`/radius incoming` counters unchanged) |
| 10 | enforce | if the network uses 802.1X / hotspot EAP: TTLS or PEAP with outer identity `anonymous` | same-company login succeeds; cross-company refused |
| 11 | — | `--monitor` | #2 connects again immediately, no restart |

Behind NAT: the address FreeRADIUS sees (the NAT's public address) must be the
router's `nasIp`. A router whose NAS-IP-Address is a private address that some
*other* company registered as its `nasIp` is reported as `nas-ip-foreign`
(S1): fix the registration or the router's `src-address` before enforcing.

### 5.7 Enforce — only on explicit authorisation

```bash
sudo bash backend/scripts/radius-tenancy.sh --report      # BLOCKS ENFORCEMENT all 0 → VERDICT: nothing … would be refused
sudo bash backend/scripts/radius-tenancy.sh --enforce
```

Do **not** use `--enforce --force` in production unless the remaining
blocking findings have been reviewed one by one and their refusal is intended.

### 5.8 Rollback

| Need | Command | Effect |
|---|---|---|
| Stop refusing, keep counting (instant) | `radius-tenancy.sh --monitor` | next request; no restart; audited |
| No check at all | `radius-tenancy.sh --off` | next request; no restart |
| Without the script | `psql "$DATABASE_URL" -c "UPDATE radius_tenancy_setting SET mode = 'monitor', updated_at = now(), updated_by = 'manual rollback'"` | same as `--monitor` (not audited — note it) |
| Remove the hooks | `radius-tenancy.sh --uninstall` | validated; site files return byte-for-byte; restored on failure |
| Restore files by hand | copy `site` (→ `sites-available/default`), `inner-tunnel` and `policy` (→ `policy.d/jointbox-tenancy`) from `/var/backups/jointbox-radius/tenancy/<stamp>-install/` back, `sudo -u freerad freeradius -XC`, `systemctl restart freeradius` | |

The migration needs no rollback: with the hooks absent nothing calls the
functions, and the panel's guard follows the mode.

### 5.9 If the database or FreeRADIUS is unavailable

* **Database down**: every login fails (no `radcheck`, no policy answer) —
  with or without the policy. Do not switch modes or uninstall: there is
  nothing to switch. When it is back, FreeRADIUS reconnects within its pool's
  `retry_delay` (30 s); `systemctl restart freeradius` makes that immediate.
* **FreeRADIUS's DB account cannot execute the functions** (`--status` warns):
  every request is refused in every mode. `--monitor` does not help; grant
  `EXECUTE` (or re-run the migration as the owner), or `--uninstall` to remove
  the hooks.
* **FreeRADIUS does not start after an edit**: `--install` / `--uninstall`
  restore the previous files themselves (exit 3/4); otherwise restore from
  the newest backup directory as in §5.8 and run `freeradius -XC` as the
  service user to read the error.
* **A failed migration (P3009)**: see `docs/MIGRATIONS-FRESH-INSTALL.md` §6 —
  never `migrate resolve` without the diagnosis.

## 6. Limits and pre-existing findings (not changed here)

* EAP-TLS (certificates only) carries no Jointbox password: an outer identity
  that is a subscriber is judged; certificate logins with other identities are
  not covered. Jointbox provisions PAP/CHAP/MS-CHAP; EAP-TLS is not used.
* Another enabled virtual server (`buffered-sql`, `decoupled-accounting`, …)
  is not covered; `--install` refuses unless `--force`.
* `radpostauth.pass` stores the attempted password for every login (stock
  `queries.conf` post-auth query), and the panel's auth-log page shows a
  Password column (`frontend/app/logs/page.tsx`, `LogsService.getRadiusAuthLogs`
  selects it). Retiring it is a separate, approved change.
* `backend/scripts/patch-postauth.sh` does not recognise FreeRADIUS 3.2.x's
  post-auth query (`authdate ${..class.column_name}`, `'%S.%M'`) and leaves it
  unchanged, so `radpostauth.nasipaddress` stays empty on 3.2.x.
* `radpostauth.username` is `varchar(64)`: a longer User-Name makes the stock
  post-auth insert fail (SQLSTATE 22001) and that log row is lost; the request
  is still answered.

## 7. What was verified (sandbox: FreeRADIUS 3.2.5, PostgreSQL 16)

* `test/integration/radius-tenancy.integration.spec.ts` — 65 tests on real
  PostgreSQL running the real migration: every reason, every share rule, the
  NAS-IP claim (incl. disabled and `::ffff:` forms), the EAP identity round,
  `check-error` in both modes, unreadable switch / event tables, modes,
  initial `monitor` and replay keeping an operator's choice, usernames stored
  only for subscribers, Accounting-On/Off, 200 concurrent refusals, the 3- and
  4-argument calls being one function, and a caller's temporary
  `"Subscriber"` / `nas` table not standing in for the real one. Mutation
  checks: weakening any of the claim check, the error handling, the seed, the
  `::ffff:` normalisation, the EAP rule or the username rule fails it.
* Unit: hook placement in default and inner-tunnel (`radius-tenancy-site.spec.ts`),
  the ratchets (`radius-tenancy-boundary.spec.ts`), CoA / disconnect / re-rate /
  cut-all / API fallback (`coa-tenancy.spec.ts`, `network.service.spec.ts`),
  router-API kicks (`subscribers` specs), static IP on a refused router
  (`static-ip.service.spec.ts`), the config editor
  (`radius-admin.service.spec.ts`), network- and router-log scope
  (`network-log-tenancy.spec.ts`), company session sync
  (`integrity-session-tenancy.spec.ts`). Each fails against the code before
  its fix.
* Real FreeRADIUS, 92 checks: PAP, CHAP, MS-CHAPv2 both ways; EAP-TTLS, PEAP
  (outer identity `anonymous` and outer identity spoofed as a subscriber of
  the router's own company) and EAP-MD5 via `eapol_test`; NAS-IP-Address
  spoofing for auth (and the post-auth row naming the real router) and
  accounting; hostile usernames (quotes, backslash, `%{…}`, `${…}`, 253
  characters, SQL fragments); every refusal reason; eight share cases;
  accounting and Accounting-On across companies; panel CoA / disconnect /
  re-rate across companies (no packet reaches the other company's router);
  every mode transition without restart, audited in order; the gate,
  `--force` without / with a wrong / with the right confirmation; `--enforce`
  refused while not installed; `--install` refused with another virtual
  server; a policy FreeRADIUS rejects leaving the live config untouched;
  `--uninstall` restoring both site files byte-for-byte; a query failure,
  a missing function and a database outage all failing closed; no password
  or secret in the FreeRADIUS log, events, audit rows or backups. Cost:
  median / p95 Access-Request round trip 1.06 / 1.97 ms with the check off,
  1.59 / 3.12 ms enforced (300 requests each, same host).

**NOT VERIFIED:** real MikroTik routers (§5.6), FreeRADIUS versions other than
3.2.5, the production server's actual layout and data (§5.1), EAP-TLS.
