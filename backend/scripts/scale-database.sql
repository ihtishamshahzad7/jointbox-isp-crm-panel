-- ============================================================================
--  Jointbox — database scaling pass
--  Target: 200+ NAS, hundreds of thousands of subscribers
--
--  Run:  sudo -u postgres psql -d jointbox -f scale-database.sql
--  Safe to re-run. Does NOT move existing data (see PARTITIONING note below).
-- ============================================================================

\timing on

-- ---------------------------------------------------------------------------
-- 1. INDEXES ON THE HOT PATHS
--    Without these, every query below degrades from an index seek to a full
--    scan of a table that grows by millions of rows a year.
-- ---------------------------------------------------------------------------

-- "Who is online right now" — a partial index, so it stays small no matter how
-- large radacct grows. This is the single most valuable index in the system.
CREATE INDEX IF NOT EXISTS radacct_open_sessions_idx
  ON radacct (username, nasipaddress)
  WHERE acctstoptime IS NULL;

-- Stale-session sweep and freshness checks.
CREATE INDEX IF NOT EXISTS radacct_open_updated_idx
  ON radacct (acctupdatetime)
  WHERE acctstoptime IS NULL;

-- Per-subscriber session history (the Session Log tab).
CREATE INDEX IF NOT EXISTS radacct_user_time_idx
  ON radacct (username, acctstarttime DESC);

-- Per-NAS reconciliation.
CREATE INDEX IF NOT EXISTS radacct_nas_idx
  ON radacct (nasipaddress, acctstarttime DESC);

-- Auth log lookups.
CREATE INDEX IF NOT EXISTS radpostauth_user_date_idx
  ON radpostauth (username, authdate DESC);
CREATE INDEX IF NOT EXISTS radpostauth_date_idx
  ON radpostauth (authdate DESC);

-- radcheck/radreply are read on EVERY authentication — at 200 NAS this is the
-- highest-frequency query in the entire system.
CREATE INDEX IF NOT EXISTS radcheck_username_idx ON radcheck (username);
CREATE INDEX IF NOT EXISTS radreply_username_idx ON radreply (username);

-- Panel-side hot paths.
CREATE INDEX IF NOT EXISTS subscriber_owner_idx    ON "Subscriber" ("userId");
CREATE INDEX IF NOT EXISTS subscriber_nas_idx      ON "Subscriber" ("nasId");
CREATE INDEX IF NOT EXISTS subscriber_username_idx ON "Subscriber" (username);
CREATE INDEX IF NOT EXISTS user_parent_idx         ON "User" ("parentId");
CREATE INDEX IF NOT EXISTS ubt_user_ref_idx        ON "UserBalanceTransaction" ("userId", reference);

\echo '✔ Indexes ensured'

-- ---------------------------------------------------------------------------
-- 2. ARCHIVAL — keep radacct lean
--    Closed sessions older than the retention window move to radacct_archive.
--    Reports still work (query the archive), but the live table stays fast.
-- ---------------------------------------------------------------------------

-- NOTE: the archive lives in its own schema on purpose. Prisma manages
-- `public` and drops anything there that isn't a model — a table named
-- public.radacct_archive would be destroyed by the next `prisma db push`.
CREATE SCHEMA IF NOT EXISTS archive;
CREATE TABLE IF NOT EXISTS archive.radacct (LIKE public.radacct INCLUDING DEFAULTS);

CREATE OR REPLACE FUNCTION archive_radacct(retain_days int DEFAULT 90)
RETURNS bigint AS $$
DECLARE moved bigint;
BEGIN
  WITH cut AS (
    DELETE FROM public.radacct
     WHERE acctstoptime IS NOT NULL
       AND acctstoptime < NOW() - (retain_days || ' days')::interval
    RETURNING *
  )
  INSERT INTO archive.radacct SELECT * FROM cut;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION archive_radacct IS
  'Move closed sessions older than N days into radacct_archive. Run nightly.';

\echo '✔ Archive table + archive_radacct(days) created'

-- ---------------------------------------------------------------------------
-- 3. AUTOVACUUM — radacct is update-heavy
--    Every interim update rewrites a row. Default autovacuum thresholds are far
--    too lax for this, letting dead tuples bloat the table and slow every read.
-- ---------------------------------------------------------------------------
ALTER TABLE radacct SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_limit    = 2000
);
ALTER TABLE radpostauth SET (autovacuum_vacuum_scale_factor = 0.05);

\echo '✔ Autovacuum tuned for high-churn tables'

-- ---------------------------------------------------------------------------
-- 4. HOUSEKEEPING
-- ---------------------------------------------------------------------------
ANALYZE radacct;
ANALYZE radpostauth;
ANALYZE "Subscriber";
ANALYZE "User";

\echo ''
\echo '════════════ CURRENT SIZE ════════════'
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       n_live_tup AS rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;

\echo ''
\echo 'Next steps (not automated — they need a maintenance window):'
\echo '  • Nightly archival:  psql -d jointbox -c "SELECT archive_radacct(90);"'
\echo '  • PARTITIONING: once radacct passes ~50M rows, convert it to a'
\echo '    RANGE-partitioned table on acctstarttime (monthly). That requires'
\echo '    recreating the table and copying data, so plan downtime.'
