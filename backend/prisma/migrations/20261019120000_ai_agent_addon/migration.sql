-- Product entitlements use Uplinko's existing plan and company-plan rows.
-- No roles or permissions are granted by this migration.
ALTER TABLE "company_plan"
  ADD COLUMN IF NOT EXISTS "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "company_plan"
  ADD COLUMN IF NOT EXISTS "aiAssistantMonthlyRequestLimit" INTEGER,
  ADD COLUMN IF NOT EXISTS "aiAssistantMonthlyTokenLimit" INTEGER;
ALTER TABLE "platform_plan"
  ADD COLUMN IF NOT EXISTS "aiAssistantMonthlyRequestLimit" INTEGER,
  ADD COLUMN IF NOT EXISTS "aiAssistantMonthlyTokenLimit" INTEGER;

CREATE TABLE IF NOT EXISTS "product_feature" (
  "key" VARCHAR(40) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedById" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_feature_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "ai_agent_usage" (
  "id" BIGSERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "userId" INTEGER,
  "category" VARCHAR(40) NOT NULL,
  "provider" VARCHAR(40),
  "model" VARCHAR(120),
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "reservedTokens" INTEGER NOT NULL DEFAULT 0,
  "tokensEstimated" BOOLEAN NOT NULL DEFAULT false,
  "providerCost" DECIMAL(14,8),
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "errorCode" VARCHAR(40),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_agent_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_agent_usage_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_agent_usage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ai_agent_usage_companyId_createdAt_idx"
  ON "ai_agent_usage"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_agent_usage_userId_createdAt_idx"
  ON "ai_agent_usage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_agent_usage_status_createdAt_idx"
  ON "ai_agent_usage"("status", "createdAt");
