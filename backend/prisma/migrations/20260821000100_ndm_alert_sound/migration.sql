-- NDM alert/sound pipeline + strict interface allowlist
-- Run via `prisma migrate deploy` for hygiene; the poller self-heals regardless.

-- 1) Recovery-sound masters for device + interface.
ALTER TABLE "network_device"    ADD COLUMN IF NOT EXISTS "soundUpEnabled"      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "soundUpEnabled"      BOOLEAN NOT NULL DEFAULT true;

-- 2) Port monitoring override tracking + exclusion reason.
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "monitoringExplicit"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "network_interface" ADD COLUMN IF NOT EXISTS "excludedReason"      VARCHAR(120);

-- 3) Reclassify MikroTik PPPoE session rows the OLD classifier missed.
--    RouterOS names them `<pppoe-o>` etc. (angle brackets, no digits) —
--    the previous regexes required a leading "pppoe-" or a digit.
UPDATE "network_interface" ni SET
  "interfaceCategory" = 'PPPOE_SESSION',
  "monitoringEnabled" = false,
  "excludedReason"    = 'PPPoE session'
WHERE ni."interfaceCategory" IS NOT DISTINCT FROM 'UNKNOWN'
  AND LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) LIKE '%pppoe%';

-- 4) Reclassify other PPP/PPPoE shapes + dynamic links.
UPDATE "network_interface" ni SET
  "interfaceCategory" = CASE
    WHEN LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) LIKE '%pppoe%' THEN 'PPPOE_SESSION'
    WHEN LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) ~ '^(ppp|l2tp|sstp|ovpn)[0-9.:-]*$' THEN 'PPP'
    ELSE ni."interfaceCategory"
  END,
  "monitoringEnabled" = false,
  "excludedReason" = CASE
    WHEN LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) LIKE '%pppoe%' THEN 'PPPoE session'
    ELSE 'Dynamic subscriber link'
  END
WHERE ni."monitoringExplicit" = false
  AND (
    LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) LIKE '%pppoe%'
    OR LOWER(REPLACE(REPLACE(ni.name, '<', ''), '>', '')) ~ '^(ppp|l2tp|sstp|ovpn)[0-9.:-]*$'
  );

-- 5) Strict allowlist: only PHYSICAL + VLAN are monitored by default.
--    Everything else that isn't explicitly overridden gets excluded.
UPDATE "network_interface" SET
  "monitoringEnabled" = false,
  "excludedReason" = CASE "interfaceCategory"
    WHEN 'LOOPBACK' THEN 'Loopback'
    WHEN 'BRIDGE' THEN 'Bridge'
    WHEN 'BOND' THEN 'Bond'
    WHEN 'TUNNEL' THEN 'Tunnel'
    WHEN 'PPP' THEN 'PPP link'
    WHEN 'PPPOE_SESSION' THEN 'PPPoE session'
    WHEN 'DYNAMIC' THEN 'Dynamic subscriber link'
    ELSE 'Not a physical/VLAN port'
  END
WHERE "monitoringExplicit" = false
  AND "monitoringEnabled" = true
  AND "interfaceCategory" IS NOT NULL
  AND "interfaceCategory" NOT IN ('PHYSICAL', 'VLAN');

-- Remaining NULL categories: classify by name so the poller's allowlist can engage.
UPDATE "network_interface" SET "interfaceCategory" = 'UNKNOWN'
WHERE "interfaceCategory" IS NULL;

-- 6) Existing open DOWN alerts get a chance to sound on RECOVERY only if the
--    new defaults say so — nothing to backfill here (flags default true),
--    keeping operator history intact.