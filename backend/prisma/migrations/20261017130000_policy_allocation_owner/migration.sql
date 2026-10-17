-- RADIUS policies and time allocations belong to a company, like its packages.
-- Additive: existing rows keep ownerId NULL and stay readable (not writable)
-- by every company, so no package loses a rule it already uses.
ALTER TABLE "package_policy" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
ALTER TABLE "package_allocation" ADD COLUMN IF NOT EXISTS "ownerId" INTEGER;
CREATE INDEX IF NOT EXISTS "package_policy_ownerId_idx" ON "package_policy"("ownerId");
CREATE INDEX IF NOT EXISTS "package_allocation_ownerId_idx" ON "package_allocation"("ownerId");
