-- Advanced CRM: per-company ticket turnaround targets. Additive; tickets of
-- companies without a row keep the installation defaults.
-- Rollback (manual): DROP TABLE IF EXISTS "crm_tat_setting";

CREATE TABLE IF NOT EXISTS "crm_tat_setting" (
    "id"                SERIAL       NOT NULL,
    "companyId"         INTEGER      NOT NULL,
    "category"          VARCHAR(20)  NOT NULL,
    "priority"          VARCHAR(10)  NOT NULL,
    "responseMinutes"   INTEGER      NOT NULL,
    "resolutionMinutes" INTEGER      NOT NULL,
    "updatedById"       INTEGER,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_tat_setting_pkey" PRIMARY KEY ("id"),
    -- 1 minute … 30 days; the response target may not exceed the resolution target.
    CONSTRAINT "crm_tat_setting_minutes_check" CHECK (
        "responseMinutes" BETWEEN 1 AND 43200 AND "resolutionMinutes" BETWEEN 1 AND 43200
        AND "responseMinutes" <= "resolutionMinutes")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_tat_setting_companyId_category_priority_key"
    ON "crm_tat_setting"("companyId", "category", "priority");
