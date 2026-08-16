-- Per-subscriber simultaneous-use option: true = may dial in from several
-- devices at once; false (default) = one session, second dial-in rejected.
ALTER TABLE "ServiceSettings" ADD COLUMN "allowMultipleSessions" BOOLEAN NOT NULL DEFAULT false;