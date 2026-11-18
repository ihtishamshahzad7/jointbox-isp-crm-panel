-- Advanced CRM: receipts frozen on first issue. Additive; no foreign keys, so
-- nothing about existing payments changes.
-- Rollback (manual): DROP TABLE IF EXISTS "crm_payment_receipt";

CREATE TABLE IF NOT EXISTS "crm_payment_receipt" (
    "paymentId"    INTEGER          NOT NULL,
    "receiptNo"    VARCHAR(40)      NOT NULL,
    "subscriberId" INTEGER,
    "customerName" VARCHAR(200)     NOT NULL,
    "username"     VARCHAR(120),
    "packageName"  VARCHAR(200),
    "amount"       DOUBLE PRECISION NOT NULL,
    "currency"     VARCHAR(3)       NOT NULL,
    "method"       VARCHAR(40)      NOT NULL,
    "referenceNo"  VARCHAR(120),
    "paymentDate"  TIMESTAMP(3)     NOT NULL,
    "invoiceNo"    VARCHAR(60),
    "invoiceTotal" DOUBLE PRECISION,
    "dueAfter"     DOUBLE PRECISION,
    "receivedBy"   VARCHAR(200),
    "issuedById"   INTEGER,
    "issuedAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_payment_receipt_pkey" PRIMARY KEY ("paymentId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_payment_receipt_receiptNo_key" ON "crm_payment_receipt"("receiptNo");
CREATE INDEX IF NOT EXISTS "crm_payment_receipt_subscriberId_idx" ON "crm_payment_receipt"("subscriberId");
