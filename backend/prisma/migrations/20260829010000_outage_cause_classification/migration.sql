-- Outage CAUSE classification.
--
-- detect() already found outages and said whether one fell inside a published
-- load-shedding window. It could not say WHY the area was down — its own note
-- ended "verify whether this is power or network", leaving the question that
-- decides the next action (dispatch a technician, or wait for the grid) to a
-- person. These columns store the automatic verdict.
--
-- `type` (SCHEDULED/UNSCHEDULED/NETWORK) is deliberately left untouched: it
-- answers a different question and existing rows and screens depend on it.
-- An unscheduled outage can still be a power failure, so cause is orthogonal.
--
-- PURELY ADDITIVE. Every existing outage gets cause = UNKNOWN and confidence
-- 0, which reads correctly as "detected before classification existed".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutageCause') THEN
    CREATE TYPE "OutageCause" AS ENUM (
      'POWER_RELATED', 'FIBER_CUT', 'EQUIPMENT_FAILURE', 'UPSTREAM_ISP', 'UNKNOWN'
    );
  END IF;
END $$;

ALTER TABLE "PowerOutage" ADD COLUMN IF NOT EXISTS "cause" "OutageCause" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "PowerOutage" ADD COLUMN IF NOT EXISTS "causeConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PowerOutage" ADD COLUMN IF NOT EXISTS "causeReasons" VARCHAR(600);

-- "How often is it actually the grid?" is the question this module exists to
-- answer, and it is asked per area over a date range.
CREATE INDEX IF NOT EXISTS "PowerOutage_cause_startedAt_idx"
  ON "PowerOutage"("cause", "startedAt");
