# RADIUS router vault — design, operations and production runbook

How Jointbox gives FreeRADIUS the routers (NAS) and their shared secrets, how
to switch an existing server over safely, how to prove it works, and how to
roll it back. Every path and account below is the one the code and installers
use on Ubuntu/Debian with the distribution FreeRADIUS 3.x package.

| Thing | Where |
|---|---|
| Panel | `/opt/jointbox` (backend in `/opt/jointbox/backend`, run by pm2 as root) |
| Encryption key | `SECRETS_KEY` in `/opt/jointbox/backend/.env` (0600 root). Falls back to `JWT_SECRET` when `SECRETS_KEY` is absent. |
| FreeRADIUS config | `/etc/freeradius/3.0` (auto-detected; also `/etc/freeradius`, `/etc/raddb`) |
| FreeRADIUS service | `freeradius.service`, runs as `freerad:freerad` (`user =` in `radiusd.conf`), `ExecStartPre=freeradius -Cx` |
| Router file | `/etc/freeradius/3.0/clients.d/jointbox-nas.conf`, **0640 root:freerad**, directory 0750 root:freerad |
| Include line | `$INCLUDE clients.d/jointbox-nas.conf` in `clients.conf` — by exact name |
| Sync state | `/var/lib/jointbox/radius-vault.json` (0600; times, counts, router ids, messages — no secrets) |
| Host lock | `/run/lock/jointbox-radius.lock` (shared by every backend worker and the cutover script) |
| Cutover backups | `/var/backups/jointbox-radius/<stamp>/` (0700; `MODE` = `sql` or `file`), newest 30 kept |
| Admin-screen backups | `/var/backups/jointbox-radius/admin/<stamp>/` |
| FreeRADIUS log | `/var/log/freeradius/radius.log` (`auth = yes` is set by `setup-freeradius.sh`) |

## 1. Why panel-created routers timed out

Verified against the code at commit `ca05d44` and reproduced on FreeRADIUS 3.2.5:

1. **The plaintext column was emptied while FreeRADIUS still read it.**
   `nas.service` stored every panel-created router with `secret = NULL`
   (encrypted copy only), and `migrateLegacySecrets()` cleared the plaintext of
   every existing router at start-up. On a server whose FreeRADIUS loads
   clients from SQL (`read_clients = yes`), FreeRADIUS still adds that router —
   with an **empty secret** — and then drops every request from it:
   `Dropping packet without response because of error: Received packet from
   <router> with invalid Message-Authenticator! (Shared secret is incorrect.)`.
   The MikroTik sees no reply: "RADIUS timeout". A router inserted by hand
   after start-up kept its plaintext, which is why manual routers worked.
2. **The installers' include line stops FreeRADIUS.** `$INCLUDE clients.d/*.conf`
   is read as a literal file name by FreeRADIUS 3.x ("Unable to open file"),
   so the next restart fails and every login on the server times out.
3. **The generated file was unreadable by the service** (written root:root
   0640; FreeRADIUS runs as `freerad`).
4. **The secret and router name were written in double quotes**, which
   FreeRADIUS expands (`%{…}`, `${…}`), and a router name could carry a newline
   into the file. A secret containing `%` or `$` silently became a different
   secret; a crafted name could add configuration.
5. **The service that wrote the file was never injected** into `NasService`
   (`this.radiusVault` undefined): a NAS save failed after the database write.

## 2. Design

```
Panel (NAS create/edit/enable/disable/delete, import)
  → NestJS NasService → PostgreSQL nas row (radius_secret_enc = AES-256-GCM)
  → RadiusClientVaultService.apply()  [one at a time per host: lock + queue]
      ├─ server still on SQL clients ("sql" mode): keep / restore the plaintext
      │  column for ACTIVE routers, withhold it for DISABLED ones (FreeRADIUS
      │  loads every row with a secret), check config as freerad, restart
      └─ server on the vault file ("file" mode):
           render clients.d/jointbox-nas.conf (single-quoted, escaped values,
           sanitised names, active routers with one valid address only)
           → write atomically (exclusive temp file, fsync, rename, 0640)
           → freeradius -XC as freerad: config valid AND it loads exactly
             these routers on these addresses
           → restart → confirm running → previous file restored on any failure
  → result returned to the screen (radiusSync) + persisted state + SystemLog on failure
Self-check every 5 min (primary instance): file vs database, file vs running
process, failed last sync → re-sync; retire legacy plaintext that is proven.
```

**Which source does FreeRADIUS use?** Read from the live config, never assumed:
`file` only when `clients.conf` includes the router file by name **and** the
sql module does not `read_clients`; anything else is `sql` and the plaintext
column is kept for it.

**Never a partial or stale list.** If any active router's secret cannot be
decrypted, nothing is written and the last good file stays. A file that is
current but newer than the running FreeRADIUS process is treated as "not
loaded" and FreeRADIUS is restarted (FreeRADIUS reads clients only at start-up).

**CoA / Disconnect** (`network/radius-coa.ts`): RFC 5176 Request Authenticator
plus Message-Authenticator (HMAC-MD5, computed with the authenticator field
zeroed — the order FreeRADIUS uses), retransmission of the same packet, and the
reply is accepted only if its Response Authenticator verifies with the
router's secret (a forged or stray UDP datagram is not an ACK). NAK
Error-Cause is reported. `RADIUS_COA_MESSAGE_AUTHENTICATOR=0` disables the
attribute for a NAS that rejects it.

## 3. Keys and secrets

* Router secrets are stored as AES-256-GCM (`iv:tag:ciphertext`, Node.js
  crypto/OpenSSL) in `nas.radius_secret_enc`. Key = SHA-256 of `SECRETS_KEY`
  (or `JWT_SECRET` when `SECRETS_KEY` was never set). The key is in
  `backend/.env` only — not in the repository, not in the database.
* `install.sh` and `deploy/install-ubuntu.sh` **keep** an existing
  `JWT_SECRET`/`SECRETS_KEY` when re-run. `update-jointbox.sh` pins
  `SECRETS_KEY` to the value already in use (only after `keycheck` confirms
  every stored secret decrypts with it), so changing `JWT_SECRET` later cannot
  break stored secrets. The cutover tightens `backend/.env` to 0600.
* **Back up the key**: copy `/opt/jointbox/backend/.env` to offline, access-
  controlled storage. Without it the encrypted copies cannot be decrypted;
  the only recovery is re-entering each router's secret on its router page.
* **Rotating one router's secret**: change it on the MikroTik and on the
  router page. The vault rewrites the file and restarts FreeRADIUS; other
  routers are not affected (verified, §6 T13).
* **Rotating the encryption key itself is not automated.** `SECRETS_KEY` also
  encrypts other stored credentials, so a new key without re-encrypting all of
  them breaks them. Until a rotation tool exists: keep the key; if it is
  compromised, assume every router secret is too and re-enter them all.
* **Legacy plaintext** (`nas.secret`) is kept only while it is the rollback
  path. Retirement condition, per router: FreeRADIUS has accepted accounting
  from that router's address since the cutover (`radacct`, signed with the
  shared secret — proof the file holds the right secret), or the operator
  runs `--accept` after testing logins. New and edited secrets in file mode
  are stored encrypted only. `--rollback` rebuilds the column from the
  encrypted copies while the key is kept.
* Secrets never appear in API responses (masked `••••••••`), logs, SystemLog,
  ActivityLog, the state file or the saved FreeRADIUS check logs (verified,
  §6 T17). The FreeRADIUS admin screen cannot open `clients.d/` or `certs/`
  and shows every `secret`/`password` value as `<hidden>`.

## 4. The cutover script

`sudo bash /opt/jointbox/backend/scripts/radius-vault-cutover.sh [option]`
(`update-jointbox.sh` runs it without options after every deploy; it never
fails the update.)

| Option | Does |
|---|---|
| *(none)* | Switch to / refresh the vault file: preflight (root, layout, built backend, key decrypts every secret, `.env` 0600), back up, render, validate the **complete resulting config in a private copy** as `freerad` (must load every router), apply, validate live, restart, confirm running and loaded, record the cutover. Rerun: no change → no restart. Plaintext is **not** cleared. |
| `--dry-run` | Everything up to and including the private-copy validation. Nothing live changes. |
| `--status` | Report mode, include, running/loaded, file permissions, database counts, key check. |
| `--accept` | After real logins were tested: retire every legacy plaintext copy. |
| `--rollback` | Back to FreeRADIUS reading routers from SQL using the newest `MODE=sql` backup (wildcard include stripped): validated in a private copy, plaintext restored from the vault for active routers, applied, restarted, confirmed; on failure the vault config is put back. |

Exit codes: 0 done · 1 not root / not built / bad option · 2 a secret cannot be
decrypted or the database is unreachable (nothing changed) · 3 FreeRADIUS
rejected the config (live untouched or restored) · 4 FreeRADIUS did not start or
did not load the routers (previous config restored) · 5 another update holds
the lock · 6 `--rollback`/`--accept` not possible (nothing changed).

## 5. Production runbook

Run as root on the panel server. Nothing here stops RADIUS except the restarts
the scripts do after validation.

**Preflight**
```bash
cd /opt/jointbox && git log -1 --oneline            # the deployed commit
systemctl is-active freeradius postgresql
sudo runuser -u freerad -- freeradius -Cx -lstdout | tail -1   # "Configuration appears to be OK"
grep -nE '^\s*\$INCLUDE|^\s*client ' /etc/freeradius/3.0/clients.conf
grep -nE 'read_clients' "$(readlink -f /etc/freeradius/3.0/mods-enabled/sql)"
ls -l /etc/freeradius/3.0/clients.d/ 2>/dev/null
stat -c '%a %U' /opt/jointbox/backend/.env
```

**Backup** (in addition to what the scripts take)
```bash
sudo tar czf /root/radius-before-vault-$(date +%F).tgz /etc/freeradius/3.0 /opt/jointbox/backend/.env
sudo -u postgres pg_dump -Fc jointbox -t nas -f /root/nas-before-vault-$(date +%F).dump
```

**Deploy and switch**
```bash
sudo bash /opt/jointbox/update-jointbox.sh           # build, migrate, reload, then cutover
sudo bash /opt/jointbox/backend/scripts/radius-vault-cutover.sh --status
```
Or step by step: `--dry-run` first, then without options.

**Validate**
```bash
sudo runuser -u freerad -- freeradius -Cx -lstdout | tail -1
sudo ls -l /etc/freeradius/3.0/clients.d/jointbox-nas.conf  # -rw-r----- root freerad
sudo grep -c '^client jointbox-nas-' /etc/freeradius/3.0/clients.d/jointbox-nas.conf
```
Panel: Settings → **Routers known to FreeRADIUS** (every active router "in
FreeRADIUS", sync healthy, FreeRADIUS running).

**One dedicated PPPoE test subscriber**
1. Panel: create subscriber `vaulttest01` with a strong password on a test
   package, on the router you test through.
2. MikroTik (RouterOS):
   ```
   /radius print detail              # address = panel server IP, secret = the router page's secret
   /radius incoming set accept=yes port=3799
   /ppp aaa set use-radius=yes accounting=yes interim-update=1m
   ```
3. Dial PPPoE from a test client as `vaulttest01`. On the MikroTik:
   `/ppp active print where name=vaulttest01`, `/log print where topics~"radius"`.
4. On the server: `sudo tail -f /var/log/freeradius/radius.log` shows
   `Login OK: [vaulttest01]`. In the panel the subscriber is online with its IP.

**Accounting**
```bash
sudo -u postgres psql jointbox -c "select username, host(nasipaddress), host(framedipaddress),
  acctstarttime, acctupdatetime, acctstoptime from radacct where username='vaulttest01'
  order by radacctid desc limit 3;"
```
Start → row with `acctstoptime` empty; after a minute `acctupdatetime` moves;
hang up → `acctstoptime` set, panel shows offline.

**CoA / Disconnect / bandwidth** — NAS page → open the router → **⚡ Test CoA**
must report "router responded (ACK)". Then Network page → the test
subscriber's live session → **Speed** (e.g. 5/5 Mbps): the panel must say
"changed live", and on the MikroTik `/ppp active print detail where
name=vaulttest01` / `/queue simple print where name~"vaulttest01"` shows the new
rate. Then **Disconnect**: the session disappears on the MikroTik and the
client redials. A NAK or timeout here with a working login means the
MikroTik's `/radius incoming` is off, port 3799 is filtered, or the secret
differs.

**Existing subscribers still authenticate**
```bash
sudo grep -c 'Login OK' /var/log/freeradius/radius.log
sudo grep -E 'Login incorrect|invalid Message-Authenticator|unknown client' /var/log/freeradius/radius.log | tail
```
and in the panel Settings table each router's "Last accounting" moves after
the switch.

**Accept** (only after the checks above pass for each router you can test)
```bash
sudo bash /opt/jointbox/backend/scripts/radius-vault-cutover.sh --accept
```
Routers you could not test keep their plaintext copy until accounting proves
them; nothing else is needed.

**Roll back** (any step fails)
```bash
sudo bash /opt/jointbox/backend/scripts/radius-vault-cutover.sh --rollback
sudo runuser -u freerad -- freeradius -Cx -lstdout | tail -1
```
Last resort: `sudo tar xzf /root/radius-before-vault-<date>.tgz -C /` and
`sudo systemctl restart freeradius`.

## 6. What was verified, and where

Sandbox: FreeRADIUS 3.2.5 (Ubuntu package, systemd-equivalent start as
`freerad` with the unit's `-Cx` pre-check), PostgreSQL 16, the built backend
(two processes for the cluster test). Simulated routers are addresses on the
test host; CoA was answered by an independent FreeRADIUS CoA listener with
`require_message_authenticator = yes`.

| # | Check | Result |
|---|---|---|
| RC | ca05d44 behaviour: NULL plaintext, SQL clients → request dropped "Shared secret is incorrect", no reply | reproduced |
| T1–T2 | Legacy (SQL) server: plaintext restored, existing + panel-created router and subscriber authenticate | pass |
| T3 | `--dry-run` validates in a copy, live untouched | pass |
| T4 | Config FreeRADIUS rejects → exit 3, live untouched | pass |
| T5 | FreeRADIUS cannot start → exit 4, previous config restored byte-for-byte, old path works | pass |
| T6–T7 | Cutover: include once, `read_clients = no`, 0640 root:freerad, plaintext kept; rerun no-op | pass |
| T8 | Accounting Start/Interim/Stop, online → offline in the panel; plaintext retired only for the proven router | pass |
| T9 | PAP, CHAP, MS-CHAPv2 accept; wrong password reject; wrong secret no reply | pass |
| T10 | Unknown router no reply; disabled router no reply; re-enabled works | pass |
| T11 | Retransmitted Access-Request gets the cached identical reply; duplicate Accounting-Start one row | pass |
| T12 | Test-CoA, bandwidth CoA (Mikrotik-Rate-Limit), Disconnect ACKed by FreeRADIUS CoA listener; wrong secret → not a false ACK | pass |
| T13 | One router's secret rotated: new works, old dropped, other company's router unaffected | pass |
| T14–T15 | Stale load detected and fixed; backend restart no-op; FreeRADIUS restart keeps routers | pass |
| T16 | Company sees only its routers; platform sees all without names; company gets 403 on vault/sync/retire/FreeRADIUS files; cross-company router read 404 | pass |
| T18 | `--accept` path retires all plaintext, logins keep working | pass |
| T19–T20 | `--rollback` after full retirement: plaintext rebuilt, SQL clients authenticate, app follows; repeated rollback refused; switch again | pass |
| T17 | No secret/password in API responses, backend log, state file, check logs, SystemLog, ActivityLog | pass |
| cluster | 6 parallel creates + 6 parallel deletes split over 2 backend processes → 4 FreeRADIUS restarts, all 12 synced OK | pass |

**Not verified (needs the real environment)**: a real MikroTik PPPoE login,
accounting and CoA/bandwidth change (run §5 with one test subscriber); the
production server's current FreeRADIUS layout (run §5 Preflight); RouterOS
behaviour with Message-Authenticator in CoA on your RouterOS version.

## 7. Troubleshooting

| Symptom | Look at | Fix |
|---|---|---|
| Router "Left out — no RADIUS secret set" | Settings table / router page | enter the secret on the router page |
| "cannot be decrypted" | `--status` key line | restore the original `SECRETS_KEY`/`JWT_SECRET` in `.env`, or re-enter those secrets |
| FreeRADIUS logs "unknown client" | router's source address | the router page address must be the address requests come FROM (`src-address`) |
| "Shared secret is incorrect" | MikroTik `/radius` secret | same secret on both sides (re-save on the router page) |
| Sync failing in Settings | message under the table, `journalctl -u freeradius -n 50` | fix the named file:line, then "Sync" or wait 5 min |
| `--rollback` exit 6 "no backup" | `/var/backups/jointbox-radius/*/MODE` | restore from your own tarball (§5 Backup) |
| Login refused with `jointbox tenancy reject:<reason>` in the FreeRADIUS log | `backend/scripts/radius-tenancy.sh --status` | not a vault problem: the RADIUS tenancy policy refused it (router and subscriber of different companies, or a NAS-IP-Address naming another company's router). See `docs/RADIUS_TENANCY.md`; `--monitor` stops refusals instantly. The vault's client sync and FreeRADIUS restarts leave the tenancy hooks in place (verified). |
