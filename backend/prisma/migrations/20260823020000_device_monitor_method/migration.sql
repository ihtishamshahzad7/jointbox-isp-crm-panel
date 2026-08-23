-- Per-device monitoring METHOD.
--
-- Every NetworkDevice was SNMP-polled unconditionally, so plain internet
-- targets (8.8.8.8, google.com, youtube.com) reported "SNMP timeout" while
-- being perfectly reachable by ping. This records how each target is actually
-- checked, so the poller stops running SNMP against hosts that have no agent.
--
-- Idempotent: safe to re-run, and safe on a database already updated by
-- `prisma db push`.

ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "monitorMethod" VARCHAR(8) NOT NULL DEFAULT 'SNMP';
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "lastLatencyMs" DOUBLE PRECISION;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "lastLossPct"   DOUBLE PRECISION;
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "lastOkAt"      TIMESTAMP(3);
ALTER TABLE "network_device" ADD COLUMN IF NOT EXISTS "downSince"     TIMESTAMP(3);

-- Existing rows keep SNMP (the column default). We deliberately do NOT guess a
-- method from the address: a device that has been polling SNMP successfully
-- must not be silently downgraded to ping by a migration. Operators switch the
-- handful of internet targets over in the UI, where the change is visible and
-- reversible.

CREATE INDEX IF NOT EXISTS "network_device_monitorMethod_idx" ON "network_device" ("monitorMethod");
