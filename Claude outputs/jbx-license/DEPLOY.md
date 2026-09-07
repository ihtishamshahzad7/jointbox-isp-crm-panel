# Deploying the licence server to panel.jointbox.net (Hostinger)

Follow these in order. Steps 1–4 are one-time. Step 5 sets up auto-sync so that
from then on, `git push` is all you do.

**Everything here has been tested end to end** against PHP 8.4 and MariaDB
10.11 in a directory laid out exactly like Hostinger's: the installer was run
for real, 32 crypto/fingerprint tests and 43 end-to-end activation tests pass,
every admin page renders clean, and the credential-change, re-run-lock and
lockout guards were each exercised. Run `php tools/selftest.php` yourself any
time.

---

## ⚠ Before anything else: use a PRIVATE repo

Your ISP panel repo (`jointbox-isp-crm-panel`) is **public**. This licence server
must **not** go in it. If it does:

- every customer can read exactly how validation works, which is most of the
  work of defeating it;
- one careless `git add -A` publishes your signing key, and at that point anyone
  can mint themselves an Enterprise licence for ever.

Create a **new private repository** — `jointbox-license-server` — and put these
files there. This is not optional caution; it is the difference between a
licensing system and a public tutorial on bypassing your licensing system.

A `.gitignore` is already included that excludes `*.sk`, `private/` and
`jbx-config.php`. Check it is there before your first commit.

---

## 1. Create the database

hPanel → **Databases → Management** (on some plans: *MySQL Databases*).

1. **Create a new database.** Hostinger prefixes both names with your account
   id, so `paneljb` becomes something like `u558893159_paneljb`.
2. Click **Generate** for the password and copy it somewhere safe now —
   Hostinger will not show it again.
3. Write down all four values; the installer asks for them in step 3:
   - host: `localhost`
   - database: `u558893159_paneljb`
   - user: `u558893159_paneljb`
   - password: the generated one

**You do not need to touch phpMyAdmin.** The installer creates every table and
seeds the plan catalogue for you.

---

## 2. Create the `private` folder, then deploy

hPanel → **Files → File Manager** → `domains/panel.jointbox.net/`.

You will see `public_html`. **Create a folder called `private` next to it** —
not inside it:

```
domains/panel.jointbox.net/
├── public_html/          ← the website, served over HTTP
└── private/              ← NOT served over HTTP. Create this, empty.
```

Why it must be outside `public_html`: if PHP ever stops executing — a bad
deploy, a syntax error, a misconfigured handler — files inside `public_html`
get served as **plain text**, and your signing key would be downloadable by
anyone. Outside `public_html` it is unreachable over HTTP no matter what breaks.

Set its permissions to **0750** so the installer can write into it.

Then upload the repository into `public_html/`:

```
public_html/
├── index.html              ← your existing marketing site, untouched
├── documentation.html      ← untouched
├── install.php             ← NEW, delete after setup
├── admin/                  ← NEW
├── api/                    ← NEW
├── lib/                    ← NEW
└── sql/                    ← NEW, delete after setup
```

Nothing overwrites your existing site — `index.html` and `documentation.html`
are not part of this repository.

---

## 3. Run the installer — this is the "one file that creates everything"

Open **`https://panel.jointbox.net/install.php`** in your browser.

It shows five environment checks (PHP version, sodium, pdo_mysql, a writable
`private/`, and `random_bytes`). If any shows ✕ it tells you exactly which
hPanel screen fixes it, and refuses to run until they are all ✓.

Then fill in two short forms:

- **Database** — the four values from step 1.
- **Your admin login** — username, and a password of at least 12 characters.

Click **Install now**. In one pass it:

- creates all **9 tables** and seeds **4 plans** from your pricing page
- **generates your Ed25519 signing keypair directly on the server** and
  self-tests it. The secret key is created in place and never travels over the
  network, through a chat window, or through your laptop.
- writes `private/jbx-config.php` with your database credentials
- creates your admin account, password bcrypt-hashed in the database
- writes `private/.installed` so the installer cannot be run twice and
  overwrite your configuration

It then displays your **public key** — the half that goes into the Go agent
later. You can always read it again in the admin panel under **Settings**.

### Then do these three things

1. **Delete `install.php` and the `sql/` folder** from `public_html`.
2. **Download and back up `private/jbx_license_ed25519.sk`** somewhere
   encrypted and offline. This is the only irreplaceable file in the system:
   lose it and every licence you have ever issued stops verifying, with no way
   to reissue them.
3. **Verify nothing is exposed** (see the checks below).

### Changing your credentials later

Admin logins live in the `admin_users` database table, not in a config file.
Sign in and go to **Settings** to change your username or password, update your
details, or add another admin. Changing your password signs you out and
invalidates any other session using the old one. No file editing, ever.

If you ever lose the admin password entirely, reset it from phpMyAdmin:

```sql
-- generates a bcrypt hash for 'YourNewPassword123' — run the PHP locally
-- (php -r "echo password_hash('YourNewPassword123', PASSWORD_BCRYPT, ['cost'=>12]);")
UPDATE admin_users SET pass_hash = '$2y$12$...' WHERE username = 'your-username';
```

---

## 4. Verify the deployment

```bash
# 1. API is alive
curl https://panel.jointbox.net/api/v1/version.php
#    -> {"ok":true,"latest":"1.0.0",...}

# 2. Include files are NOT readable
curl -i https://panel.jointbox.net/lib/config.php     # -> 404
curl -i https://panel.jointbox.net/lib/crypto.php     # -> 404
curl -i https://panel.jointbox.net/admin/_auth.php    # -> 404

# 3. Nothing private is reachable
curl -i https://panel.jointbox.net/private/jbx-config.php           # -> 404
curl -i https://panel.jointbox.net/private/jbx_license_ed25519.sk   # -> 404

# 4. The installer is gone
curl -i https://panel.jointbox.net/install.php        # -> 404
```

**If any of those return 200 with content, stop and fix it before issuing a
single licence.**

The `lib/` files are protected two ways: an `.htaccess` deny, and a guard
inside each PHP file that returns 404 if it is requested directly. The second
one matters because it does not depend on the web server honouring
`.htaccess`.

Then open `https://panel.jointbox.net/admin/` and sign in. Issue a test licence
to yourself — you should get a key like `JBX-4K7QW-9MXR2-H8TVN-3PLC6`.

Prove the whole chain works with a fake activation:

```bash
curl -s -X POST https://panel.jointbox.net/api/v1/activate.php \
  -H 'Content-Type: application/json' \
  -d '{
    "license_key":"JBX-PUT-YOUR-TEST-KEY-HERE",
    "fingerprint":{
      "machine_id":"'"$(echo -n test1 | sha256sum | cut -d" " -f1)"'",
      "mac":"'"$(echo -n test2 | sha256sum | cut -d" " -f1)"'",
      "rootfs":"'"$(echo -n test3 | sha256sum | cut -d" " -f1)"'"
    },
    "primary_mac":"aa:bb:cc:dd:ee:ff",
    "hostname":"test-box",
    "panel_version":"1.0.0",
    "nonce":"'"$(openssl rand -hex 16)"'",
    "ts":'"$(date +%s)"',
    "customer":{"company":"Test ISP"}
  }'
```

You should get `{"ok":true,"license":"eyJ...","hmac_secret":"...", ...}` — and the
activation should now appear in the admin UI with its hostname and MAC.

Delete that test licence afterwards (or leave it; it costs nothing).

---

## 5. Auto-sync: push locally, Hostinger updates itself

This is the part you asked for. Hostinger has built-in Git deployment.

### 5.1 Connect the repository

hPanel → **Advanced → GIT**.

- **Repository address**:
  - Public repo: `https://github.com/you/jointbox-license-server.git`
  - **Private repo (what you want)**: use SSH — `git@github.com:you/jointbox-license-server.git`
    Hostinger shows you a **public SSH key** on this page. Copy it, then in GitHub
    go to your repo → **Settings → Deploy keys → Add deploy key**, paste it, and
    leave "Allow write access" **unchecked** (Hostinger only needs to read).
- **Branch**: `main`
- **Install path**: leave **blank** to deploy into `public_html`.

Click **Create**. Hostinger does the first clone.

### 5.2 Turn on auto-deployment

Still on the GIT page, next to your repository click **Auto-Deployment** →
**Enable**. Hostinger gives you a **webhook URL** like:

```
https://webhooks.hostinger.com/deploy/abc123def456...
```

Copy it. Then in GitHub: repo → **Settings → Webhooks → Add webhook**

- **Payload URL**: the Hostinger webhook URL
- **Content type**: `application/json`
- **Secret**: leave empty
- **Which events**: *Just the push event*
- **Active**: ✅

Click **Add webhook**. GitHub sends a test ping immediately — it should show a
green tick. If it shows a red X, the URL was pasted wrong.

### 5.3 From now on

```bash
git add .
git commit -m "Add heartbeat endpoint"
git push
```

Within a few seconds Hostinger pulls and the live site updates. No FTP, no
File Manager.

`private/` is untouched by deploys — it lives outside `public_html`, so your
config and signing key survive every push. That is the other reason for putting
them there.

### 5.4 If a push does not appear live

1. GitHub → repo → Settings → Webhooks → click the webhook → **Recent
   Deliveries**. A red X means GitHub could not reach Hostinger.
2. hPanel → Advanced → GIT → **Deploy** (manual button) to force a pull.
3. If Hostinger reports a conflict, it is because a file was edited directly in
   File Manager. Git will not overwrite local edits. Either revert the edit or
   commit it upstream.

**Rule of thumb once auto-deploy is on: never edit files in File Manager again**,
except inside `private/`. Edit locally, commit, push. Otherwise your repo and
your live site silently drift apart.

---

## 6. Cron jobs

hPanel → **Advanced → Cron Jobs**. Add:

| Schedule | Command | Why |
|---|---|---|
| Daily, 02:00 | `php /home/uXXXXXXXX/domains/panel.jointbox.net/public_html/tools/cron-daily.php` | Expire lapsed licences, prune nonces, email you the overdue digest |

(`cron-daily.php` comes with the heartbeat work — not needed until installs are
calling home.)

Get your real home path from File Manager; it is shown in the address bar.

---

## 7. Hardening checklist before you go live

- [ ] `install.php` and `sql/` are **deleted** from `public_html`
- [ ] Admin password is 12+ characters and not used anywhere else
      (change it any time under **Settings**)
- [ ] The database password has been rotated in hPanel if it was ever pasted
      into a chat, ticket or email
- [ ] `private/jbx-config.php` and the `.sk` are chmod **0400**
- [ ] `jbx_license_ed25519.sk` has an **encrypted offline backup**
- [ ] `*.sk`, `private/` and `jbx-config.php` are all in `.gitignore`
- [ ] The repo is **private**
- [ ] `curl https://panel.jointbox.net/lib/config.php` returns 404
- [ ] `curl https://panel.jointbox.net/private/...` returns 404
- [ ] SSL is active on panel.jointbox.net (hPanel → Security → SSL). Licence
      keys and HMAC secrets cross this wire.
- [ ] If your office IP is static, set `admin_ip_allowlist` in the config.
      Cheapest hardening available.

---

## What is built, and what is next

**Working now:**

- **One-run web installer** — creates tables, generates the signing keypair on
  the server, writes the config, creates your admin login, then locks itself
- **Admin credentials in the database**, changeable from the UI, with add /
  disable of other admins and a guard against locking everyone out
- MySQL schema with plans seeded from your pricing page
- Ed25519 signing, verified against forged payloads
- Licence keys with typo-catching checksums
- `POST /api/v1/activate` — binds hardware 2-of-3, issues signed licences,
  rate limited, replay protected
- 24-hour trial when no key is given, bound to hardware so a reinstall does not
  reset it
- Admin panel: dashboard with overdue / cloning / quiet-install alerts, licence
  list and detail, issue new licences, release-and-rebind hardware, customers
- Full audit log

**Next, in order:**

1. `POST /api/v1/heartbeat` + rolling renewal (the mechanism that makes
   non-payment lapse on its own)
2. The **Go agent** for the customer's server — the compiled part that cannot be
   edited out of the TypeScript panel
3. The installer prompt in `install.sh` / OVA first boot
4. The NestJS entitlement guard and the enforcement ladder
5. `cron-daily.php` and dunning emails
