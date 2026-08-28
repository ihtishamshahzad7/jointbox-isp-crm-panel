-- Outage Intelligence: persist root-cause attribution for each outage.
--
-- Every outage (automatic MASS_DISCONNECT, scheduled, or manual) now carries a
-- stored root cause inferred by correlating device-level (NDM) signals against
-- the outage window. This table is the persisted output of that inference, so
-- the operator can confirm or correct it and the uptime report can honestly
-- separate "our network fault" (NETWORK_DEVICE / PORT) from "WAPDA" (POWER) or
-- "subscriber equipment" (ACCESS).
--
-- PURELY ADDITIVE and safe to run on a live database: one new enum type, one
-- new table, and a cascade FK back to PowerOutage. No existing row or column is
-- touched, so there is nothing to backfill. The FK is on outage_attribution
-- (one attribution per outage, @unique), not on PowerOutage — the owning side
-- carries the relation, matching schema.prisma.

-- 1. The root-cause enum. Prisma maps each model field to this Postgres type;
--    values exactly mirror `enum OutageCause` in schema.prisma.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutageCause') THEN
    CREATE TYPE "OutageCause" AS ENUM ('NETWORK_DEVICE', 'PORT', 'POWER', 'ACCESS', 'UNKNOWN');
  END IF;
END $$;

-- 2. The table. Column names / types / defaults mirror `model OutageAttribution`.
CREATE TABLE IF NOT EXISTS "outage_attribution" (
    "id"         SERIAL PRIMARY KEY,
    "outageId"   INTEGER NOT NULL,
    -- Inferred root cause (OutageCause). Default UNKNOWN = not enough signal.
    "cause"      "OutageCause" NOT NULL DEFAULT 'UNKNOWN',
    -- 0-100. How strongly the coincident signals support this cause.
    "confidence" INTEGER NOT NULL DEFAULT 0,
    -- Short human label, e.g. "NAS-CCR-01 unreachable since 09:42".
    "summary"    VARCHAR(240),
    -- JSON array of coincident signals this inference rests on.
    "evidence"   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Implicated device ids (subset of evidence).
    "deviceIds"  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Operator has confirmed or manually corrected the inference.
    "confirmed"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outage_attribution_outageId_fkey"
      FOREIGN KEY ("outageId") REFERENCES "PowerOutage"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- One attribution per outage.
CREATE UNIQUE INDEX IF NOT EXISTS "outage_attribution_outageId_key"
  ON "outage_attribution"("outageId");

-- Helpful lookups: the outage list filters by cause, and triage sweeps
-- unconfirmed rows.
CREATE INDEX IF NOT EXISTS "outage_attribution_cause_idx"
  ON "outage_attribution"("cause");
CREATE INDEX IF NOT EXISTS "outage_attribution_confirmed_idx"
  ON "outage_attribution"("confirmed");
