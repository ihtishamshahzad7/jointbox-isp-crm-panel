-- NDM fixes: sound alert settings, interface classification (PPPoE filter),
-- TimeTicks uptime correction and nullable rates (no fake 0 bps).

-- ── NetworkDevice: device-level sound override ─────────────────────────
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "soundEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ── NetworkInterface: classification + per-port flags ──────────────────
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "ifType" INTEGER;
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "interfaceCategory" VARCHAR(24);
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "monitoringEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "soundEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Rates become nullable: NULL means "no valid sample" (first poll / counter
-- reset after a reboot). The UI renders "—" instead of a fake 0 bps.
ALTER TABLE "network_interface" ALTER COLUMN "rxRateBps" DROP NOT NULL;
ALTER TABLE "network_interface" ALTER COLUMN "txRateBps" DROP NOT NULL;
ALTER TABLE "network_interface" ALTER COLUMN "rxPps" DROP NOT NULL;
ALTER TABLE "network_interface" ALTER COLUMN "txPps" DROP NOT NULL;
ALTER TABLE "network_interface" ALTER COLUMN "errorRatePerMin" DROP NOT NULL;

-- ── One-time uptime correction ─────────────────────────────────────────
-- The poller stored SNMP sysUpTime (TimeTicks = 1/100 s) directly into
-- "uptimeSec", so every stored value was ~100x the real uptime (1179d for an
-- ~11d device). The poller was the ONLY writer, so dividing is safe.
UPDATE "network_device" SET "uptimeSec" = "uptimeSec" / 100
  WHERE "uptimeSec" IS NOT NULL AND "uptimeSec" > 0;
-- Same unit bug in the health series.
UPDATE "device_health_metric" SET "value" = "value" / 100
  WHERE "metric" = 'uptime' AND "value" > 0;

-- ── One-time interface classification backfill (name-based, mirrors
--    classifyInterface()) so devices added BEFORE this deployment show the
--    right category + monitoring flag without a rescan. ────────────────
UPDATE "network_interface" SET "interfaceCategory" = 'PPPOE_SESSION', "monitoringEnabled" = false
  WHERE "interfaceCategory" IS NULL
    AND (LOWER("name") LIKE 'pppoe-%' OR (LOWER("name") LIKE '%pppoe%' AND "name" ~ '[0-9]'));
UPDATE "network_interface" SET "interfaceCategory" = 'VLAN'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^vlan[0-9.:-]*$';
UPDATE "network_interface" SET "interfaceCategory" = 'LOOPBACK'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^(lo|loopback[0-9.:-]*)$';
UPDATE "network_interface" SET "interfaceCategory" = 'BRIDGE'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^bridge[0-9.:-]*$';
UPDATE "network_interface" SET "interfaceCategory" = 'BOND'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^bond[0-9.:-]*$';
UPDATE "network_interface" SET "interfaceCategory" = 'TUNNEL'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^(gre|gre6|eoip|vxlan|ipip|eip|wireguard|tun[0-9.:-]*)$';
UPDATE "network_interface" SET "interfaceCategory" = 'PPP'
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^(ppp|l2tp|sstp|ovpn)[0-9.:-]*$';
UPDATE "network_interface" SET "interfaceCategory" = 'DYNAMIC', "monitoringEnabled" = false
  WHERE "interfaceCategory" IS NULL AND LOWER("name") ~ '^dynamic';
-- Anything that still says NULL is a physical/unknown port from before the
-- classifier existed → UNKNOWN (still monitored; the next poll re-classifies
-- with real ifType data).
UPDATE "network_interface" SET "interfaceCategory" = 'UNKNOWN'
  WHERE "interfaceCategory" IS NULL;

CREATE INDEX IF NOT EXISTS "network_interface_monitoringEnabled_idx"
  ON "network_interface" ("deviceId", "monitoringEnabled");