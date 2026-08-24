-- Package management: JSON file → PostgreSQL.
--
-- Creates the tables only. The DATA is moved by tools/import-packages-json.js,
-- run once after deploy, which reads backend/data/packages-management.json and
-- inserts it preserving every id.
--
-- Ids matter here more than usual: package settings reference taxes, policies
-- and allocations BY ID, so renumbering during the move would silently attach
-- the wrong tax to a package. The sequences are therefore reset from MAX(id)
-- by that script rather than left at 1.

CREATE TABLE IF NOT EXISTS "package_setting" (
  "id"        SERIAL PRIMARY KEY,
  "packageId" INTEGER NOT NULL,
  "settings"  JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "package_setting_packageId_key" ON "package_setting"("packageId");

-- Deleting a package now removes its settings automatically. Previously this
-- was a hand-written filter step in remove(); anything that deleted a package
-- by another route left an orphan behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'package_setting_packageId_fkey'
  ) THEN
    ALTER TABLE "package_setting"
      ADD CONSTRAINT "package_setting_packageId_fkey"
      FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "package_tax" (
  "id"          SERIAL PRIMARY KEY,
  "groupName"   VARCHAR(120) NOT NULL DEFAULT '',
  "name"        VARCHAR(120) NOT NULL,
  "type"        VARCHAR(24)  NOT NULL DEFAULT 'PERCENTAGE',
  "value"       VARCHAR(32)  NOT NULL DEFAULT '0',
  "description" VARCHAR(300),
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "package_tax_isActive_idx" ON "package_tax"("isActive");

CREATE TABLE IF NOT EXISTS "package_policy" (
  "id"             SERIAL PRIMARY KEY,
  "groupName"      VARCHAR(120) NOT NULL DEFAULT '',
  "attributeName"  VARCHAR(120) NOT NULL,
  "attributeType"  VARCHAR(24)  NOT NULL,
  "attributeOp"    VARCHAR(8)   NOT NULL,
  "attributeValue" VARCHAR(240) NOT NULL,
  "description"    VARCHAR(300),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "package_allocation" (
  "id"          SERIAL PRIMARY KEY,
  "groupName"   VARCHAR(120) NOT NULL DEFAULT '',
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "days"        JSONB NOT NULL DEFAULT '[]',
  "startTime"   VARCHAR(8) NOT NULL DEFAULT '00:00',
  "endTime"     VARCHAR(8) NOT NULL DEFAULT '23:59',
  "policyId"    INTEGER,
  "description" VARCHAR(300),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "package_allocation_isActive_idx" ON "package_allocation"("isActive");
