# Jointbox Licence Management Plane — Build Guide

**Goal:** every on-premises Jointbox install must ask for a licence key, validate it against
`panel.jointbox.net`, bind to that machine's hardware, and keep re-validating. 24h trial if no
key. Client should not be able to trivially disable the check.

**Two pieces:**

| Piece | Where it runs | Language | Why |
|---|---|---|---|
| **Licence server** | panel.jointbox.net (Hostinger) | PHP 8 + MySQL | Shared hosting has no persistent Node process. PHP ships `sodium_*` = Ed25519 for free. |
| **Licence agent** | the customer's Ubuntu box | Go (static binary) | The panel is TypeScript = plain text on their disk. A compiled binary is the only part that can meaningfully resist tampering. |

---

## 0. The honest security position — read this first

You asked that the client not be able to crack it. Here is what is actually true, so you build
the right thing:

- **The Node/NestJS panel cannot be protected.** `backend/dist/*.js` is readable and editable by
  root on their own server. Any check written in TypeScript is a one-line delete.
- **Therefore the check must not live in Node.** It lives in a stripped, obfuscated Go binary.
  That moves the attack from "edit a JS file" to "patch a binary" — hours, not minutes, and it has
  to be redone on every release.
- **The real deterrent is the rolling renewal** (§3.4). The licence on disk is only valid ~14 days.
  Stop paying → renewals stop → it lapses on its own. A cracked binary also stops receiving
  updates, support and migration help, which is what customers are actually buying.
- **Never break RADIUS.** An expired licence must not knock a real ISP's subscribers offline. If it
  ever does, you will be blamed for an outage and lose the customer permanently. Enforcement
  targets the *panel*, never `auth`/`accounting`/CoA.

Design for the honest 95%, make the dishonest 5% expensive and unsupported. That is the achievable
target.

---

## 1. Cryptography — the foundation

One Ed25519 keypair. Generate it **once, offline, on your own machine**, never in a browser and
never on the server:

```bash
php -r '$k=sodium_crypto_sign_keypair();
  file_put_contents("jbx_license_ed25519.sk", sodium_bin2hex(sodium_crypto_sign_secretkey($k)));
  file_put_contents("jbx_license_ed25519.pk", sodium_bin2hex(sodium_crypto_sign_publickey($k)));'
```

- **Secret key** → uploaded to Hostinger **outside** `public_html`, chmod 0400. Keep an encrypted
  offline backup (this key *is* your licensing business — lose it and every licence dies).
- **Public key** → compiled into the Go agent as a constant. This is what lets the agent verify a
  licence with no network at all.

Never put the secret key in git. Add it to `.gitignore` before you create it.

---

## 2. Licence server (PHP 8 + MySQL on Hostinger)

### 2.1 Database schema

```sql
CREATE TABLE plans (
  id            VARCHAR(32) PRIMARY KEY,      -- 'starter','professional','enterprise','trial'
  name          VARCHAR(64) NOT NULL,
  max_subscribers INT NOT NULL,               -- 0 = unlimited
  features      JSON NOT NULL,                -- ["olt","franchise","ipv6",...]
  price_pkr_month INT NOT NULL,
  validity_days INT NOT NULL DEFAULT 14       -- rolling licence lifetime
);

CREATE TABLE customers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  company     VARCHAR(160) NOT NULL,
  website     VARCHAR(160),
  contact_name VARCHAR(120),
  email       VARCHAR(160),
  phone       VARCHAR(40),
  country     VARCHAR(60),
  created_at  DATETIME NOT NULL,
  notes       TEXT
);

CREATE TABLE licenses (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  license_key   CHAR(29) UNIQUE NOT NULL,     -- JBX-XXXXX-XXXXX-XXXXX-XXXXX
  customer_id   BIGINT NOT NULL,
  plan_id       VARCHAR(32) NOT NULL,
  status        ENUM('unactivated','active','suspended','expired','revoked') NOT NULL,
  hmac_secret   CHAR(64) NOT NULL,            -- per-licence, for signing heartbeats
  paid_until    DATE NULL,                    -- your billing truth. renewals stop past this.
  max_rebinds_year TINYINT NOT NULL DEFAULT 3,
  is_trial      TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL,
  INDEX(customer_id), INDEX(status)
);

CREATE TABLE activations (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  license_id    BIGINT NOT NULL,
  fp_machine_id CHAR(64), fp_mac CHAR(64), fp_rootfs CHAR(64),  -- sha256 each, salted
  primary_mac   VARCHAR(24),                  -- readable, for your support desk
  hostname      VARCHAR(120),
  public_ip     VARCHAR(45),
  panel_version VARCHAR(32),
  os_release    VARCHAR(120),
  activated_at  DATETIME NOT NULL,
  last_seen_at  DATETIME,
  rebind_count  SMALLINT NOT NULL DEFAULT 0,
  status        ENUM('active','released','blocked') NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_lic_fp (license_id, fp_machine_id),
  INDEX(license_id)
);

CREATE TABLE heartbeats (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  activation_id BIGINT NOT NULL,
  at            DATETIME NOT NULL,
  subscriber_count INT,
  nas_count     INT,
  panel_version VARCHAR(32),
  tamper_flags  VARCHAR(255),                 -- what the agent noticed
  ip            VARCHAR(45),
  INDEX(activation_id, at)
);

CREATE TABLE nonces (                          -- replay protection
  nonce CHAR(32) PRIMARY KEY, seen_at DATETIME NOT NULL, INDEX(seen_at)
);

CREATE TABLE audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, at DATETIME NOT NULL,
  actor VARCHAR(80), action VARCHAR(80), target VARCHAR(120), detail TEXT
);
```

Seed `plans` from your pricing page: `starter` 3500, `professional` 8500, `enterprise` 15000 PKR/mo,
plus `trial` (validity_days = 1, max_subscribers = 25).

### 2.2 Licence key format

Human-typeable, checksummed, no ambiguous characters:

```
JBX-4K7QW-9MXR2-H8TVN-3PLC6
```

Crockford base32 (no I, L, O, U), 20 payload chars = 100 bits, last char a mod-37 checksum so a
typo is rejected instantly by the installer without a round trip. Generate with
`random_bytes()`, never `rand()`.

### 2.3 API endpoints

All under `https://panel.jointbox.net/api/v1/`, JSON, TLS only.

**`POST /activate`** — first contact, called by the installer.
```json
{ "license_key":"JBX-...", "fingerprint":{"machine_id":"<sha256>","mac":"<sha256>","rootfs":"<sha256>"},
  "primary_mac":"aa:bb:cc:dd:ee:ff", "hostname":"isp-panel-01", "panel_version":"1.4.2",
  "os_release":"Ubuntu 24.04.1 LTS",
  "customer":{"company":"...","website":"...","contact_name":"...","email":"...","phone":"..."},
  "nonce":"<16 random bytes hex>", "ts":1757203200 }
```
Server: validate key → check status → if already activated on a *different* fingerprint, refuse with
`ALREADY_ACTIVATED` (support ticket or self-service rebind) → else create activation, merge the
customer details, return a **signed licence** (§2.4) plus the `hmac_secret`.

**`POST /heartbeat`** — every 6h. Body signed `HMAC-SHA256(hmac_secret, canonical_json)` in an
`X-JBX-Signature` header. Server verifies signature, rejects stale (`|now-ts| > 300s`) or replayed
(`nonce` seen) requests, updates `last_seen_at`, records the row, then:
- `paid_until >= today` and `status='active'` → issue a **fresh signed licence**, `validity_days` from now.
- otherwise → return the current state (`grace`, `suspended`, `expired`) and **no new licence**.

**`POST /rebind`** — customer moved to new hardware. Allowed if `rebind_count < max_rebinds_year`;
marks the old activation `released`, binds the new fingerprint, increments the counter. This is what
saves your support desk.

**`GET /version`** — latest panel version + changelog URL. Free telemetry, and gives the agent a
reason to call home that customers see value in.

Rate-limit `/activate` hard (5/hour/IP) — it's the only unauthenticated endpoint.

### 2.4 The signed licence blob

A compact JWS (`EdDSA`), which the agent can verify entirely offline:

```json
{ "lid": 1042, "key":"JBX-4K7QW-...", "plan":"professional",
  "max_subs": 5000, "feat": ["olt","franchise","ipv6","coa"],
  "fp": {"machine_id":"<sha256>","mac":"<sha256>","rootfs":"<sha256>"},
  "iat": 1757203200, "exp": 1758412800,     // ~14 days
  "grace_days": 7, "trial": false, "company":"Acme Networks" }
```

Signed with `sodium_crypto_sign_detached($payload, $secretKey)`. Written by the agent to
`/etc/jointbox/license.jws`, root-owned, 0400.

### 2.5 Admin UI (`/admin`, behind auth + 2FA)

- Customers list → detail (all activations, heartbeat timeline, MAC, IP, subscriber count trend)
- **Issue licence**: pick customer + plan + `paid_until` → prints the key to hand over
- Suspend / reactivate / revoke; force rebind; block a specific activation
- **Overdue view**: `paid_until < today` — your collections queue
- **Anomaly view**: same licence seen from >1 fingerprint, subscriber count over plan limit,
  tamper flags reported, no heartbeat in 7 days
- Every mutation writes `audit_log`

Protect it with HTTP basic auth *plus* app login, and IP-allowlist it if your IP is stable. This UI
can mint licences — treat it like your bank.

### 2.6 Cron (Hostinger supports this)

Daily: mark `licenses` past `paid_until + grace` as `expired`; reset `rebind_count` annually;
email customers at T-14/T-7/T-1 days; email you the overdue + anomaly digest.

---

## 3. Licence agent (Go, on the customer's box)

`jointbox-licensed` — one static binary, ~4 MB, no runtime dependencies.

### 3.1 Fingerprint, 2-of-3 tolerant

```
fp.machine_id = sha256(pepper + /etc/machine-id)
fp.mac        = sha256(pepper + lowest-numbered non-virtual NIC's MAC)
fp.rootfs     = sha256(pepper + blkid UUID of /)
```

Match = **at least 2 of 3 equal**. A swapped NIC or reinstalled disk keeps working; a whole
different machine does not. `pepper` is a per-build constant so fingerprints aren't reproducible
by an outsider.

### 3.2 What it does at boot

1. Read `/etc/jointbox/license.jws`. No file → **trial mode** (§4).
2. Verify Ed25519 signature against the embedded public key. Bad → `INVALID`.
3. Check `exp`. Past `exp` but within `grace_days` → `GRACE`. Past both → `EXPIRED`.
4. Check fingerprint 2-of-3. Fail → `HARDWARE_MISMATCH`.
5. Serve the verdict on a local unix socket.

### 3.3 How the panel asks it

`/run/jointbox/licensed.sock`, unix socket, mode 0660, group `jointbox`. The NestJS backend asks
for entitlement on boot and every 15 min:

```
→ {"nonce":"<random>"}
← {"state":"ACTIVE","plan":"professional","max_subs":5000,
   "feat":["olt","franchise"],"exp":1758412800,"nonce":"<echoed>",
   "sig":"<ed25519 over this response, agent's session key>"}
```

The nonce echo + signature is the point: a cracked Node file that hardcodes `state:"ACTIVE"` can't
produce a valid signature, so the panel detects a *forged* entitlement and enters `TAMPERED` —
which the next heartbeat reports to you. They can still delete the check entirely, but now you know
which licence did it.

### 3.4 Heartbeat loop

Every 6h ± random jitter (jitter matters — otherwise every install on earth hits Hostinger at
midnight). On success, atomically replace `license.jws` with the fresh one. On failure, keep the old
one and retry with backoff — **never** downgrade state because the network is down. Only `exp` +
`grace_days` running out downgrades state.

### 3.5 Build hardening

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.pepper=$PEPPER" -o jointbox-licensed
```
Then run it through `garble` (`garble -literals -tiny build`) to strip identifiers and encrypt
string literals. Ship as a systemd service with `Restart=always`. Consider a per-release pepper so
each version needs re-cracking.

---

## 4. Install & trial flow (what your customer actually sees)

**OVA first boot / `install.sh`:**

```
╔══════════════════════════════════════════════════╗
║   Jointbox ISP Panel — Activation                ║
╚══════════════════════════════════════════════════╝

  Licence key (or press Enter for a 24-hour trial):
  > JBX-____-____-____-____

  Company name    :
  Website         :
  Contact person  :
  Email           :
  Phone           :
```

- Key entered → checksum validated locally → `/activate` → licence written → panel starts fully.
- Enter pressed → server issues a **trial licence, `validity_days = 1`, one per fingerprint ever**
  (so reinstalling doesn't reset it). Panel runs fully for 24h.
- **After 24h** the panel shows a blocking activation screen asking for the key, and — as you
  asked — it displays and reports the hardware id: hostname, primary MAC, fingerprint hash. You see
  the same details in the admin UI, so a phone call is enough to identify them.
- No internet at install time → offline fallback: the screen shows the fingerprint, the customer
  sends it to you, you generate an offline signed licence in the admin UI and they paste it in.
  You need this — some ISP NOCs genuinely have no outbound internet from the management VLAN.

**Enforcement ladder** (matches what you chose, with the RADIUS carve-out):

| State | Panel behaviour | RADIUS |
|---|---|---|
| `ACTIVE` | normal | normal |
| T-14 days | dismissible banner | normal |
| `GRACE` | persistent banner, admin-only nag | **normal** |
| `EXPIRED` | block *new* subscriber creation; read-only | **normal** |
| `HARDWARE_MISMATCH` | activation screen, read-only | **normal** |
| `TAMPERED` | activation screen, read-only, flagged to you | **normal** |

Auth, accounting, interim updates and CoA keep working in **every** state. Their subscribers never
go offline because of your licensing.

---

## 5. Build order

1. **Keypair** offline, secret key backed up encrypted. (§1)
2. **MySQL schema** + seed `plans` from the pricing page. (§2.1)
3. **`/activate` + signed licence issuance** in PHP, tested with `curl`. (§2.3–2.4)
4. **Go agent**: fingerprint, offline verify, `/activate` call, write `license.jws`. (§3.1–3.2)
5. **Installer prompt** wired into `install.sh` + OVA first boot. (§4)
6. **`/heartbeat`** + rolling renewal + the agent's 6h loop. (§2.3, §3.4)
7. **Unix socket + NestJS entitlement guard** + the enforcement ladder. (§3.3, §4)
8. **Admin UI** — issue, suspend, rebind, overdue, anomalies. (§2.5)
9. **Cron** expiry sweep + dunning emails. (§2.6)
10. **Harden**: garble the binary, rate-limit `/activate`, 2FA the admin. (§2.3, §3.5)
11. **Trial + offline activation** paths. (§4)

Steps 1–5 alone give you a working "must enter a key to install". Everything after that is
enforcement and operations.

---

## 6. Things that will bite you if you skip them

- **Losing the secret key** kills every licence in the field. Encrypted offline backup, today.
- **No jitter on heartbeats** → thousands of installs hammering shared hosting at the same second.
- **Hard-failing on network errors** → one Hostinger outage disables every customer's panel at once.
  This is the single most dangerous bug in this design. Only `exp` downgrades state.
- **Sending subscriber PII home.** Send *counts*, never names, CNICs or MACs of end-users. You are
  handling Pakistani ISP subscriber data; keep the blast radius at zero.
- **No offline activation path** → you lose every air-gapped NOC deal.
- **Clock skew.** A box with a wrong clock will read a valid licence as expired. Give the agent
  ±48h tolerance on `exp` and prefer the server's time from the last heartbeat.
- **Trial reset by reinstall.** Bind the trial to the fingerprint permanently, not to the install.
