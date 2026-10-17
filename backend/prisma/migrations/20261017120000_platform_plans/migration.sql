-- Plans & Pricing (the platform's price list), the plan a company is on, and
-- each company's contact/address details. Additive only; IF NOT EXISTS
-- throughout because db-deploy.sh may also have run `prisma db push`.

CREATE TABLE IF NOT EXISTS "platform_plan" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "billingPeriod" VARCHAR(10) NOT NULL DEFAULT 'MONTHLY',
    "maxSubscribers" INTEGER,
    "maxNas" INTEGER,
    "maxAccounts" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" VARCHAR(300),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_plan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_plan_name_key" ON "platform_plan"("name");

ALTER TABLE "company_plan" ADD COLUMN IF NOT EXISTS "planId" INTEGER;

CREATE TABLE IF NOT EXISTS "company_profile" (
    "companyId" INTEGER NOT NULL,
    "contactFirstName" VARCHAR(80),
    "contactLastName" VARCHAR(80),
    "contactPhone" VARCHAR(30),
    "website" VARCHAR(200),
    "addressLine1" VARCHAR(200),
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(80),
    "province" VARCHAR(80),
    "postalCode" VARCHAR(20),
    "country" VARCHAR(80),
    "taxNumber" VARCHAR(40),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("companyId")
);

-- Five starting tiers. Prices are 0 on purpose: the platform owner sets them
-- in Plans & Pricing. Limits are starting points and fully editable.
INSERT INTO "platform_plan" ("name", "maxSubscribers", "maxNas", "maxAccounts", "features", "description", "sortOrder")
VALUES
  ('Starter',      300,   2,   5, ARRAY['subscribers','billing'], 'Small ISP getting started', 1),
  ('Basic',       1000,   5,  15, ARRAY['subscribers','billing','accounting'], 'Growing local ISP', 2),
  ('Professional',3000,  15,  50, ARRAY['subscribers','billing','accounting','monitoring'], 'Multi-area ISP with resellers', 3),
  ('Business',   10000,  40, 150, ARRAY['subscribers','billing','accounting','monitoring','fiber'], 'Regional ISP', 4),
  ('Enterprise',  NULL, NULL, NULL, ARRAY['subscribers','billing','accounting','monitoring','fiber','api'], 'No limits', 5)
ON CONFLICT ("name") DO NOTHING;
