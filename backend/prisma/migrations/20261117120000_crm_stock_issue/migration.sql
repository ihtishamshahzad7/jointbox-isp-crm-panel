-- Advanced CRM: units issued to customers (with optional charge) and their
-- recovery. Additive; existing inventory/invoices are untouched.
-- Rollback (manual): DROP TABLE IF EXISTS "crm_stock_issue";

CREATE TABLE IF NOT EXISTS "crm_stock_issue" (
    "id"            SERIAL           NOT NULL,
    "itemId"        INTEGER          NOT NULL,
    "subscriberId"  INTEGER          NOT NULL,
    "ownerId"       INTEGER,
    "warehouseId"   INTEGER,
    "requestKey"    VARCHAR(64)      NOT NULL,
    "status"        VARCHAR(12)      NOT NULL DEFAULT 'ISSUED',
    "charge"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billing"       VARCHAR(10)      NOT NULL DEFAULT 'NONE',
    "invoiceId"     INTEGER,
    "notes"         VARCHAR(300),
    "issuedById"    INTEGER,
    "issuedAt"      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt"   TIMESTAMP(3),
    "recoveredById" INTEGER,
    "condition"     VARCHAR(12),
    CONSTRAINT "crm_stock_issue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_stock_issue_charge_check" CHECK ("charge" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_stock_issue_requestKey_key" ON "crm_stock_issue"("requestKey");
CREATE INDEX IF NOT EXISTS "crm_stock_issue_subscriberId_idx" ON "crm_stock_issue"("subscriberId");
CREATE INDEX IF NOT EXISTS "crm_stock_issue_itemId_idx" ON "crm_stock_issue"("itemId");
-- A unit can be out with only one customer at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_stock_issue_one_open_per_item"
    ON "crm_stock_issue"("itemId") WHERE "status" = 'ISSUED';
