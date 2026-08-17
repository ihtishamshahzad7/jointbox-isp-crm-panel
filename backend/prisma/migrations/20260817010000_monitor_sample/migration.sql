-- Persisted per-check history behind the monitoring charts.
CREATE TABLE IF NOT EXISTS "monitor_sample" (
  "id"        SERIAL PRIMARY KEY,
  "targetId"  INTEGER NOT NULL,
  "at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "up"        BOOLEAN NOT NULL,
  "latencyMs" DOUBLE PRECISION,
  "lossPct"   DOUBLE PRECISION,
  CONSTRAINT "monitor_sample_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "monitor_target"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "monitor_sample_targetId_at_idx" ON "monitor_sample"("targetId", "at");
