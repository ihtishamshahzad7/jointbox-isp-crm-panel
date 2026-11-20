# Uplinko NAS Management VPN — Controlled Real-Hardware Test Plan

**For ONE dedicated test MikroTik with no customers, and ONE test Uplinko server. This is not a production rollout plan.**

Status of everything that depends on real hardware: **NOT VERIFIED** until you run the step and supply the actual output. I (Claude) did not connect to any router, change source code, commit, push or deploy while preparing this plan.

> **Correction to the brief.** The "READY FOR CONTROLLED REAL-HARDWARE TESTING" outcome comes from **my own** Phase 1.2 remediation report. No independent verification of Phase 1.2 has been done yet. Treat this plan as the first independent evidence.

---

## 0. Code state this plan is written against

| Item | Value (checked from the source) |
|---|---|
| HEAD | `af61caa` (`main`) |
| VPN code | **Uncommitted** working-tree changes in `F:\Jointbox panel` (Phase 1 + 1.1 + 1.2) |
| Source hashes (SHA-256 prefix) | `routeros-mgmt-applier.ts` f502ef05…, `nas-l2tp-client.service.ts` 27e3e1be…, `l2tp-client-dialer.service.ts` 4c353feb…, `nas-l2tp-client.controller.ts` b66fbb56… |
| Migration | `backend/prisma/migrations/20261121090000_nas_l2tp_client/` (adds columns only) |

**Important:**
- `update-jointbox.sh` runs `git reset --hard origin/main`, which **does not contain** this code and would discard it.
- So on the test server, copy the working tree by hand (see §2.2). **Never** run `update-jointbox.sh` on the test server during these tests.
- Do not put this code on any server that has customers.

---

## 1. Test environment

### 1.1 Topology (fill in before starting)

| Role | Value | Notes |
|---|---|---|
| Test Uplinko server (Ubuntu 22.04/24.04) | `UPL_HOST` = __________ | Dedicated or snapshot-able VM. Not the production panel. |
| Its public egress IPv4 as the router sees it | `UPLINKO_PUBLIC_IP` = __________ | Check with `curl -s https://ifconfig.me` from the server. |
| Test MikroTik NAS A, public IPv4 (dialed) | `NAS_A_PUB` = __________ | **No customers**, not in production. |
| NAS A RouterOS management IP (API, port 8728) | `NAS_A_MGMT` = __________ | Used for apply and rollback. |
| Optional second test NAS B | `NAS_B_PUB` = __________ | For the isolation test (T11). A CHR VM is fine. |
| Tunnel pool | `10.255.0.0/16` (default `L2TP_MGMT_POOL`) | NAS A uses `10.255.7.1` (NAS) / `10.255.7.2` (Uplinko); NAS B uses `10.255.8.1` / `10.255.8.2` |
| Third host for negative tests | `ROGUE_HOST` = __________ | Any Linux box, **not** the Uplinko server |

**If the lab uses private (RFC 1918) endpoint addresses:**
- Set `L2TP_ALLOW_PRIVATE_ENDPOINTS=true` on the test server only.
- Even then, the endpoint must not be the server's own address or its gateway, and documentation ranges (203.0.113.0/24 etc.) are always rejected.

### 1.2 Environment variables (test server `backend/.env`)

```
UPLINKO_PUBLIC_IP=<UPLINKO_PUBLIC_IP>        # required for apply (firewall guard source address)
L2TP_MGMT_POOL=10.255.0.0/16                 # default; must be RFC 1918 and must not overlap host networks
L2TP_PROTECTED_CIDRS=                        # optional, comma-separated (e.g. licence server IP)
L2TP_ALLOW_PRIVATE_ENDPOINTS=false           # true only for an all-private lab
L2TP_SWANCTL_CONF_DIR=/etc/swanctl/conf.d    # default
L2TP_CLIENT_DIR=/etc/uplinko/l2tp            # default (pppd options, logs, host locks)
XL2TPD_CONTROL_SOCKET=/var/run/xl2tpd/l2tp-control   # default
```

### 1.3 API endpoints (all JWT-authenticated; caller must own the NAS; permission `nas.read` / `nas.write`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/nas/:id/l2tp-client` | Settings view (secrets shown only as `hasIpsecPsk` / `hasPppPassword`) |
| PUT | `/nas/:id/l2tp-client` | Save settings |
| GET | `/nas/:id/l2tp-client/status` | Live host status (ESP-verified) and current operation |
| POST | `/nas/:id/l2tp-client/nas/preview` | Read-only plan of router changes |
| POST | `/nas/:id/l2tp-client/nas/apply` | Configure the router. Body `{"confirmServerChange":true}` only when the preview requires it. |
| POST | `/nas/:id/l2tp-client/nas/rollback` | Restore the router to its pre-Uplinko settings |
| POST | `/nas/:id/l2tp-client/nas/recover` | Read-only classification after an interrupted apply |
| POST | `/nas/:id/l2tp-client/connect` | Start a background dial; returns `operationId` |
| POST | `/nas/:id/l2tp-client/reconnect` | Background hang-up, then dial |
| POST | `/nas/:id/l2tp-client/cancel` | Ask the running operation to stop |
| POST | `/nas/:id/l2tp-client/disconnect` | Hang up (or ask a running connect to stop) |
| DELETE | `/nas/:id/l2tp-client/host` | Remove this NAS's tunnel and files from the server |

**Shell helper used below.** It runs on the test server; the port comes from `backend/.env`. Log in as the account that **owns** the test NAS. The values are kept out of your shell history.

```bash
cd /opt/jointbox/backend
export API="http://127.0.0.1:$(grep ^PORT= .env | cut -d= -f2)"
read -rp 'Owner email: ' EMAIL; read -rsp 'Password: ' PW; echo
export TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("access_token") or d.get("token") or "")')
unset PW; [ -n "$TOKEN" ] && echo "token OK" || echo "LOGIN FAILED"
api() { curl -s -X "$1" "$API$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${3:+-d "$3"}; echo; }
export NAS_A=<id of test NAS A in Uplinko>
```

> If the login response field is named differently, adjust the `python3` line. Evidence files must never contain the token.

### 1.4 RouterOS permissions (test NAS)

Uplinko's API user **must** be in a group whose policy includes **`api,read,write,sensitive`**. Without `sensitive`, apply is refused by design.

```routeros
/user group add name=uplinko-test policy=api,read,write,sensitive
/user add name=uplinko-api group=uplinko-test password=<strong test password>
/ip service print where name=api      # api (8728) enabled; restrict "address" to UPL_HOST
```

In Uplinko, set the test NAS's RouterOS API username/password to this user and `nasIp` to `NAS_A_MGMT`.

### 1.5 Linux packages and commands used by the backend (test server, as root)

```bash
apt-get update && apt-get install -y strongswan-swanctl charon-systemd xl2tpd ppp iproute2
systemctl enable --now strongswan xl2tpd   # unit names differ by release; check: systemctl list-units | grep -E 'strongswan|charon|xl2tpd'
grep -n 'conf.d' /etc/swanctl/swanctl.conf          # must include conf.d/*.conf
test -S /var/run/xl2tpd/l2tp-control && echo "xl2tpd control socket OK"
which swanctl xl2tpd-control pppd ip
ps -o user= -p $(pgrep -f 'jointbox-backend' | head -1)   # the backend must run as root (current installs do)
```

Commands the backend runs itself (argv only, no shell):
- `swanctl --load-all --noprompt`
- `swanctl --initiate --child uplinko-nas-<id> --timeout N`
- `swanctl --list-sas --ike uplinko-nas-<id>`
- `swanctl --terminate --ike uplinko-nas-<id>`
- `xl2tpd-control -c <socket> add-lac|connect-lac|disconnect-lac|remove-lac uplinko-nas-<id> …`
- `ip -o link|addr show dev ulnas<id>`
- `ip -4 route get <peer>`
- `ip -4 route show default`
- `ip -j -4 addr show`
- `ip -j -4 route show table main`
- `ip xfrm state list dst <NAS public IP> proto esp`

Files the backend writes:
- `/etc/swanctl/conf.d/uplinko-nas-<id>.conf` (0600)
- `/etc/uplinko/l2tp/uplinko-nas-<id>.ppp` (0600)
- `/etc/uplinko/l2tp/uplinko-nas-<id>.log`
- `/etc/uplinko/l2tp/locks/nas-<id>/owner.json`

### 1.6 Every RouterOS change Uplinko makes (from `routeros-mgmt-applier.ts`)

Mutations happen in this order, and **only after** all of the following pass:
- the sensitive-policy check;
- the L2TP-client inventory is empty and readable;
- the IPsec secret is readable;
- the firewall is readable;
- there is no foreign PPP secret with the same name;
- the snapshot and intended result have been saved.

| # | Change | When |
|---|---|---|
| 1 | `/ip firewall filter remove` of stale `uplinko-mgmt-vpn guard nas=<id> …` rules | only if they exist and do not match |
| 2 | `/ip firewall filter add` × 4, `place-before=<first rule>`, comment `uplinko-mgmt-vpn guard nas=<id> rule=<k>` (rule specs below) | if the guard is not already in place |
| 3 | `/interface l2tp-server server set use-ipsec=required ipsec-secret=<PSK>` | if either differs |
| 4 | `/interface l2tp-server server set authentication=<existing>+mschap2` | if mschap2 is missing |
| 5 | `/ppp secret add` (or `set` on the Uplinko-marked one): `name=uplinko-mgmt password=… service=l2tp profile=… local-address=<NAS tunnel IP> remote-address=<Uplinko tunnel IP> comment=uplinko-mgmt-vpn` | always |
| 6 | `/interface l2tp-server server set enabled=yes` | if it was disabled |

Guard rules:
- rule 1: `chain=input protocol=udp dst-port=500,4500 src-address=<UPLINKO_PUBLIC_IP> action=accept`
- rule 2: `chain=input protocol=ipsec-esp src-address=<UPLINKO_PUBLIC_IP> action=accept`
- rule 3: `chain=input protocol=udp dst-port=1701 src-address=<UPLINKO_PUBLIC_IP> ipsec-policy=in,ipsec action=accept`
- rule 4: `chain=input protocol=udp dst-port=1701 connection-state=new action=drop`

Rollback undoes 6 → 1. Nothing else on the router is ever written: no PPPoE, no RADIUS, no customer secrets, no L2TP-client interfaces.

---

## 2. Pre-test preparation

### 2.1 Confirm the router has no customers or production dependencies (all must pass; save the output as `E0-*.txt`)

```routeros
/ppp active print count-only                       # expect 0
/ppp secret print count-only                       # note the number; must be test accounts only
/interface pppoe-server server print               # expect none, or disabled
/radius print                                      # expect none pointing at production FreeRADIUS
/ppp aaa print                                     # use-radius=no expected on a test router
/interface l2tp-client print                       # note: any entry makes apply refuse (tested in T6)
/interface l2tp-server server print                # note current values (secret shown only to sensitive users)
/ip ipsec peer print ; /ip ipsec active-peers print
/ip firewall filter print
/ip address print ; /ip route print where dst-address=0.0.0.0/0
/system routerboard print ; /system resource print # model and RouterOS version
```

**Stop the test** if `/ppp active` shows any session, or `/radius` points at production. Recovery: none needed; nothing has been changed yet.

On the Uplinko test server:

```bash
ip -4 route show default | tee E0-default-route.before
ip -j -4 addr show > E0-ip-addr.json ; ip -j -4 route show table main > E0-ip-route.json
swanctl --list-sas | tee E0-sas.before ; ip xfrm state | tee E0-xfrm.before
pm2 ls | tee E0-pm2.txt
```

### 2.2 Install the code on the TEST server only

1. Snapshot the VM.
2. Copy the working tree from `F:\Jointbox panel` to the test server (for example `git diff` + untracked files, or rsync).
3. Check it:
   ```bash
   cd /opt/jointbox/backend
   sha256sum src/nas/routeros-mgmt-applier.ts src/nas/nas-l2tp-client.service.ts src/nas/l2tp-client-dialer.service.ts | cut -c1-12   # must match §0
   npm run db:deploy          # applies 20261121090000_nas_l2tp_client to the TEST database only
   npm run build && node scripts/check-di.js && pm2 restart jointbox-backend --update-env
   ```
4. **Failure indicators:** a hash mismatch, a migration error, or `check-di` failing. Recovery: restore the VM snapshot.

### 2.3 Router configuration backup (mandatory) and verified recovery

```routeros
/system backup save name=pre-uplinko-test dont-encrypt=no password=<backup pw>
/export show-sensitive file=pre-uplinko-test       # plain-text export, used for diffs
/file print where name~"pre-uplinko-test"
```

- Download both files off the router (`scp` or Winbox → Files) and record their SHA-256. **Evidence:** `E0-backup.sha256`.
- **Verify you can restore before testing:** confirm Winbox or SSH access over the router's normal management path, independent of Uplinko. Guard rule 4 only affects UDP 1701, so management access (Winbox 8291, SSH 22, API 8728) is not touched by design. **NOT VERIFIED until you confirm.**
- **Recovery order, from least to most drastic:**
  1. `POST …/nas/rollback`
  2. Manual removal (§9)
  3. `/system backup load name=pre-uplinko-test` (reboots)
  4. Netinstall plus the export file

---

## 3. Test cases

Record for each test:
- the command and full output (redact tokens and passwords);
- a timestamp;
- PASS / FAIL.

Save evidence as `E<test>-<step>.txt`. Every result below is **NOT VERIFIED** until you supply the output.

### T1 — Save settings and preview (read-only on the router)

```bash
api PUT /nas/$NAS_A/l2tp-client '{"publicHost":"<NAS_A_PUB>","pppUsername":"uplinko-mgmt","pppPassword":"<8-128 printable, no quotes/spaces>","ipsecPsk":"<8-128 printable>","localAddress":"10.255.7.2","remoteAddress":"10.255.7.1"}'
api POST /nas/$NAS_A/l2tp-client/nas/preview
```

**Expected:**
- PUT returns `hasIpsecPsk:true`, `hasPppPassword:true`, `tunnelUsedForRouterAccess:false`, and **no secret values**.
- Preview returns `executed:false` and a `changes` list matching §1.6. `requiresConfirmation:false` on a disabled L2TP server.
- `/system history print` on the router shows **no new entries**.

**Failure indicators:**
- Any secret value appears in a response.
- An address-policy error for valid addresses (check `UPLINKO_PUBLIC_IP`, the pool, private-endpoint settings).
- `sensitive_policy_missing` or `secret_unreadable` (fix the router group from §1.4).
- `l2tp_clients_present`.

**Evidence:** `E1-put.json`, `E1-preview.json`, `E1-history.txt`.

**Recovery:** none needed (no router change).

### T2 — Apply and router configuration comparison

```bash
api POST /nas/$NAS_A/l2tp-client/nas/apply
```

```routeros
/export show-sensitive file=after-apply
/ip firewall filter print detail where comment~"uplinko-mgmt-vpn"
/ip firewall filter print                      # ordering
/interface l2tp-server server print
/ppp secret print detail where comment=uplinko-mgmt-vpn
```

**Expected:**
- `{"applied":true,"confirmedByNas":true}`.
- The 4 guard rules are the **first** rules in `input`, in order 1–4. Rule 4 shows `connection-state=new`. Admin rules follow in their original order.
- Server: `enabled=yes`, `use-ipsec=required`, authentication includes `mschap2` (other methods kept).
- Exactly one Uplinko secret: `service=l2tp`, `local-address=10.255.7.1`, `remote-address=10.255.7.2`.
- `diff pre-uplinko-test.rsc after-apply.rsc` shows **only** these changes.
- `GET …/l2tp-client` → `nasApplyState:"applied"`.

**Failure indicators:**
- Any other difference in the diff.
- Guard rules not at the top (dynamic rules can block `place-before`; apply should then report `verify_failed`, restored).
- A response of `apply_failed_*`.

**Evidence:** `E2-apply.json`, `E2-diff.txt`, `E2-filter.txt`, `E2-server.txt`, `E2-secret.txt`.

**Recovery:** if anything is unexpected, run `POST …/nas/rollback` (T9). If rollback is refused, follow §9.

### T3 — Connect, IPsec negotiation and actual ESP encryption

```bash
api POST /nas/$NAS_A/l2tp-client/connect           # note operationId
for i in $(seq 1 20); do api GET /nas/$NAS_A/l2tp-client/status; sleep 3; done | tee E3-status.log
swanctl --list-sas --ike uplinko-nas-$NAS_A | tee E3-sas.txt
ip xfrm state list dst <NAS_A_PUB> proto esp | tee E3-xfrm.txt
ip -o addr show dev ulnas$NAS_A ; ip -4 route get 10.255.7.1
diff <(ip -4 route show default) E0-default-route.before && echo "default route unchanged"
tcpdump -ni any -c 20 "host <NAS_A_PUB> and (udp port 1701)"      # should capture NOTHING in plain text
tcpdump -ni any -c 20 "host <NAS_A_PUB> and (esp or udp port 4500)" # should show ESP / ESP-in-UDP
```

```routeros
/ip ipsec active-peers print ; /ip ipsec installed-sa print ; /ppp active print
```

**Expected:**
- `connect` returns immediately with `accepted:true` and an `operationId`.
- Status reaches `state:"connected"` with `interface:"ulnas<id>"`, `localAddress 10.255.7.2`, `remoteAddress 10.255.7.1`, and a detail like `ESP AES_CBC-256 transport SA to <NAS_A_PUB> installed…`.
- `swanctl` shows IKE `ESTABLISHED` plus a CHILD_SA `INSTALLED, TRANSPORT[-in-UDP], ESP:…`.
- `xfrm` shows `proto esp … mode transport`.
- The default route is unchanged.
- **No** plaintext UDP 1701 on the wire.
- The router lists `uplinko-mgmt` in `/ppp active` (service l2tp).

**Failure indicators and what to check:**

| Error | Check |
|---|---|
| `encryption_unverified` | Compare the real `swanctl --list-sas` layout with the parser (`parseSwanctlSas`); this is the key format check. **Save E3-sas.txt in every case.** |
| `ipsec_proposal_mismatch` | Router proposal vs the offered `aes256/aes128/3des-sha1-modp2048/1024` |
| `nas_unreachable` | UDP 500/4500 path, the NAS public IP |
| `timeout` | xl2tpd/pppd: `/etc/uplinko/l2tp/uplinko-nas-<id>.log`, `journalctl -u xl2tpd` |
| `route_violation`, or a changed default route | Treat as a **serious** failure: disconnect at once |

Any plaintext 1701 capture is also a **serious** failure: disconnect at once.

**Evidence:** `E3-*`, `/etc/uplinko/l2tp/uplinko-nas-<id>.log`, and router `/log print where topics~"ipsec|l2tp|ppp"`.

**Recovery:** `api POST /nas/$NAS_A/l2tp-client/disconnect`. If stuck, run `swanctl --terminate --ike uplinko-nas-<id>` and `xl2tpd-control -c /var/run/xl2tpd/l2tp-control disconnect-lac uplinko-nas-<id>`.

### T4 — PPP authentication (positive and negative)

1. Positive: covered by T3 (`/ppp active` entry, router log `uplinko-mgmt logged in`).
2. Negative, wrong PPP password:
   ```bash
   api POST /nas/$NAS_A/l2tp-client/disconnect
   api PUT /nas/$NAS_A/l2tp-client '{"pppPassword":"<different value>"}'   # NOT applied to the router
   api POST /nas/$NAS_A/l2tp-client/connect ; sleep 40 ; api GET /nas/$NAS_A/l2tp-client/status
   ```
   **Expected:** `state:"error"`, `errorCode:"ppp_auth_failed"`, attempts 1 (no retry), no `ulnas<id>` interface left, and router log `authentication failed`.
3. Negative, wrong PSK: same steps with `ipsecPsk`. **Expected:** `ipsec_auth_failed`, no SA left (`swanctl --list-sas` empty for this connection).
4. Restore the correct password and PSK (PUT), then connect again; it should reach `connected`.

**Failure indicators:** "connected" with wrong credentials, a different error code, or leftover SA/interface.

**Evidence:** `E4-*.json`, router log.

**Recovery:** disconnect, then PUT the correct values.

### T5 — Firewall ordering, `connection-state=new` and `ipsec-policy` matching

Keep the tunnel connected (T3). On the router:

```routeros
/ip firewall filter print stats where comment~"uplinko-mgmt-vpn"     # packet counters per rule
```

1. **Rule 3 (`ipsec-policy=in,ipsec`) matches Uplinko's L2TP:** with the tunnel up, run `ping -c 20 10.255.7.1` from Uplinko. The rule 3 counters should increase, and rule 4 should **not** increase from Uplinko's traffic.
2. **Rule 4 drops new unauthorised 1701:** from `ROGUE_HOST`, run `nc -u -w2 <NAS_A_PUB> 1701 </dev/urandom` (a few packets). Rule 4 counters should increase, there should be no new entry in `/ppp active`, and `/ip firewall connection print where dst-address~":1701"` should show nothing established for ROGUE_HOST.
3. **Rule 4 does not drop established/related traffic (`connection-state=new` behaviour):**
   - This requires a router that is itself an L2TP client. Apply **refuses** on such routers (T6), so test it on the test router **after** apply: temporarily add an outbound client to a lab L2TP server:
     ```routeros
     /interface l2tp-client add name=lab-out connect-to=<lab L2TP server> user=… password=… disabled=no
     ```
   - **Expected:** `lab-out` reaches `running=yes` and stays up 5 minutes, and its replies (dst-port 1701) are not counted on rule 4.
   - Remove it afterwards with `/interface l2tp-client remove [find name=lab-out]` **before** any further apply or rollback (they will refuse while it exists).
4. **Unrelated IPsec:** if a lab site-to-site IPsec peer exists, confirm `/ip ipsec active-peers` stays established throughout.

**Failure indicators:**
- Rule 3 counters not increasing while connected (ipsec-policy not matching), which means the tunnel actually relies on rule 4 not matching.
- `lab-out` drops.
- ROGUE_HOST obtains a PPP session.

**Evidence:** `E5-stats-before.txt`, `E5-stats-after.txt`, `E5-rogue.txt`, `E5-labout.txt`.

**Recovery:** remove `lab-out`, then roll back if needed.

### T6 — Existing L2TP-client detection

Start from rolled back (T9) or before T2:

```routeros
/interface l2tp-client add name=t6-client connect-to=192.0.2.1 user=x password=x disabled=yes
```

```bash
api POST /nas/$NAS_A/l2tp-client/nas/preview
api POST /nas/$NAS_A/l2tp-client/nas/apply '{"confirmServerChange":true}'
```

**Expected:**
- Both return 400/409 with `l2tp_clients_present` and name `t6-client (disabled)`.
- `/system history print` shows **no** change by Uplinko.
- Repeat with `disabled=no` (client enabled, not running): same refusal.
- Then remove `t6-client`; preview proceeds.

**Optional unreadable case:** give the API user a group **without** `read` on interfaces. Apply should refuse with `l2tp_clients_unreadable` or `sensitive_policy_missing`.

**Failure indicators:** apply proceeds, or `t6-client` is modified in any way.

**Evidence:** `E6-*.json`, `E6-history.txt`.

**Recovery:** `/interface l2tp-client remove [find name=t6-client]`.

### T7 — Unauthorised L2TP rejection (`service=any` customer)

```routeros
/ppp secret add name=t7-cust password=t7-pass-123 service=any comment=t7-test
```

From `ROGUE_HOST`, try to connect a Linux L2TP/IPsec client (strongSwan + xl2tpd) to `NAS_A_PUB`, with user `t7-cust`. Try once **without** a PSK and once **with** the real PSK.

**Expected:**
- Both fail: no `/ppp active` entry for t7-cust.
- Rule 4 and/or IPsec negotiation counters increase.
- The router log shows no successful login.

**Failure indicators:** any successful t7-cust session.

**Evidence:** `E7-*`.

**Recovery:** `/ppp secret remove [find comment=t7-test]`.

### T8 — Disconnect, reconnect and cancellation

```bash
api POST /nas/$NAS_A/l2tp-client/disconnect ; api GET /nas/$NAS_A/l2tp-client/status
api POST /nas/$NAS_A/l2tp-client/reconnect  ; sleep 30 ; api GET /nas/$NAS_A/l2tp-client/status
api POST /nas/$NAS_A/l2tp-client/connect    ; sleep 2 ; api POST /nas/$NAS_A/l2tp-client/cancel ; sleep 15 ; api GET /nas/$NAS_A/l2tp-client/status
api POST /nas/$NAS_A/l2tp-client/connect    ; api POST /nas/$NAS_A/l2tp-client/connect   # second must be 409
```

**Expected:**
- **Disconnect:** `disconnected`; no SA, interface or LAC remain (`swanctl --list-sas`, `ip link show ulnas<id>`, `xl2tpd-control … status-lac`).
- **Reconnect:** `connected` again.
- **Cancel:** final state `disconnected` with `errorCode:"cancelled"`, and nothing left behind.
- **Double connect:** the second returns 409.

**Failure indicators:** a leftover `ulnas<id>`, an SA, a 200 on the second connect, or status stuck in `connecting` after the operation ends.

**Evidence:** `E8-*`.

**Recovery:** disconnect; `DELETE /nas/$NAS_A/l2tp-client/host` removes the host files (verified).

### T9 — Rollback and configuration comparison

```bash
api POST /nas/$NAS_A/l2tp-client/disconnect
api POST /nas/$NAS_A/l2tp-client/nas/rollback
```

```routeros
/export show-sensitive file=after-rollback
```

```bash
diff pre-uplinko-test.rsc after-rollback.rsc
```

**Expected:**
- `{"rolledBack":true,"confirmedByNas":true}`.
- The diff shows **no** difference, apart from export header and timestamp lines. The L2TP server values (including `ipsec-secret`) equal the originals, there are no `uplinko-mgmt-vpn` rules or secret, and admin rules are in their original order.

**Stale-change check:**
1. Apply again.
2. On the router, change `/interface l2tp-server server set authentication=chap`.
3. Run rollback again. **Expected:** 409, "Changed on the NAS since Uplinko applied it", and **no** router change. Then restore authentication by hand and roll back again; it should succeed.

**Failure indicators:** any remaining diff, or a rollback that claims success while the diff shows differences.

**Evidence:** `E9-rollback.json`, `E9-diff.txt`, `E9-stale.json`.

**Recovery:** §9 manual removal; `/system backup load name=pre-uplinko-test` as the last resort.

### T10 — Worker restart and recovery

1. **Restart during connect:**
   ```bash
   api POST /nas/$NAS_A/l2tp-client/connect
   pm2 restart jointbox-backend
   sleep 60; api GET /nas/$NAS_A/l2tp-client/status
   api GET /nas/$NAS_A/l2tp-client
   ```
   **Expected:**
   - After about 45 s (lease expiry) the view shows `operation:null`.
   - Status reflects the **live** host state: `connected` if pppd finished, otherwise `disconnected` or `error`. It is never a stale "connecting" forever.
   - A new `connect` is accepted, or returns 409 with "still working on this NAS" while an orphaned process still holds the host lock.
   - `ls /etc/uplinko/l2tp/locks/` shows no lock owned by a dead pid after the next operation.
2. **Interrupted apply:**
   1. Roll back first.
   2. Start `api POST …/nas/apply` and, while it runs (between the "last step" messages in `GET …/l2tp-client`), run `pm2 restart jointbox-backend` **or** block API access from the server (`iptables -I OUTPUT -d <NAS_A_MGMT> -p tcp --dport 8728 -j DROP`, removed afterwards).
   3. Wait 60 s, then call `GET …/l2tp-client`. **Expected:** `nasApplyState:"recovery_required"`.
   4. Call `apply` again. **Expected:** 409, "Run recovery…", no router change (`/system history`).
   5. Call `POST …/nas/recover`. **Expected:** `routerState` is one of `at_snapshot`, `at_desired` or `mixed`. If `mixed`, call `rollback`; the router diff then equals the pre-test export.

**Failure indicators:**
- A stale operation shown as current.
- Apply proceeds without recovery.
- Recovery changes the router (it must be read-only).
- Rollback claims success while the diff differs.

**Evidence:** `E10-*`, `pm2 logs jointbox-backend --lines 200 --nostream`.

**Recovery:** remove the iptables rule; `rollback`; §9.

### T11 — Second NAS isolation (needs NAS B)

1. Configure NAS B with `10.255.8.1/10.255.8.2` and its own PSK and PPP password. Apply on NAS B, then connect both NAS A and NAS B.
2. Check both:
   ```bash
   swanctl --list-sas | grep -E 'uplinko-nas-(A|B)'
   ip -o addr show dev ulnas$NAS_A ; ip -o addr show dev ulnas$NAS_B
   cat /etc/swanctl/conf.d/uplinko-nas-$NAS_A.conf | grep id-1
   cat /etc/swanctl/conf.d/uplinko-nas-$NAS_B.conf | grep id-1   # each bound to its own NAS IP
   ```
3. Disconnect NAS A. NAS B must stay `connected` (status plus `ping 10.255.8.1`).
4. Run wrong-PSK on NAS A (T4.3). NAS B must be unaffected.
5. Run `DELETE /nas/$NAS_A/l2tp-client/host`. Only `*-nas-$NAS_A*` files are removed, and `ulnas$NAS_B` stays up.
6. Address conflict: PUT NAS B with `remoteAddress` `10.255.7.1` (NAS A's). **Expected:** 400 "already used by another NAS tunnel".

**Failure indicators:** any effect on NAS B from NAS A actions, a shared PSK identity, or an accepted address conflict.

**Evidence:** `E11-*`.

**Recovery:** disconnect both; roll back on both routers.

---

## 4. Known hardware-dependent assumptions to watch (all NOT VERIFIED)

1. The real `swanctl --list-sas` and `ip xfrm` output formats match the parser (T3). If not, the result is `encryption_unverified` (fails closed). Send E3-sas.txt and E3-xfrm.txt so the parser can be adjusted.
2. RouterOS API field names: `use-ipsec`, `ipsec-secret`, `authentication`, `connection-state`, `ipsec-policy`; the `place-before` id; the `=ret=` id; `/interface/l2tp-client/print` fields (`name`, `running`, `disabled`).
3. Rule 4 `connection-state=new` lets replies to the router's own L2TP clients through (T5.3), and rule 3 `ipsec-policy=in,ipsec` matches decrypted L2TP (T5.1).
4. `service=any` accounts cannot log in over the guarded server (T7).
5. A NAS behind 1:1 NAT is expected **not** to work (remote identity is pinned to the public IP). Do not use a NATed NAS for this test round, or record the expected failure.

## 5. Abort criteria (stop, disconnect, roll back)

Abort if any of these happens:
- the default route changes;
- plaintext UDP 1701 appears on the wire;
- any non-Uplinko secret or rule is modified;
- an existing `/ppp active` session is affected;
- a rollback reports success but the diff differs;
- any secret value appears in an API response or log.

## 6. Evidence to return

Return all `E*` files, the router exports (pre, after-apply, after-rollback), `/etc/uplinko/l2tp/*.log`, `pm2 logs`, and the PASS/FAIL table. Redact passwords, PSKs and tokens before sharing.

## 7. Results table (fill in)

| Test | Result (PASS/FAIL/NOT RUN) | Evidence files | Notes |
|---|---|---|---|
| T1 save + preview | NOT VERIFIED | | |
| T2 apply + diff | NOT VERIFIED | | |
| T3 IPsec + ESP proof | NOT VERIFIED | | |
| T4 PPP auth (+/−) | NOT VERIFIED | | |
| T5 firewall order / conn-state / ipsec-policy | NOT VERIFIED | | |
| T6 L2TP-client detection | NOT VERIFIED | | |
| T7 unauthorised `service=any` | NOT VERIFIED | | |
| T8 disconnect / reconnect / cancel | NOT VERIFIED | | |
| T9 rollback + diff + stale check | NOT VERIFIED | | |
| T10 restart / recovery | NOT VERIFIED | | |
| T11 second NAS isolation | NOT VERIFIED | | |

## 8. Out of scope

Production rollout, the frontend, customer routers, and router access over the tunnel (not implemented: `tunnelUsedForRouterAccess:false`).

## 9. Manual removal on the router (if rollback is refused or fails)

Use this only on the test router, and compare with `pre-uplinko-test.rsc` afterwards.

```routeros
/interface l2tp-server server set enabled=<original> use-ipsec=<original> ipsec-secret=<original> authentication=<original>
/ppp secret remove [find comment=uplinko-mgmt-vpn]
/ip firewall filter remove [find comment~"^uplinko-mgmt-vpn guard nas="]
```

Then compare with `/export show-sensitive`. If the result still differs, run `/system backup load name=pre-uplinko-test`.

On the Uplinko test server:

```bash
swanctl --terminate --ike uplinko-nas-<id>
xl2tpd-control -c /var/run/xl2tpd/l2tp-control disconnect-lac uplinko-nas-<id>
xl2tpd-control -c /var/run/xl2tpd/l2tp-control remove-lac uplinko-nas-<id>
rm -f /etc/swanctl/conf.d/uplinko-nas-<id>.conf /etc/uplinko/l2tp/uplinko-nas-<id>.*
swanctl --load-all
rm -rf /etc/uplinko/l2tp/locks/nas-<id>     # only when no backend operation is running for this NAS
```
