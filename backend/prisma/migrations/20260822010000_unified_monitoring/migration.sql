-- UNIFIED MONITORING: one device = optional ICMP + SNMP + syslog.
-- Deploy note: normal path is `prisma db push` (runs the schema), and this
-- migration exists for `prisma migrate deploy` hygiene. The backfills below
-- are IDEMPOTENT and safe to run again after a db push.

-- 1) NetworkDevice: capability flags + failure thresholds.
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "enablePing"          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "enableSnmp"          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "pingIntervalSec"     INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "downAfterFails"      INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "upAfterSucceeds"     INTEGER NOT NULL DEFAULT 1;

-- Legacy NetworkDevices were all created to be SNMP-polled → default them ON.
UPDATE "network_device" SET "enableSnmp" = true, "upAfterSucceeds" = 1 WHERE "enableSnmp" = false;

-- Schema's @updatedAt column (db push adds it; migrate deploy needs it too).
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now();

-- 2) NetworkInterface: per-port alert gates (graph on, pager off).
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "alertDownEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "alertUpEnabled"   BOOLEAN NOT NULL DEFAULT true;

-- 3) MonitorTarget: the device link + ICMP thresholds.
ALTER TABLE "monitor_target" ADD COLUMN IF NOT EXISTS "failsToDown"   INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "monitor_target" ADD COLUMN IF NOT EXISTS "latencyAlertMs" INTEGER;
ALTER TABLE "monitor_target" ADD COLUMN IF NOT EXISTS "deviceId"      INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "monitor_target_deviceId_key" ON "monitor_target" ("deviceId");
ALTER TABLE "monitor_target" ADD CONSTRAINT "monitor_target_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Backfill — link legacy ping monitors to their SNMP device (same IP + same
--    owner subtree), and remember that the device now also pings.
UPDATE "monitor_target" mt SET "deviceId" = nd.id
FROM "network_device" nd
WHERE mt."deviceId" IS NULL
  AND LOWER(nd.ip) = LOWER(mt.host)
  AND (nd."ownerId" IS NOT DISTINCT FROM mt."ownerId");

UPDATE "network_device" nd SET "enablePing" = true
FROM "monitor_target" mt WHERE mt."deviceId" = nd.id AND mt."ownerId" IS NOT DISTINCT FROM nd."ownerId";

-- 5) Ping-only legacy rows (no SNMP device) get a proper unified device row.
--    Temp table keeps the INSERT deterministic; name/host must match the
--    target so step 6 re-links them.
CREATE TEMP TABLE IF NOT EXISTS _t_ping_only AS
  SELECT mt.id AS target_id, mt."name", mt.host, mt."groupName", mt."ownerId", mt.enabled,
         mt."intervalSec"
  FROM "monitor_target" mt WHERE mt."deviceId" IS NULL;

INSERT INTO "network_device" ("ownerId", "name", "ip", "vendor", "deviceType", "groupName",
    "location", "description", enabled, "pollIntervalSec", "snmpTimeoutMs", "snmpRetries",
    "interfaceCount", "upPorts", "downPorts", "syslogEnabled", "syslogProtocol", "syslogPort",
    "soundEnabled", "soundUpEnabled", "enablePing", "enableSnmp", "pingIntervalSec",
    "downAfterFails", "upAfterSucceeds", "createdAt", "updatedAt")
SELECT t."ownerId", t."name", t.host, 'OTHER', NULL, t."groupName",
       NULL, NULL, t.enabled, t."intervalSec", 5000, 1,
       0, 0, 0, false, 'UDP', 514,
       true, true, true, false, t."intervalSec",
       3, 1, now(), now()
FROM _t_ping_only t
WHERE NOT EXISTS (
  SELECT 1 FROM "network_device" nd
  WHERE nd."enablePing" = true AND nd."enableSnmp" = false
    AND LOWER(nd.ip) = LOWER(t.host) AND (nd."ownerId" IS NOT DISTINCT FROM t."ownerId")
);

UPDATE "monitor_target" mt SET "deviceId" = nd.id
FROM "network_device" nd, _t_ping_only t
WHERE t.target_id = mt.id
  AND mt."deviceId" IS NULL
  AND nd."enablePing" = true AND nd."enableSnmp" = false
  AND LOWER(nd.ip) = LOWER(t.host)
  AND (nd."ownerId" IS NOT DISTINCT FROM t."ownerId")
  AND NOT EXISTS (
    SELECT 1 FROM "monitor_target" m2 WHERE m2."deviceId" = nd.id
  );

DROP TABLE _t_ping_only;

-- 6) AlertRule: device scoping for the rule builder ("Core Devices" scope).
ALTER TABLE "alert_rule" ADD COLUMN IF NOT EXISTS "scopeDevices" VARCHAR(500);