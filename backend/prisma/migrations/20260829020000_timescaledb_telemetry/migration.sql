-- TimescaleDB hypertables for the telemetry series.
--
-- monitor_sample and device_health_metric are append-heavy time series: written
-- constantly by the pollers, read as ranges, pruned in bulk by
-- retention.service.ts. That is exactly the shape a hypertable is for — it
-- partitions by time so a range query touches only the relevant chunks and a
-- prune drops whole chunks instead of deleting rows one at a time.
--
-- ── TWO PARTS, AND ONLY ONE OF THEM IS CONDITIONAL ─────────────────────────
--
-- PART 1 (always runs) — widen the primary key to include the time column.
--   A hypertable requires its partitioning column in every UNIQUE index. This
--   runs unconditionally, even on servers without TimescaleDB, because
--   schema.prisma has to describe ONE shape: db-deploy.sh runs `prisma db push`
--   right after `migrate deploy`, and if the model and the database disagreed
--   about the primary key, push would revert it on every deploy — silently
--   undoing the hypertable on the servers that do have TimescaleDB.
--   On a plain server a composite (id, at) key is harmless: id is still a
--   sequence, so uniqueness is unchanged.
--
--   Safe because nothing looks these rows up by id — the code only ever calls
--   create / createMany / findMany / deleteMany on them (verified across src/).
--
-- PART 2 (guarded) — create the hypertables, only where TimescaleDB exists.
--   It is a compiled extension needing a package and shared_preload_libraries,
--   which most existing Jointbox servers do not have. An update must never
--   fail because of an optional performance feature, so this becomes a clean
--   no-op there and the tables keep working as ordinary tables.

-- ── PART 1 ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'monitor_sample'::regclass AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE "monitor_sample" DROP CONSTRAINT "monitor_sample_pkey";
    ALTER TABLE "monitor_sample" ADD PRIMARY KEY ("id", "at");
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'device_health_metric'::regclass AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE "device_health_metric" DROP CONSTRAINT "device_health_metric_pkey";
    ALTER TABLE "device_health_metric" ADD PRIMARY KEY ("id", "ts");
  END IF;
END $$;

-- ── PART 2 ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RAISE NOTICE 'TimescaleDB not installed — telemetry tables remain ordinary tables. Everything works; only query plans differ.';
    RETURN;
  END IF;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  EXCEPTION WHEN OTHERS THEN
    -- Usually: absent from shared_preload_libraries, or not superuser.
    RAISE NOTICE 'TimescaleDB present but could not be enabled (%) — skipping hypertable setup.', SQLERRM;
    RETURN;
  END;

  -- migrate_data moves existing rows into chunks, so this works on a server
  -- that has already been collecting telemetry for months.
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'monitor_sample') THEN
    PERFORM create_hypertable('monitor_sample', 'at', migrate_data => true, if_not_exists => true);
    RAISE NOTICE 'monitor_sample is now a hypertable.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_health_metric') THEN
    PERFORM create_hypertable('device_health_metric', 'ts', migrate_data => true, if_not_exists => true);
    RAISE NOTICE 'device_health_metric is now a hypertable.';
  END IF;

-- Deliberately NO add_retention_policy(): retention.service.ts already prunes
-- these on the operator's configured window. Two retention mechanisms
-- disagreeing about how much history to keep is worse than one, and the
-- app-level one is the one the operator can see and change from the panel.
END $$;
