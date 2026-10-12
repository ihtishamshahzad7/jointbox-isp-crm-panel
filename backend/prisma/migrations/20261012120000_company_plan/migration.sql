-- What the platform account allows each ISP company: subscriber, router and
-- sub-account caps and an end date. NULL = no limit. Keyed by the company's
-- top account. IF NOT EXISTS throughout: db-deploy.sh also runs `prisma db push`.

CREATE TABLE IF NOT EXISTS "company_plan" (
    "companyId" INTEGER NOT NULL,
    "maxSubscribers" INTEGER,
    "maxNas" INTEGER,
    "maxAccounts" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "note" VARCHAR(300),
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_plan_pkey" PRIMARY KEY ("companyId")
);
