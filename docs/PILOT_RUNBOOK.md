# Jointbox — Paid-Pilot Operations Runbook

For the person running one Jointbox server for a small number of pilot ISPs.
Every command here matches the scripts in this repository as of the
`hardening/pilot-readiness` branch. Where something has not been verified on
real hardware it says so.

---

## 1. Supported platform

| Item | Supported |
|---|---|
| OS | Ubuntu Server 22.04 / 24.04 LTS (what `install.sh` and `deploy/install-ubuntu.sh` target) |
| Node | 22 (CI runs 22) |
| PostgreSQL | 16 (CI's integration job is pinned to 16) |
| Redis | any current 7.x; **required** in production (see §3) |
| FreeRADIUS | 3.2.x |
| Process manager | PM2 (`ecosystem.config.js`) |

Development, staging and production must be **separate servers with separate
`.env` files and separate databases**. Never point a staging panel at a
production database or a production RADIUS server.

## 2. Clean-server install

```bash
git clone https://github.com/ihtishamshahzad7/jointbox-isp-crm-panel.git /opt/jointbox
cd /opt/jointbox
sudo bash install.sh          # Postgres, Redis, FreeRADIUS, Nginx, PM2, build, migrations
sudo bash scripts/firewall.sh # prints the ufw rules; review, then apply
sudo bash scripts/setup-https.sh   # Let's Encrypt certificate for the panel's domain
```

`install.sh` runs `prisma migrate deploy`; a failed migration stops the
install rather than falling back to a schema sync.

## 3. Environment — the settings that matter

`backend/.env.example` lists them; the essentials:

| Variable | Required | Why |
|---|---|---|
| `DATABASE_URL` | yes | Main database. Passwords with `@`, `:` etc. must be URL-encoded. |
| `JWT_SECRET` | yes | The API refuses to start if unset or left at the published default. Use 32+ random characters. |
| `SECRETS_KEY` | strongly | Encrypts stored RADIUS secrets and gateway keys. **Back it up with the database**: without it, saved secrets cannot be decrypted. `update-jointbox.sh` pins it from `JWT_SECRET` if never set. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first boot | First platform login; it is forced to change its password at first sign-in. |
| `REDIS_URL` (+ `REDIS_REQUIRED=true`) | production | Queues, shared cache, and **logout/password-change revocation across PM2 processes**. Without Redis a logged-out token is only refused by the process that handled the logout. |
| `CORS_ORIGIN` | yes | The panel's own `https://` origin only. |
| `RADIUS_DATABASE_URL`, `RADIUS_SERVER_IP` | yes for RADIUS | See `docs/RADIUS_VAULT.md` and `docs/RADIUS_TENANCY.md`. |
| `SMTP_*`, `SMS_GATEWAY_*` | optional | Unset means notifications are stored as **SIMULATED**, never shown as sent. |
| `BACKUP_*` | see §6 | |

There are ~200 optional tuning variables; list them with
`grep -rhoE "process\.env\.[A-Z0-9_]+" backend/src | sort -u`.

## 4. Reverse proxy and HTTPS

`scripts/setup-https.sh` configures Nginx + Let's Encrypt. Serve the panel only
over HTTPS; set `FORCE_HTTPS=true`. The API trusts exactly one proxy hop
(`trust proxy` = 1), so do not put a second proxy in front without changing it,
or rate limits and login lock-outs will key on the proxy's address.

## 5. Firewall (minimum)

From `scripts/firewall.sh`:

| Port | Open to |
|---|---|
| 22/tcp | your admin IPs only (`SSH_ALLOW`) |
| 80/tcp, 443/tcp | everyone (panel, certificate renewal) |
| 1812/udp, 1813/udp | **only your NAS/router IPs** — RADIUS is a common amplification target |
| 5432, 6379 | never public; localhost only |

## 6. Backups and restore

**What happens:** every night at 02:00 the primary API process runs
`pg_dump -Fc` into `BACKUP_DIR` (default `/var/backups/jointbox`), then
**verifies** the file with `pg_restore --list`, writes `<file>.sha256`, copies
it off-site if `BACKUP_UPLOAD_CMD` is set, and prunes dumps older than
`BACKUP_RETAIN_DAYS`. A dump that fails verification is deleted and the run is
reported as failed. Requires the `postgresql-client` package.

**What it does not cover:** `backend/.env` (above all `SECRETS_KEY` and
`JWT_SECRET`), `/etc/freeradius`, Nginx config and certificates. Copy these
separately to an encrypted location; the database alone cannot restore stored
RADIUS secrets without `SECRETS_KEY`.

**Restore drill (do this before the pilot, on a disposable database — never on
production):**

```bash
sha256sum -c /var/backups/jointbox/jointbox-<stamp>.dump.sha256
createdb jointbox_restore_test
pg_restore -h 127.0.0.1 -U <user> -d jointbox_restore_test --clean --if-exists --no-owner \
  /var/backups/jointbox/jointbox-<stamp>.dump
psql -d jointbox_restore_test -c 'SELECT count(*) FROM "Subscriber"; SELECT count(*) FROM "Invoice";'
dropdb jointbox_restore_test
```

The same flow is automated in `backend/test/integration/backup-restore.integration.spec.ts`
(real `BackupService.run()` → restore into a second throwaway database → data compared).

**Real restore (disaster):** stop the API (`pm2 stop all`), restore into the
production database with the command the panel shows under Settings → Backups,
restore `.env` with the original `SECRETS_KEY`, `pm2 start all`, then check §8.

## 7. Updating and rolling back

```bash
cd /opt/jointbox && sudo bash update-jointbox.sh
```

The script refuses to continue if the git pull fails, runs `prisma migrate
deploy` and stops on any failed migration, leaving the previous build running.

**Before every update:** take a manual backup (Settings → Backups → Back up
now, or `POST /backup/run` as the platform account) and note
the current commit: `git -C /opt/jointbox rev-parse HEAD`.

**Rollback of code:** `git -C /opt/jointbox checkout <previous-commit>` then
rebuild with the update script's build steps. **Rollback of a migration:**
Prisma has no down-migrations; roll back by restoring the pre-update backup
(§6). For a migration recorded as failed (`P3009`), see
`docs/MIGRATIONS-FRESH-INSTALL.md` — do not use `db push` or `migrate reset` on
production.

## 8. Health checks and logs

| Check | Meaning |
|---|---|
| `GET /health/live` | the process is up |
| `GET /health/ready` | database reachable and Redis healthy (when required); `not_ready` otherwise |
| `GET /health` | build id, to confirm the new code is live after an update |
| `pm2 status`, `pm2 logs backend --lines 200` | process state and recent errors |
| `scripts/smoke-test.sh` | end-to-end smoke test after install/update |

Logs never contain RADIUS secrets, JWTs, or notification bodies; recipients in
simulated-delivery logs are masked.

## 9. First company

1. Sign in as the platform account (`ADMIN_EMAIL`), change the password.
2. Companies → New company: company name, **owner email** (stored lower-case,
   which is how sign-in looks it up) and password.
3. Sign in as that owner in a private window to confirm. If it fails, Logs →
   login logs shows "User not found" (email) or "Invalid credentials" (password).

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| PPPoE users rejected | `docs/RADIUS_VAULT.md` status/cutover; router IP matches the NAS entry; secret matches; `freeradius -XC` |
| Router shows "sync failed" | NAS page per-router status; the vault keeps the last good client file on a failed `-XC` check |
| Gateway payment not marked paid | Payment Gateways → transactions: signature failures are refused by design; check the gateway's secret/salt |
| Invoice credited twice | Should not happen since this branch (single claim per gateway transaction); report with the transaction reference |
| Notifications "SIMULATED" | SMTP/SMS not configured — this is the honest status, not a failure |
| Licence banner "agent not running" | `systemctl status jointbox-licensed`; nothing is blocked while it is down, but renewal stops |

## 11. Pilot checklist

- [ ] Separate production server; `.env` not in git; `SECRETS_KEY` backed up
- [ ] HTTPS working; RADIUS ports limited to NAS IPs
- [ ] Redis running and `REDIS_REQUIRED=true`
- [ ] Restore drill (§6) completed on a disposable database — record the date
- [ ] Off-site backup command set and one upload confirmed
- [ ] One test company, one test router in a lab, one test PPPoE subscriber authenticated end to end
- [ ] RADIUS policy left in **monitor** until the pilot ISP confirms (enforcement is a separate, explicit step)
- [ ] Rollback point recorded (commit + backup file) before go-live
