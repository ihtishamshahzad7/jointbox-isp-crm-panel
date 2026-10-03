-- Company-owned configuration: SMS/email templates, package taxes, extra fees
-- and throttle policies may now belong to one ISP company (ownerId = the
-- company's top-most account). NULL keeps a row a platform default, shared
-- read-only with every company -- which is what every existing row becomes,
-- so nothing changes until a company creates its own.
--
-- IF [NOT] EXISTS throughout: db-deploy.sh also runs `prisma db push`.

ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
-- Template names were unique across the whole installation; they are now
-- unique per company, so two ISPs can each have their own "Welcome (SMS)".
ALTER TABLE "MessageTemplate" DROP CONSTRAINT IF EXISTS "MessageTemplate_name_key";
DROP INDEX IF EXISTS "MessageTemplate_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "MessageTemplate_ownerId_name_key" ON "MessageTemplate"("ownerId", "name");
CREATE INDEX IF NOT EXISTS "MessageTemplate_ownerId_idx" ON "MessageTemplate"("ownerId");

ALTER TABLE "package_tax" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
CREATE INDEX IF NOT EXISTS "package_tax_ownerId_idx" ON "package_tax"("ownerId");

ALTER TABLE "extra_fee" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
CREATE INDEX IF NOT EXISTS "extra_fee_ownerId_idx" ON "extra_fee"("ownerId");

ALTER TABLE "throttle_policy" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
CREATE INDEX IF NOT EXISTS "throttle_policy_ownerId_idx" ON "throttle_policy"("ownerId");
