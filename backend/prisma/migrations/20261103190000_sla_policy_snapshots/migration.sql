CREATE TABLE "SlaPolicyVersion" (
  "id" SERIAL NOT NULL,
  "seriesId" VARCHAR(36) NOT NULL,
  "version" INTEGER NOT NULL,
  "companyId" INTEGER NOT NULL,
  "createdById" INTEGER,
  "name" VARCHAR(120) NOT NULL,
  "recordType" VARCHAR(20) NOT NULL,
  "priority" "TicketPriority" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "firstResponseTargetMinutes" INTEGER,
  "resolutionTargetMinutes" INTEGER NOT NULL,
  "firstResponseWarningMinutes" INTEGER,
  "resolutionWarningMinutes" INTEGER,
  "clockMode" VARCHAR(20) NOT NULL DEFAULT 'ELAPSED_UTC',
  "notes" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlaPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SlaPolicyVersion_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SlaPolicyVersion_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SlaPolicyVersion_seriesId_version_key"
  ON "SlaPolicyVersion"("seriesId", "version");
CREATE INDEX "SlaPolicyVersion_companyId_recordType_priority_active_effectiveFrom_idx"
  ON "SlaPolicyVersion"("companyId", "recordType", "priority", "active", "effectiveFrom");
CREATE INDEX "SlaPolicyVersion_createdAt_idx"
  ON "SlaPolicyVersion"("createdAt");

ALTER TABLE "Ticket"
  ADD COLUMN "firstResolvedAt" TIMESTAMP(3),
  ADD COLUMN "reopenedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReopenedAt" TIMESTAMP(3),
  ADD COLUMN "slaPolicyVersionId" INTEGER,
  ADD COLUMN "slaResponseTargetMinutes" INTEGER,
  ADD COLUMN "slaResolutionTargetMinutes" INTEGER,
  ADD COLUMN "slaResponseWarningMinutes" INTEGER,
  ADD COLUMN "slaResolutionWarningMinutes" INTEGER,
  ADD COLUMN "slaClockMode" VARCHAR(20),
  ADD CONSTRAINT "Ticket_slaPolicyVersionId_fkey"
    FOREIGN KEY ("slaPolicyVersionId") REFERENCES "SlaPolicyVersion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Ticket_slaPolicyVersionId_createdAt_idx"
  ON "Ticket"("slaPolicyVersionId", "createdAt");

ALTER TABLE "FieldJob"
  ADD COLUMN "slaPolicyVersionId" INTEGER,
  ADD COLUMN "slaResolutionDueAt" TIMESTAMP(3),
  ADD COLUMN "slaResolvedAt" TIMESTAMP(3),
  ADD COLUMN "slaResolutionTargetMinutes" INTEGER,
  ADD COLUMN "slaResolutionWarningMinutes" INTEGER,
  ADD COLUMN "slaClockMode" VARCHAR(20),
  ADD CONSTRAINT "FieldJob_slaPolicyVersionId_fkey"
    FOREIGN KEY ("slaPolicyVersionId") REFERENCES "SlaPolicyVersion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FieldJob_slaPolicyVersionId_createdAt_idx"
  ON "FieldJob"("slaPolicyVersionId", "createdAt");
