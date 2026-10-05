-- RADIUS shared secrets are moving out of the FreeRADIUS-readable plaintext column.
-- The new column is nullable so existing installations can be backfilled safely
-- by the backend (which owns the application encryption key) before plaintext is
-- cleared. FreeRADIUS will no longer read the NAS table for client secrets.

ALTER TABLE "nas"
  ADD COLUMN IF NOT EXISTS "radius_secret_enc" VARCHAR(500);
