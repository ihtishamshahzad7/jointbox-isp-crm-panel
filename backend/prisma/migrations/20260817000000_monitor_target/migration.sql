-- Network monitoring targets (ping/latency), owner-scoped.
CREATE TABLE IF NOT EXISTS "monitor_target" (
  "id"            SERIAL PRIMARY KEY,
  "ownerId"       INTEGER,
  "groupName"     VARCHAR(80),
  "name"          VARCHAR(120) NOT NULL,
  "host"          VARCHAR(255) NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "intervalSec"   INTEGER NOT NULL DEFAULT 30,
  "isUp"          BOOLEAN,
  "lastLatencyMs" DOUBLE PRECISION,
  "lastCheckedAt" TIMESTAMP(3),
  "downSince"     TIMESTAMP(3),
  "lossPct"       DOUBLE PRECISION,
  "history"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "monitor_target_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "monitor_target_ownerId_idx" ON "monitor_target"("ownerId");
CREATE INDEX IF NOT EXISTS "monitor_target_enabled_idx" ON "monitor_target"("enabled");
