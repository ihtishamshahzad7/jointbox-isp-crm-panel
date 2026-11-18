-- Company entitlements: which sold-separately products (AI Assistant,
-- Advanced CRM) a company may use. Additive; existing rows get the features
-- of the price-list plan they are already on, so nothing a company had shown
-- on its plan is lost. Gated features ("ai-assistant", "crm-advanced") are new
-- names, so no company gains a gated product from this backfill.
--
-- Rollback (manual): ALTER TABLE "company_plan" DROP COLUMN IF EXISTS "features";

ALTER TABLE "company_plan" ADD COLUMN IF NOT EXISTS "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "company_plan" cp
SET "features" = pp."features"
FROM "platform_plan" pp
WHERE cp."planId" = pp."id" AND cp."features" = ARRAY[]::TEXT[];
