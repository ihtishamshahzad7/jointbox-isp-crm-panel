-- Advanced CRM: link an expense to the customer it was spent on. Additive.
-- Rollback (manual): DROP TABLE IF EXISTS "crm_expense_link";

CREATE TABLE IF NOT EXISTS "crm_expense_link" (
    "expenseId"    INTEGER      NOT NULL,
    "subscriberId" INTEGER      NOT NULL,
    "linkedById"   INTEGER,
    "linkedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_expense_link_pkey" PRIMARY KEY ("expenseId")
);
CREATE INDEX IF NOT EXISTS "crm_expense_link_subscriberId_idx" ON "crm_expense_link"("subscriberId");
