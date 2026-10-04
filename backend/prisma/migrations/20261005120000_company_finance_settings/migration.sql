-- Each company sets its own refund / expense approval thresholds. The
-- FinanceSettings singleton stays as the default for companies that have not.
-- IF NOT EXISTS throughout: db-deploy.sh also runs `prisma db push`.

CREATE TABLE IF NOT EXISTS "company_finance_settings" (
    "companyId" INTEGER NOT NULL,
    "refundApprovalThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expenseApprovalThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_finance_settings_pkey" PRIMARY KEY ("companyId")
);
