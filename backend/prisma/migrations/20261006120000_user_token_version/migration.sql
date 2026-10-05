-- Sessions carry the account's token version; bumping it signs every
-- session of that account out (password change / reset).
-- IF NOT EXISTS: db-deploy.sh also runs `prisma db push`.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
