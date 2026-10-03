-- Forced password change on first login.
-- IF NOT EXISTS so a server where `prisma db push` already added the column
-- (db-deploy.sh runs it after migrations) applies this cleanly.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
