# Scaling Jointbox to 200+ NAS

What's been done in code, and what you must do in infrastructure. In priority
order — each step is worth more than the one after it.

---

## What changed in the application

### NAS polling is now parallel and split into two cycles

Previously every router was polled **sequentially**, and each one took ~5s
(UDP probes + a full `syncDetails` API call). Six routers filled the entire
30-second budget; ten meant permanently overlapping cycles.

Now:

| Cycle | Default | Does | Cost per router |
|---|---|---|---|
| **Fast** | 30s | live sessions, byte counters, stale cleanup | one cheap API call (~200–300 ms) |
| **Health** | 5 min | reachability probes, full `syncDetails` | ~5 s |

Both run with a bounded worker pool (default **20 concurrent**), and each router
call has a hard timeout so one hung socket can't stall the sweep. Cycles are
re-entrancy guarded — a slow sweep is skipped rather than stacked, and a warning
is logged when a cycle uses >80 % of its budget.

**200 routers × ~300 ms at 20-wide ≈ 3 s per fast sweep**, versus ~17 minutes
sequentially.

Tune in `.env`:

```env
NAS_FAST_POLL_MS=30000       # live session refresh
NAS_SLOW_POLL_MS=300000      # health sweep
NAS_POLL_CONCURRENCY=20      # raise to 40–50 on a strong server
```

### `users.findAll` N+1 removed

Was 4 count queries **per user** (100 users = 400 round trips). Now 4 grouped
queries for the whole page, regardless of user count.

---

## Infrastructure — do these in order

### 1. Move the backend onto the VM (biggest single win)

Today the backend runs on Windows and Postgres is on `192.168.1.96`. **Every
Prisma query crosses the network.** A page doing 50 queries pays 50 network
round trips. Co-locating them removes that entirely, and as a bonus makes
`systemctl reload freeradius` work, so NAS changes apply without SSH.

```bash
# on the VM
sudo apt install -y nodejs npm
git clone <your repo> /opt/jointbox && cd /opt/jointbox/backend
npm ci && npx prisma generate && npm run build
sudo npm i -g pm2
pm2 start dist/main.js -i max --name jointbox-api   # cluster mode, all cores
pm2 save && pm2 startup
```

`-i max` runs one worker per CPU core — this is also what makes Redis
mandatory below, since workers can no longer share in-process state.

### 2. Connection pool + PgBouncer

Your pool is currently **10** — you already hit `P2024: Timed out fetching a
connection`. With clustered workers you need far more, but Postgres itself
shouldn't hold hundreds of direct connections.

```env
DATABASE_URL="postgresql://jointbox:pass@127.0.0.1:6432/jointbox?connection_limit=25&pool_timeout=30&pgbouncer=true"
```

```bash
sudo apt install -y pgbouncer
# /etc/pgbouncer/pgbouncer.ini
#   pool_mode = transaction
#   max_client_conn = 1000
#   default_pool_size = 40
```

`pool_mode = transaction` is what lets hundreds of app connections share a few
dozen real Postgres ones.

### 3. Redis — cache + real queues

Startup currently logs `Cache: in-memory mode` and `Queue: inline mode`. In-memory
cache is per-process (wrong once clustered), and "inline" means background jobs
run inside the request that triggered them.

```bash
sudo apt install -y redis-server
```
```env
REDIS_URL=redis://127.0.0.1:6379
```

The app already supports both — this is configuration, not code.

### 4. Database indexes, archival, autovacuum

```bash
sudo -u postgres psql -d jointbox -f scale-database.sql
```

Adds partial indexes for the online-session queries, an archive table, and
tighter autovacuum for the update-heavy `radacct`.

Then schedule nightly archival:

```cron
0 3 * * * psql -U jointbox -d jointbox -c "SELECT archive_radacct(90);"
```

### 5. FreeRADIUS for scale

```
# /etc/freeradius/3.0/radiusd.conf
thread pool {
    start_servers    = 32
    max_servers      = 256
    max_requests_per_server = 0
}
```
```
# mods-enabled/sql
pool { start = 16   min = 8   max = 128   spare = 16 }
```

FreeRADIUS itself handles thousands of auths/sec; the SQL pool is the limit.

---

## Realistic capacity

| Config | NAS | Subscribers | Concurrent online |
|---|---|---|---|
| Today (Windows backend, no Redis) | ~6 | ~1 k | ~500 |
| + parallel polling (code, done) | ~50 | ~1 k | ~500 |
| + steps 1–4 | **200+** | **200–500 k** | **50–100 k** |
| Beyond that | needs read replicas, sharding, multiple RADIUS nodes |

**Being straight about the ceiling:** several hundred thousand subscribers on
one well-tuned Postgres is realistic. Millions is not a tuning exercise — it
needs horizontal sharding, regional RADIUS clusters, and read replicas, which is
an architecture project rather than a configuration change.

## Watch these as you grow

```sql
-- Cache hit ratio — should stay above 0.99
SELECT sum(blks_hit)::float/nullif(sum(blks_hit+blks_read),0) FROM pg_stat_database;

-- Slowest statements (needs pg_stat_statements)
SELECT calls, round(mean_exec_time::numeric,1) AS avg_ms, query
FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;

-- Table bloat / dead tuples
SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

In the app log, watch for `Fast cycle took …ms of a 30000ms budget` — that is
your early warning to raise `NAS_POLL_CONCURRENCY` or lengthen the interval.
