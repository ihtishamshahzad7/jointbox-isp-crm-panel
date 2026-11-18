-- Advanced CRM: employee codes, designations, departments, reporting lines and
-- availability for existing Uplinko logins. Additive; roles and permissions
-- are untouched.
-- Rollback (manual):
--   DROP TABLE IF EXISTS "crm_employee_profile", "crm_employee_counter", "crm_designation";

CREATE TABLE IF NOT EXISTS "crm_designation" (
    "id"        SERIAL       NOT NULL,
    "companyId" INTEGER      NOT NULL,
    "name"      VARCHAR(150) NOT NULL,
    "isActive"  BOOLEAN      NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_designation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_designation_companyId_name_key" ON "crm_designation"("companyId", "name");

CREATE TABLE IF NOT EXISTS "crm_employee_profile" (
    "userId"          INTEGER      NOT NULL,
    "companyId"       INTEGER      NOT NULL,
    "employeeCode"    VARCHAR(20)  NOT NULL,
    "designationId"   INTEGER,
    "department"      VARCHAR(100),
    "reportsToUserId" INTEGER,
    "availability"    VARCHAR(10)  NOT NULL DEFAULT 'AVAILABLE',
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_employee_profile_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "crm_employee_profile_not_self" CHECK ("reportsToUserId" IS NULL OR "reportsToUserId" <> "userId"),
    CONSTRAINT "crm_employee_profile_availability_check" CHECK ("availability" IN ('AVAILABLE', 'ON_DUTY', 'ON_LEAVE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "crm_employee_profile_companyId_employeeCode_key" ON "crm_employee_profile"("companyId", "employeeCode");
CREATE INDEX IF NOT EXISTS "crm_employee_profile_reportsToUserId_idx" ON "crm_employee_profile"("reportsToUserId");

CREATE TABLE IF NOT EXISTS "crm_employee_counter" (
    "companyId" INTEGER NOT NULL,
    "next"      INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "crm_employee_counter_pkey" PRIMARY KEY ("companyId")
);
