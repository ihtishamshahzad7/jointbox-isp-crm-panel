-- ===================================================================
--  Jointbox — scale.sql
--  Hot indexes + accounting archival for large deployments (~100k active).
--  SAFE to run on a live database. Idempotent (CREATE ... IF NOT EXISTS).
--  Apply after `prisma migrate deploy`:
--     psql "$DATABASE_URL" -f prisma/sql/scale.sql
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. PARTIAL INDEXES on the "live sessions" hot path.
--    The dashboard / getActiveSessions query is:
--        SELECT ... FROM radacct WHERE acctstoptime IS NULL
--    With millions of historical (closed) rows, a plain index still
--    scans them. A PARTIAL index only covers OPEN sessions, so the
--    live-network query stays instant no matter how much history exists.
-- -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_radacct_open_username
  ON radacct (username) WHERE acctstoptime IS NULL;

CREATE INDEX IF NOT EXISTS idx_radacct_open_nasip
  ON radacct (nasipaddress) WHERE acctstoptime IS NULL;

CREATE INDEX IF NOT EXISTS idx_radacct_open_starttime
  ON radacct (acctstarttime DESC) WHERE acctstoptime IS NULL;

-- FreeRADIUS closes/updates a session by acctuniqueid — already UNIQUE,
-- so interim-updates stay O(1). Composite helps username history lookups:
CREATE INDEX IF NOT EXISTS idx_radacct_user_start
  ON radacct (username, acctstarttime DESC);

-- radpostauth is written on every auth; index for the 24h stats query:
CREATE INDEX IF NOT EXISTS idx_radpostauth_authdate
  ON radpostauth (authdate DESC);

-- -------------------------------------------------------------------
-- 2. ARCHIVAL of old CLOSED accounting rows.
--    Keeps the live radacct table small (only recent + open sessions),
--    which keeps writes, autovacuum and dashboard reads fast.
--    Closed sessions older than the cutoff move to radacct_archive.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS radacct_archive (LIKE radacct INCLUDING ALL);

CREATE OR REPLACE FUNCTION archive_old_radacct(months_to_keep int DEFAULT 3)
RETURNS bigint AS $$
DECLARE
  moved bigint;
BEGIN
  WITH cutoff AS (SELECT now() - (months_to_keep || ' months')::interval AS ts),
  moved_rows AS (
    DELETE FROM radacct
    WHERE acctstoptime IS NOT NULL
      AND acctstoptime < (SELECT ts FROM cutoff)
    RETURNING *
  )
  INSERT INTO radacct_archive SELECT * FROM moved_rows;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$ LANGUAGE plpgsql;

-- Run monthly (e.g. via cron / pg_cron):
--     SELECT archive_old_radacct(3);   -- keep 3 months live, archive the rest

-- -------------------------------------------------------------------
-- 3. Make autovacuum aggressive on the churny tables (per-table).
--    radacct/radpostauth get huge insert/update/delete churn; default
--    autovacuum lags and bloats them. Tighten the thresholds.
-- -------------------------------------------------------------------
ALTER TABLE radacct  SET (autovacuum_vacuum_scale_factor = 0.02,
                          autovacuum_analyze_scale_factor = 0.01,
                          autovacuum_vacuum_cost_limit = 2000);
ALTER TABLE radpostauth SET (autovacuum_vacuum_scale_factor = 0.05,
                          autovacuum_analyze_scale_factor = 0.02);

ANALYZE radacct;
ANALYZE radpostauth;

-- ===================================================================
--  OPTIONAL (maintenance window) — NATIVE RANGE PARTITIONING of radacct.
--  This is the "textbook" answer for very large history. It requires a
--  table rewrite, so do it in a maintenance window, not live. Steps:
--
--   1. Rename current table:   ALTER TABLE radacct RENAME TO radacct_old;
--   2. Recreate as partitioned by acctstarttime, PK (radacctid, acctstarttime):
--        CREATE TABLE radacct (LIKE radacct_old INCLUDING DEFAULTS INCLUDING IDENTITY)
--          PARTITION BY RANGE (acctstarttime);
--        -- add UNIQUE/PK including the partition key:
--        ALTER TABLE radacct ADD PRIMARY KEY (radacctid, acctstarttime);
--   3. Create monthly partitions, e.g.:
--        CREATE TABLE radacct_2026_07 PARTITION OF radacct
--          FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
--      (script one per month, plus a DEFAULT partition for safety)
--   4. Copy data:  INSERT INTO radacct SELECT * FROM radacct_old;
--   5. Drop radacct_old once verified.
--
--  For 100k active users, the SAFE section (partial indexes + monthly
--  archival) already keeps the live table small — partitioning is only
--  needed if you must retain years of raw accounting online.
-- ===================================================================
