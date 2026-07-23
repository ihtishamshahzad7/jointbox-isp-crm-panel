# Jointbox — Fresh Ubuntu Setup (keep this)

One installer sets up the **entire** stack on a clean Ubuntu 22.04 / 24.04 machine:
Node 20, PostgreSQL, Redis, **FreeRADIUS 3 wired to PostgreSQL**, Nginx, PM2, the app,
database + migrations, and the first admin user. You install Ubuntu, run one command, done.

Minimum VM: 2 vCPU, 4 GB RAM, 40 GB disk.

---

## The one command

### Option A — you have the code in a Git repo (best for "any Ubuntu")
Publish the project once (see "Publishing" below), then on any fresh Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/<YOU>/<REPO>/main/deploy/bootstrap.sh | sudo bash
```

That clones the repo to `/opt/jointbox` and runs the full installer. Re-running it later
pulls the latest code and re-installs (safe to repeat).

### Option B — you copied the folder onto the Ubuntu box (USB / scp / shared folder)
Put the `Jointbox panel` folder anywhere (delete `node_modules`, `.next`, `dist` first to
keep it small), then:

```bash
sudo bash "/path/to/Jointbox panel/deploy/install-ubuntu.sh"
```

When it finishes it prints the panel URL.

---

## What you get after it finishes

- **Admin panel:** `http://<server-ip>/`  (or `:3000`)
- **Subscriber portal:** `http://<server-ip>/portal`
- **Backend API:** `http://<server-ip>:3001`
- **Login:** `admin@jointbox.com` / `admin123`  — created automatically on first boot. **Change it.**
- **Database:** `jointbox` / user `jointbox` / pass `jointbox123` (localhost)
- **FreeRADIUS:** auth `1812/udp`, acct `1813/udp`, CoA `3799/udp`, reading the same `jointbox` DB
- **Process manager:** PM2 (auto-starts on reboot). `pm2 status`, `pm2 logs`, `pm2 restart all`

The admin user is created by the backend itself on first boot (if the DB has no users), so
it works no matter how you deploy. Override with `ADMIN_EMAIL` / `ADMIN_PASSWORD` in
`backend/.env` before first start.

---

## Publishing (do this once so Option A works)

From the project root on Windows:

```bash
git init && git add . && git commit -m "Jointbox"
git branch -M main
git remote add origin https://github.com/<YOU>/<REPO>.git
git push -u origin main
```

`node_modules`, `.next`, `dist`, and `.env` are already git-ignored. Then edit
`deploy/bootstrap.sh` and set `REPO_URL` to your repo (or pass `JOINTBOX_REPO=` when running).

---

## After install — verify RADIUS works end to end

1. Log in, create a **Package** (e.g. 10/10 Mbps).
2. Create a **Subscriber** on that package (username `testuser`, password `test123`).
   The backend auto-writes `radcheck` (password) + `radreply` (Mikrotik-Rate-Limit).
3. On the server, test auth:
   ```bash
   radtest testuser test123 127.0.0.1 0 testing123
   ```
   Expect **Access-Accept** with `Mikrotik-Rate-Limit = "10M/10M"`.
4. Register your **MikroTik** as a NAS in the panel (Add NAS), point the router's RADIUS
   at `<server-ip>` secret `testing123` (or whatever you set), enable PPP `use-radius`.

Subscribers can only exist in RADIUS if they exist as a Subscriber in the app — the
`radcheck.username` foreign key enforces this on purpose (no orphan RADIUS accounts).

---

## Manage / update

```bash
pm2 status                 # both processes
pm2 logs                   # live logs
pm2 restart all            # after code changes
cd /opt/jointbox && git pull && sudo bash deploy/install-ubuntu.sh   # update in place
```

Edit secrets in `/opt/jointbox/backend/.env`, then `pm2 restart jointbox-backend`.

---

## Gotchas we already hit (so future-you doesn't re-debug)

- **Remote DB access denied (`P1010`)** — only relevant if the app and PostgreSQL are on
  *different* machines. Postgres must have `listen_addresses = '*'` and a `pg_hba.conf` rule
  covering the client's subnet, e.g. `host all all 192.168.0.0/23 scram-sha-256`, then
  `sudo systemctl restart postgresql`. The all-in-one installer keeps everything on
  localhost, so this doesn't apply there.
- **`radcheck` insert fails with foreign-key error** — expected. Create the subscriber in the
  app instead of hand-inserting SQL.
- **FreeRADIUS `Ignoring "sql"` or Access-Reject** — the SQL module must have
  `driver = "rlm_sql_postgresql"`, `dialect = "postgresql"`, and point at the `jointbox` DB;
  the `sql` module must be enabled in `sites-available/default`. The installer does all this.
  Debug with `sudo freeradius -X`.
- **Windows dev only — port 3000 "in use" by `svchost`/`iphlpsvc`** — a stale WSL
  `netsh portproxy` rule. Clear with (Admin cmd): `netsh interface portproxy reset`.
- **Windows dev only — slow Next.js compile** — don't keep the project in a OneDrive-synced
  folder. Use a plain local/other drive.
