-- The platform account runs no business; each ISP company owns its own.
--   * access groups and ISP brands (with their branches) belong to a company
--     (ownerId = the company's top-most account; NULL = from before, given
--     to the company at boot when the old top account is split);
--   * each company closes its own books (company_period_lock); the old
--     AccountingLock row stays as the installation-wide lock.
--
-- IF [NOT] EXISTS throughout: db-deploy.sh also runs `prisma db push`.

-- access_group is created by `prisma db push`, not by a migration, so on a
-- brand-new database it may not exist yet (db push then creates it with these
-- columns already).
DO $$
BEGIN
  IF to_regclass('"access_group"') IS NOT NULL THEN
    ALTER TABLE "access_group" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
    ALTER TABLE "access_group" DROP CONSTRAINT IF EXISTS "access_group_name_key";
    DROP INDEX IF EXISTS "access_group_name_key";
    CREATE UNIQUE INDEX IF NOT EXISTS "access_group_ownerId_name_key" ON "access_group"("ownerId", "name");
    CREATE INDEX IF NOT EXISTS "access_group_ownerId_idx" ON "access_group"("ownerId");
  END IF;
END $$;

ALTER TABLE "Isp" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
ALTER TABLE "Isp" DROP CONSTRAINT IF EXISTS "Isp_name_key";
DROP INDEX IF EXISTS "Isp_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Isp_ownerId_name_key" ON "Isp"("ownerId", "name");
CREATE INDEX IF NOT EXISTS "Isp_ownerId_idx" ON "Isp"("ownerId");

CREATE TABLE IF NOT EXISTS "company_period_lock" (
    "companyId" INTEGER NOT NULL,
    "lockedThrough" TIMESTAMP(3),
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_period_lock_pkey" PRIMARY KEY ("companyId")
);
