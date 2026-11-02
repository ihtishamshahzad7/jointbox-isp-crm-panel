-- Coordinate SNMP polling across worker processes with an expiring owner lease.
ALTER TABLE "nas_snmp_state"
  ADD COLUMN IF NOT EXISTS "pollLeaseToken" UUID,
  ADD COLUMN IF NOT EXISTS "pollLeaseExpiresAt" TIMESTAMP(3);

-- Rollback:
--   ALTER TABLE "nas_snmp_state"
--     DROP COLUMN IF EXISTS "pollLeaseToken",
--     DROP COLUMN IF EXISTS "pollLeaseExpiresAt";
