CREATE TYPE "CrmLeadStage" AS ENUM (
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'INTERESTED',
  'WON',
  'LOST'
);

CREATE TYPE "CrmLeadPriority" AS ENUM (
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT'
);

CREATE TYPE "CrmLeadActivityType" AS ENUM (
  'NOTE',
  'CALL',
  'EMAIL',
  'MEETING',
  'FOLLOW_UP',
  'STATUS_CHANGE',
  'ASSIGNMENT',
  'CONVERSION'
);

CREATE TABLE "CrmLead" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "createdById" INTEGER,
  "assignedEmployeeId" INTEGER,
  "packageId" INTEGER,
  "convertedSubscriberId" INTEGER,
  "name" VARCHAR(120) NOT NULL,
  "phone" VARCHAR(40) NOT NULL,
  "phoneNormalized" VARCHAR(20) NOT NULL,
  "email" VARCHAR(254),
  "emailNormalized" VARCHAR(254),
  "address" VARCHAR(500),
  "serviceArea" VARCHAR(120),
  "source" VARCHAR(80),
  "channel" VARCHAR(80),
  "estimatedMonthlyValue" DECIMAL(12,2),
  "stage" "CrmLeadStage" NOT NULL DEFAULT 'NEW',
  "priority" "CrmLeadPriority" NOT NULL DEFAULT 'NORMAL',
  "notes" TEXT,
  "followUpAt" TIMESTAMP(3),
  "followUpRemindedAt" TIMESTAMP(3),
  "lostReason" VARCHAR(500),
  "conversionType" VARCHAR(32),
  "convertedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmLead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmLead_phoneNormalized_check"
    CHECK ("phoneNormalized" ~ '^[0-9]{7,15}$'),
  CONSTRAINT "CrmLead_estimatedMonthlyValue_check"
    CHECK ("estimatedMonthlyValue" IS NULL OR "estimatedMonthlyValue" >= 0),
  CONSTRAINT "CrmLead_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CrmLead_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CrmLead_assignedEmployeeId_fkey"
    FOREIGN KEY ("assignedEmployeeId") REFERENCES "EmployeeProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CrmLead_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "packages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CrmLead_convertedSubscriberId_fkey"
    FOREIGN KEY ("convertedSubscriberId") REFERENCES "Subscriber"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CrmLead_id_companyId_key"
  ON "CrmLead"("id", "companyId");
CREATE INDEX "CrmLead_companyId_stage_archivedAt_createdAt_idx"
  ON "CrmLead"("companyId", "stage", "archivedAt", "createdAt");
CREATE INDEX "CrmLead_companyId_assignedEmployeeId_stage_idx"
  ON "CrmLead"("companyId", "assignedEmployeeId", "stage");
CREATE INDEX "CrmLead_companyId_phoneNormalized_idx"
  ON "CrmLead"("companyId", "phoneNormalized");
CREATE INDEX "CrmLead_companyId_emailNormalized_idx"
  ON "CrmLead"("companyId", "emailNormalized");
CREATE INDEX "CrmLead_companyId_followUpAt_followUpRemindedAt_idx"
  ON "CrmLead"("companyId", "followUpAt", "followUpRemindedAt");
CREATE INDEX "CrmLead_convertedSubscriberId_idx"
  ON "CrmLead"("convertedSubscriberId");

CREATE TABLE "CrmLeadActivity" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "leadId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "type" "CrmLeadActivityType" NOT NULL,
  "detail" TEXT NOT NULL,
  "fromStage" "CrmLeadStage",
  "toStage" "CrmLeadStage",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmLeadActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmLeadActivity_lead_company_fkey"
    FOREIGN KEY ("leadId", "companyId")
    REFERENCES "CrmLead"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CrmLeadActivity_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CrmLeadActivity_companyId_leadId_createdAt_idx"
  ON "CrmLeadActivity"("companyId", "leadId", "createdAt");
CREATE INDEX "CrmLeadActivity_actorUserId_idx"
  ON "CrmLeadActivity"("actorUserId");

CREATE TABLE "CrmLeadConversionKey" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "leadId" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(100) NOT NULL,
  CONSTRAINT "CrmLeadConversionKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmLeadConversionKey_lead_company_fkey"
    FOREIGN KEY ("leadId", "companyId")
    REFERENCES "CrmLead"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CrmLeadConversionKey_idempotencyKey_key"
  ON "CrmLeadConversionKey"("idempotencyKey");
CREATE UNIQUE INDEX "CrmLeadConversionKey_leadId_companyId_key"
  ON "CrmLeadConversionKey"("leadId", "companyId");
