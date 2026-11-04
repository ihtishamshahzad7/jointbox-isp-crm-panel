ALTER TABLE "FieldJob"
  ADD COLUMN "visitOrder" INTEGER;

CREATE INDEX "FieldJob_assignedTo_scheduledAt_visitOrder_idx"
  ON "FieldJob"("assignedTo", "scheduledAt", "visitOrder");

ALTER TABLE "FieldJobVisit"
  ADD COLUMN "checkInLocationStatus" VARCHAR(20),
  ADD COLUMN "checkInLatitude" DOUBLE PRECISION,
  ADD COLUMN "checkInLongitude" DOUBLE PRECISION,
  ADD COLUMN "checkInAccuracy" DOUBLE PRECISION,
  ADD COLUMN "checkInCapturedAt" TIMESTAMP(3),
  ADD COLUMN "checkOutLocationStatus" VARCHAR(20),
  ADD COLUMN "checkOutLatitude" DOUBLE PRECISION,
  ADD COLUMN "checkOutLongitude" DOUBLE PRECISION,
  ADD COLUMN "checkOutAccuracy" DOUBLE PRECISION,
  ADD COLUMN "checkOutCapturedAt" TIMESTAMP(3);

ALTER TABLE "InventoryItem"
  ADD COLUMN "companyId" INTEGER,
  ADD CONSTRAINT "InventoryItem_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InventoryItem_companyId_idx" ON "InventoryItem"("companyId");

CREATE TABLE "FieldJobAttachment" (
  "id" SERIAL NOT NULL,
  "fieldJobId" INTEGER NOT NULL,
  "filename" VARCHAR(200) NOT NULL,
  "evidenceType" VARCHAR(32) NOT NULL,
  "note" VARCHAR(500),
  "uploadedById" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FieldJobAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldJobAttachment_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldJobAttachment_filename_fkey"
    FOREIGN KEY ("filename") REFERENCES "uploaded_file"("filename")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldJobAttachment_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FieldJobAttachment_filename_key" ON "FieldJobAttachment"("filename");
CREATE INDEX "FieldJobAttachment_fieldJobId_createdAt_idx"
  ON "FieldJobAttachment"("fieldJobId", "createdAt");
CREATE INDEX "FieldJobAttachment_uploadedById_createdAt_idx"
  ON "FieldJobAttachment"("uploadedById", "createdAt");

CREATE TABLE "FieldJobSchedule" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "createdById" INTEGER,
  "subscriberId" INTEGER,
  "ticketId" INTEGER,
  "leadId" INTEGER,
  "type" "FieldJobType" NOT NULL,
  "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
  "description" TEXT NOT NULL,
  "workInstructions" TEXT,
  "address" VARCHAR(500),
  "frequency" VARCHAR(12) NOT NULL,
  "interval" INTEGER NOT NULL DEFAULT 1,
  "timeZone" VARCHAR(100) NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "lockToken" VARCHAR(36),
  "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FieldJobSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldJobSchedule_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FieldJobSchedule_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FieldJobSchedule_subscriberId_fkey"
    FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FieldJobSchedule_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FieldJobSchedule_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FieldJobSchedule_companyId_status_nextRunAt_idx"
  ON "FieldJobSchedule"("companyId", "status", "nextRunAt");
CREATE INDEX "FieldJobSchedule_status_lockedUntil_idx"
  ON "FieldJobSchedule"("status", "lockedUntil");
CREATE INDEX "FieldJobSchedule_subscriberId_idx" ON "FieldJobSchedule"("subscriberId");
CREATE INDEX "FieldJobSchedule_ticketId_idx" ON "FieldJobSchedule"("ticketId");
CREATE INDEX "FieldJobSchedule_leadId_idx" ON "FieldJobSchedule"("leadId");

CREATE TABLE "FieldJobOccurrence" (
  "id" SERIAL NOT NULL,
  "scheduleId" INTEGER NOT NULL,
  "fieldJobId" INTEGER,
  "occurrenceAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FieldJobOccurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldJobOccurrence_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "FieldJobSchedule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FieldJobOccurrence_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FieldJobOccurrence_fieldJobId_key" ON "FieldJobOccurrence"("fieldJobId");
CREATE UNIQUE INDEX "FieldJobOccurrence_scheduleId_occurrenceAt_key"
  ON "FieldJobOccurrence"("scheduleId", "occurrenceAt");
CREATE INDEX "FieldJobOccurrence_occurrenceAt_idx" ON "FieldJobOccurrence"("occurrenceAt");
