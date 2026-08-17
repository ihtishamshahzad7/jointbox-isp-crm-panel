-- Device health + per-interface time-series for the NOC graphs.
CREATE TABLE IF NOT EXISTS "device_metric" (
  "id"     SERIAL PRIMARY KEY,
  "nasId"  INTEGER NOT NULL,
  "ts"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metric" VARCHAR(24) NOT NULL,
  "value"  DOUBLE PRECISION NOT NULL,
  CONSTRAINT "device_metric_nasId_fkey" FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "device_metric_nasId_metric_ts_idx" ON "device_metric"("nasId", "metric", "ts");

CREATE TABLE IF NOT EXISTS "interface_metric" (
  "id"          SERIAL PRIMARY KEY,
  "nasId"       INTEGER NOT NULL,
  "ifIndex"     INTEGER NOT NULL,
  "name"        VARCHAR(96) NOT NULL,
  "ts"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rxBps"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txBps"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "inErrors"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "outErrors"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "inDiscards"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "outDiscards" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "up"          BOOLEAN NOT NULL DEFAULT true,
  "speedMbps"   INTEGER,
  CONSTRAINT "interface_metric_nasId_fkey" FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "interface_metric_nasId_ifIndex_ts_idx" ON "interface_metric"("nasId", "ifIndex", "ts");
CREATE INDEX IF NOT EXISTS "interface_metric_ts_idx" ON "interface_metric"("ts");
