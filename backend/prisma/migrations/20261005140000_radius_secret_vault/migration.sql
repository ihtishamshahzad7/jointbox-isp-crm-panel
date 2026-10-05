-- RADIUS shared secrets are now encrypted in the app-owned NAS table.
-- Existing plaintext values are migrated by NasService on startup after the
-- protected FreeRADIUS client store has been provisioned by deployment.
ALTER TABLE "nas" ALTER COLUMN "secret" TYPE VARCHAR(512);
