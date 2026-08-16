-- Per-subscriber simultaneous-use option: true = may dial in from several
-- devices at once; false (default) = one session, second dial-in rejected.
-- IF NOT EXISTS so the deploy still succeeds when an earlier `prisma db push`
-- already added this column (otherwise migrate deploy aborts and pm2 keeps
-- serving the OLD build).
ALTER TABLE "ServiceSettings" ADD COLUMN IF NOT EXISTS "allowMultipleSessions" BOOLEAN NOT NULL DEFAULT false;
