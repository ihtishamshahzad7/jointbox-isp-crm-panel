# Jointbox — Scaling to 100,000 Active Users

This is the architecture and the exact steps to run Jointbox for **~1 lakh (100,000)
concurrent PPPoE sessions** with headroom. Everything referenced here ships in the repo:
`backend/prisma/sql/scale.sql`, `deploy/tuning/*`, `deploy/scripts/*`.

The core idea: **the data plane (PPPoE) lives on your routers; this stack only
authenticates, accounts, and reports.** So scaling is about (1) not exhausting the
database, (2) keeping the accounting table fast forever, and (3) removing single points
of failure. Do the four things below and 100k is comfortable.

---

## The bottleneck map (where load actually lands)

| Component        | What it does at 100k          | Load                              | Fix |
|------------------|-------------------------------|-----------------------------------|-----|
| MikroTik / NAS   | Terminates PPPoE data plane   | Real ceiling — per-router CPU/RAM | Right-size routers; spread users across NASes |
| FreeRADIUS       | Auth at connect, acct updates | Light — reacts to *rate*, not count | Run 2+ instances (HA), direct to Postgres |
| PostgreSQL       | Stores radacct + billing      | Write-heavy from interim updates  | PgBouncer + tuning + partial indexes + archival |
| Node backend     | Panel, live polling, sync     | Read polling + provisioning       | Redis cache, queue pipeline, PgBouncer |

At 100k users, a single well-tuned DB box + PgBouncer + 2 FreeRADIUS nodes handles it.
The numbers that matter: with a **600s interim-update interval**, 100k users generate
only ~**167 accounting writes/sec** — trivial for a tuned Postgres. Auth happens once per
connect, so even a reconnect storm is thousands/sec, which FreeRADIUS eats easily.

---

## Step 0 — pm2 cluster mode (use every CPU core)

By default the backend runs as ONE process = one core. To use the whole box, run
it in **cluster mode** — pm2 forks N identical workers and load-balances requests
across them. The `ecosystem.config.js` reads two env vars:

```bash
# On the server, before ./update-jointbox.sh (or export in the shell):
export BACKEND_INSTANCES=max     # or a number, e.g. 4
export FRONTEND_INSTANCES=2
pm2 startOrReload ecosystem.config.js && pm2 save
```

`max` = one worker per core. This is **safe** because the app was made
cluster-aware:
- **Crons run on worker 0 only** (`isPrimaryInstance()` / `NODE_APP_INSTANCE`), so
  reminders, reconciles and session-syncs don't fire N times.
- **The background-job queue claims each job atomically** (`QUEUED→RUNNING`), so two
  workers never run the same job.
- **In-flight guards** stop any cron from overlapping itself under load.

BEFORE you cluster the backend:
1. Set **`REDIS_URL`** in `backend/.env` so the cache and job queue are SHARED across
   workers (without it each worker caches separately — correct, just less efficient).
2. Put Postgres behind **PgBouncer** (Step 1) — each worker opens its own pool
   (`connection_limit=10`), so 4 workers = 40 connections; pooling avoids exhausting
   Postgres `max_connections`.
Set `CRON_DISABLED=true` on any extra/standby box that should never run scheduled work.

---

## Step 1 — PgBouncer (the single most important change)

100k sessions must NEVER become 100k database connections. PgBouncer (transaction mode)
multiplexes thousands of app clients onto ~150 real backends.

```bash
sudo apt install -y pgbouncer
sudo cp deploy/tuning/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
sudo cp deploy/tuning/pgbouncer.userlist.example /etc/pgbouncer/userlist.txt   # edit creds
sudo systemctl enable --now pgbouncer
```

Point the **Node app** at PgBouncer (port 6432), leave **FreeRADIUS** on 5432:

```
DATABASE_URL="postgresql://jointbox:jointbox123@localhost:6432/jointbox?pgbouncer=true&connection_limit=1"
```

`pgbouncer=true` tells Prisma to disable prepared statements (required for transaction pooling).

---

## Step 2 — Tune PostgreSQL + add the hot indexes

```bash
# tuning (sized for ~32GB DB box — scale with your RAM, see the file header)
sudo cp deploy/tuning/postgresql-jointbox.conf /etc/postgresql/16/main/conf.d/
sudo systemctl restart postgresql

# partial indexes on live sessions + archival function + aggressive autovacuum
psql "postgresql://jointbox:jointbox123@localhost:5432/jointbox" -f backend/prisma/sql/scale.sql
```

The **partial indexes** are what keep the live-network dashboard instant even after the
`radacct` table has tens of millions of historical rows — the "who's online" query only
touches open sessions.

Schedule monthly archival so the live table never bloats (keep 3 months hot):

```bash
sudo crontab -e
# 3rd of each month, 03:00 — move closed sessions older than 3 months to radacct_archive
0 3 3 * *  psql "$DATABASE_URL" -c "SELECT archive_old_radacct(3);"
```

---

## Step 3 — Raise the accounting interim interval (huge write reduction)

Write load = `users ÷ interim-interval`. Longer interval = far fewer writes, same billing
accuracy (final totals arrive on session stop).

On the **MikroTik** PPP profile, or via `radreply` attribute `Acct-Interim-Interval`:

- 100k users @ 300s  → ~333 writes/sec
- 100k users @ 600s  → ~167 writes/sec  ← recommended
- 100k users @ 900s  → ~111 writes/sec

600s is the sweet spot: live dashboard stays fresh enough, DB write load is tiny.

---

## Step 4 — Provision on a pipeline, not inline (Redis + BullMQ)

Bulk operations (syncing/rebuilding all 100k RADIUS profiles, sending notices) must run
through the **queue**, never inline on a request. The app already has this — just make sure
Redis is on:

```
REDIS_URL="redis://localhost:6379"
```

Then use the queued endpoints (non-blocking, processed in a pipeline with retries):

- `POST /subscribers/sync-all-to-radius/queue` — rebuild every RADIUS profile
- `POST /subscribers/sync-missing-to-radius/queue` — only the ones missing
- Track progress: `GET /subscribers/sync-jobs/:jobId`

With Redis set, caching and BullMQ switch on automatically (Phase 0). Without it the app
still runs but does this work inline — fine for small sites, not for 100k.

---

## Step 5 — Remove single points of failure (HA)

**Two FreeRADIUS nodes.** Auth outage = every customer offline, so never run one.
Install FreeRADIUS on a second box, point its SQL module at the same Postgres (or a read
replica), and set BOTH as RADIUS servers on each MikroTik (primary + secondary). If one
dies, routers fail over automatically.

**PostgreSQL hot standby.** Set up streaming replication (the tuning file already enables
`wal_level=replica` and WAL senders). If the primary dies you promote the replica in
seconds instead of restoring last night's dump.

**Backups off the box.**
```bash
sudo cp deploy/scripts/backup.sh /usr/local/bin/jointbox-backup && sudo chmod +x $_
# set JOINTBOX_BACKUP_RSYNC or JOINTBOX_BACKUP_S3, then cron it nightly
sudo crontab -e   # 15 2 * * *  /usr/local/bin/jointbox-backup
```

**Monitoring.**
```bash
sudo cp deploy/scripts/health-monitor.sh /usr/local/bin/jointbox-health && sudo chmod +x $_
# set TG_TOKEN/TG_CHAT for Telegram alerts, then:
sudo crontab -e   # */2 * * * *  /usr/local/bin/jointbox-health
```

---

## Reference topology for 100k

```
                         ┌──────────────┐
   MikroTik routers ───▶ │ FreeRADIUS #1 │ ─┐
   (PPPoE data plane)    └──────────────┘  │   direct :5432
                         ┌──────────────┐  ├──▶ ┌─────────────────┐      ┌──────────────┐
                    ───▶ │ FreeRADIUS #2 │ ─┘    │  PostgreSQL      │ ───▶ │ hot standby   │
                         └──────────────┘        │  (primary,       │ WAL  │ replica       │
                                                 │   tuned)         │      └──────────────┘
   Admins / portal  ───▶ ┌──────────────┐        └─────────────────┘
                         │ Node app +   │ ─ PgBouncer :6432 ─▶ (same primary)
                         │ Redis        │
                         └──────────────┘
```

Start single-box (all roles together) — it already handles well into the tens of
thousands. Split PostgreSQL onto its own box past ~30–40k, add the second FreeRADIUS and
the replica as you approach 100k. Nothing in the app changes — only connection strings.

---

## Capacity sanity check (100k @ 600s interim)

- DB writes: ~167/sec accounting + occasional billing → tuned Postgres idles.
- DB connections: capped at ~150 backends via PgBouncer regardless of client count.
- Live table: kept to ~3 months of sessions by archival → dashboard queries stay <50ms.
- Auth: bursty at reconnects (thousands/sec) → 2 FreeRADIUS nodes absorb it.
- Provisioning: 100k profile rebuild runs in the background queue, not on a request.

The hard ceiling you'll hit first is **router capacity for the PPPoE data plane**, not this
software stack.
