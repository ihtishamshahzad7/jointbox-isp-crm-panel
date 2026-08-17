-- SNMP tuning + v3 (USM) support. Credentials are encrypted at rest by the
-- application; the RADIUS `secret` column is deliberately NOT encrypted because
-- FreeRADIUS reads it straight out of this table (read_clients = yes).
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpTimeoutMs"   INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpRetries"     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3User"      VARCHAR(64);
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3SecLevel"  VARCHAR(24);
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3AuthProto" VARCHAR(12);
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3AuthPass"  TEXT;
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3PrivProto" VARCHAR(12);
ALTER TABLE "nas" ADD COLUMN IF NOT EXISTS "snmpV3PrivPass"  TEXT;
