-- Advanced CRM: warehouses, per-unit QR labels and QR stock counts.
-- Additive: two NULLable columns on "InventoryItem" (no rewrite, no default
-- backfill) and three new tables. Existing inventory behaviour is unchanged.
--
-- Rollback (manual):
--   DROP TABLE IF EXISTS "crm_stocktake_line", "crm_stocktake", "crm_warehouse";
--   DROP INDEX IF EXISTS "InventoryItem_qrCode_key", "InventoryItem_warehouseId_idx";
--   ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "qrCode", DROP COLUMN IF EXISTS "warehouseId";

ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "warehouseId" INTEGER;
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "qrCode" VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryItem_qrCode_key" ON "InventoryItem"("qrCode");
CREATE INDEX IF NOT EXISTS "InventoryItem_warehouseId_idx" ON "InventoryItem"("warehouseId");

CREATE TABLE IF NOT EXISTS "crm_warehouse" (
    "id"        SERIAL       NOT NULL,
    "ownerId"   INTEGER      NOT NULL,
    "name"      VARCHAR(80)  NOT NULL,
    "address"   VARCHAR(300),
    "isActive"  BOOLEAN      NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_warehouse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_warehouse_ownerId_name_key" ON "crm_warehouse"("ownerId", "name");

CREATE TABLE IF NOT EXISTS "crm_stocktake" (
    "id"          SERIAL       NOT NULL,
    "warehouseId" INTEGER      NOT NULL,
    "ownerId"     INTEGER      NOT NULL,
    "status"      VARCHAR(10)  NOT NULL DEFAULT 'OPEN',
    "createdById" INTEGER,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"    TIMESTAMP(3),
    CONSTRAINT "crm_stocktake_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "crm_stocktake_warehouseId_idx" ON "crm_stocktake"("warehouseId");
-- At most one count in progress per warehouse; a second "start" loses atomically.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_stocktake_one_open_per_warehouse"
    ON "crm_stocktake"("warehouseId") WHERE "status" = 'OPEN';

CREATE TABLE IF NOT EXISTS "crm_stocktake_line" (
    "stocktakeId" INTEGER      NOT NULL,
    "itemId"      INTEGER      NOT NULL,
    "expected"    BOOLEAN      NOT NULL,
    "scannedAt"   TIMESTAMP(3),
    "scannedById" INTEGER,
    CONSTRAINT "crm_stocktake_line_pkey" PRIMARY KEY ("stocktakeId", "itemId")
);
