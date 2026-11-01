-- Stage 2 — per-NAS SNMP monitoring state & events.
-- Additive and safe on a live database: two new tables, no change to existing
-- tables or data. All objects use IF NOT EXISTS so a re-run is a no-op.
--
-- Rollback:
--   DROP TABLE IF EXISTS "nas_event";
--   DROP TABLE IF EXISTS "nas_snmp_state";

-- ── Per-NAS operational state (1:1 with nas) ────────────────────────────────
CREATE TABLE IF NOT EXISTS "nas_snmp_state" (
  "nasId"               INTEGER      NOT NULL,
  "status"              VARCHAR(20)  NOT NULL DEFAULT 'unknown',
  "lastPollAt"          TIMESTAMP(3),
  "lastSuccessAt"       TIMESTAMP(3),
  "lastErrorAt"         TIMESTAMP(3),
  "lastError"           VARCHAR(300),
  "consecutiveFailures" INTEGER      NOT NULL DEFAULT 0,
  "nextPollAt"          TIMESTAMP(3),
  "sysDescr"            VARCHAR(300),
  "uptimeSec"           INTEGER,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nas_snmp_state_pkey" PRIMARY KEY ("nasId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nas_snmp_state_nasId_fkey') THEN
    ALTER TABLE "nas_snmp_state"
      ADD CONSTRAINT "nas_snmp_state_nasId_fkey"
      FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "nas_snmp_state_status_idx"     ON "nas_snmp_state" ("status");
CREATE INDEX IF NOT EXISTS "nas_snmp_state_nextPollAt_idx" ON "nas_snmp_state" ("nextPollAt");

-- ── Monitoring lifecycle events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "nas_event" (
  "id"             SERIAL       NOT NULL,
  "nasId"          INTEGER      NOT NULL,
  "type"           VARCHAR(32)  NOT NULL,
  "severity"       VARCHAR(12)  NOT NULL DEFAULT 'info',
  "message"        VARCHAR(400) NOT NULL,
  "details"        JSONB,
  "ts"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ownerId"        INTEGER,
  "acknowledged"   BOOLEAN      NOT NULL DEFAULT false,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" INTEGER,
  CONSTRAINT "nas_event_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nas_event_nasId_fkey') THEN
    ALTER TABLE "nas_event"
      ADD CONSTRAINT "nas_event_nasId_fkey"
      FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "nas_event_nasId_ts_idx"        ON "nas_event" ("nasId", "ts");
CREATE INDEX IF NOT EXISTS "nas_event_nasId_type_ts_idx"   ON "nas_event" ("nasId", "type", "ts");
CREATE INDEX IF NOT EXISTS "nas_event_acknowledged_ts_idx" ON "nas_event" ("acknowledged", "ts");
CREATE INDEX IF NOT EXISTS "nas_event_ownerId_ts_idx"      ON "nas_event" ("ownerId", "ts");
