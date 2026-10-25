# Uplinko — Installation & Operations Guide

This is the authoritative guide for installing a new Uplinko (Jointbox) ISP CRM
panel on a fresh server and for updating an existing one.

---

## 1. Requirements

| Item | Minimum | Notes |
|------|---------|-------|
| OS | Ubuntu **22.04 or 24.04 LTS** (x86-64) | Debian-family only; the installer uses `apt`. |
| RAM | 4 GB | 8 GB+ recommended for 1000+ subscribers / PM2 cluster mode. |
| Disk | 20 GB free | Grows with `radacct` accounting history (`RADACCT_RETAIN_DAYS`). |
| CPU | 2 cores | 4+ cores enables the PM2 cluster + dedicated worker profile. |
| Access | `root` / `sudo` | Required to configure PostgreSQL, FreeRADIUS, PM2, firewall. |
| Network | Outbound HTTPS | For packages and licence activation. |

The installer provisions and configures: **PostgreSQL**, **FreeRADIUS**,
**Redis**, **Node.js 20**, **PM2**, the **backend** (NestJS) and the **frontend**
(Next.js).

---

## 2. Fresh install — one command

On a clean server:

```bash
curl -fsSL https://raw.githubusercontent.com/ihtishamshahzad7/jointbox-isp-crm-panel/main/install.sh -o /tmp/uplinko-install.sh && sudo bash /tmp/uplinko-install.sh
```

The installer is **idempotent** — re-running it upgrades in place rather than
duplicating. It is interactive for **licence activation** and company details
(step 10); everything else is automatic.

### What it does (10 steps)
1. System packages (curl, git, build tools, Redis, ufw).
2. Node.js 20 + PM2.
3. PostgreSQL: database, role, tuning.
4. FreeRADIUS.
5. Clone/update the repo into `/opt/jointbox` (or in place if run from a checkout).
6. **Database deploy** — `npm run db:deploy` (forward-only migrations + RADIUS
   schema isolation). Stops the install on any migration error.
7. Backend & frontend dependency install and build. Stops if either build fails.
8. PM2 process start + boot persistence; port-80 redirect; firewall.
9. Service start and **health checks** — waits until the API `/health` and the
   panel actually respond, not merely that a process started.
10. Licence activation (interactive; never blocks a working install).

### After it finishes
It prints the panel URL, the two first-run logins (both require a password
change at first sign-in), and the database name/user. **The database password is
not printed** — it is stored in `/opt/jointbox/backend/.env` inside
`DATABASE_URL`.

---

## 3. Updating an existing client

```bash
sudo bash /opt/jointbox/update-jointbox.sh
```

The update process:
- Backs up `backend/.env` **and** the database (gzipped `pg_dump`) to
  `/var/backups/jointbox/` (dir `0700`, files `0600`, last 7 DB dumps kept)
  **before** any schema change.
- Preserves `.env`, `JWT_SECRET`, `SECRETS_KEY` (pins it so encrypted router
  secrets stay readable), licence state, uploads and all customer data.
- Fetches and deploys `origin/main`.
- Runs **safe, forward-only** migrations via `npm run db:deploy` — never
  `prisma db push`, never `--accept-data-loss`, never a reset.
- Rebuilds backend + frontend and reloads PM2.
- **Health-checks** the API (up to 2 min) and frontend (up to 1 min); reports
  success only when both actually respond, otherwise fails with the last 60–80
  log lines and leaves the previous build running.

> Do **not** use `install.sh` to update a running client; use
> `update-jointbox.sh`. The installer is safe to re-run, but the update script is
> the path that takes backups and preserves production-only state.

---

## 4. Licence activation

Handled interactively in install step 10 (and re-checked by updates). A server
that cannot reach the licence server still finishes with a working panel and a
trial. Activate later from the panel (Settings → Licence) or by re-running the
installer.

---

## 5. Ports & firewall

| Port | Proto | Purpose |
|------|-------|---------|
| 22 | TCP | SSH |
| 3001 | TCP | Backend API (`API_PORT`) |
| 3000 | TCP | Frontend panel (`WEB_PORT`); also redirected from :80 |
| 1812 | UDP | RADIUS authentication |
| 1813 | UDP | RADIUS accounting |
| 3799 | UDP | RADIUS CoA / disconnect |
| 514 | UDP | Syslog receiver (link tracing) |

The installer opens these **only if `ufw` is already installed and active** — it
never silently enables a firewall. Port 80 is redirected to `WEB_PORT` at the
kernel (NAT) so `http://<server>` works without nginx.

Override ports before running: `API_PORT=4001 WEB_PORT=8080 sudo -E bash install.sh`.

---

## 6. Backup & restore

**Automatic:** every `update-jointbox.sh` run writes a pre-update DB dump and a
config copy to `/var/backups/jointbox/`.

**Manual backup:**
```bash
cd /opt/jointbox/backend
SAFE_URL="$(node -r dotenv/config scripts/lib/pg-url.js)"   # libpq-safe URL
sudo install -m 600 /dev/null /var/backups/jointbox/db-manual-$(date +%F).sql.gz
pg_dump "$SAFE_URL" | gzip > /var/backups/jointbox/db-manual-$(date +%F).sql.gz
```

**Restore (into a maintenance window — this overwrites data):**
```bash
cd /opt/jointbox/backend
SAFE_URL="$(node -r dotenv/config scripts/lib/pg-url.js)"
gunzip -c /var/backups/jointbox/db-<stamp>.sql.gz | psql "$SAFE_URL"
pm2 restart all
```

`pg-url.js` strips Prisma-only query params (`connection_limit`, `pool_timeout`,
…) that `psql`/`pg_dump` reject, while keeping libpq-valid ones (`sslmode`, …).

---

## 7. Verify a running install

```bash
# API & panel
curl -fsS http://localhost:3001/health && echo " API ok"
curl -fsS http://localhost:3000/        >/dev/null && echo "Panel ok"

# PostgreSQL + schema separation
sudo -u postgres psql -d jointbox -c "\dn"            # should list 'radius'
sudo -u postgres psql -d jointbox -c "\dt public.nas" # nas stays a public TABLE

# FreeRADIUS
systemctl is-active freeradius
ss -ulnp | grep -E ':1812|:1813'

# Redis & PM2
redis-cli ping           # PONG
pm2 status               # jointbox-backend / jointbox-frontend online
```

---

## 8. Troubleshooting & logs

| Symptom | Where to look |
|---------|---------------|
| DB migration failed during install | `/tmp/jointbox-db-deploy.log` |
| Backend build failed | `/tmp/jointbox-backend-build.log` |
| Frontend build failed | `/tmp/jointbox-frontend.log` |
| API not healthy | `pm2 logs jointbox-backend` |
| Panel not loading | `pm2 logs jointbox-frontend` |
| FreeRADIUS down | `freeradius -XC` (config check) |
| Update failed | `update.log` + `/var/lib/jointbox/deployment-status.json` |

### `psql: invalid URI query parameter: "connection_limit"`
Fixed permanently: `db-deploy.sh` and `radius-schema-apply.sh` now route all
`psql` connections through `scripts/lib/pg-url.js`, which sanitizes the Prisma
URL. If you see this again, you are running an old copy of the scripts — update.

### `DATABASE_URL is required` / RADIUS check aborts silently
Fixed permanently: the deploy scripts load `backend/.env` into the shell via
`scripts/lib/load-env.sh`, so `psql` and the Node heredoc both inherit
`DATABASE_URL`. Confirm `backend/.env` exists and contains `DATABASE_URL=`.

---

## 9. Regression tests (maintainers)

```bash
cd backend
npm run test:db-scripts
```

Runs the URL-sanitizer and env-loader unit tests (always) and a full
integration test against a **disposable** PostgreSQL cluster (when server
binaries are present; self-skips otherwise). These prove the `connection_limit`
and missing-`DATABASE_URL` failures cannot recur. They are also wired into CI
(`.github/workflows/ci.yml`, backend job). **They never touch a real database.**
