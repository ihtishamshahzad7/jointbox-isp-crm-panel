ALTER TABLE "InventoryItem"
  ADD COLUMN "fieldJobId" INTEGER,
  ADD COLUMN "reservedForFieldJobId" INTEGER;

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryItem_reservedForFieldJobId_fkey"
    FOREIGN KEY ("reservedForFieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InventoryItem_fieldJobId_idx" ON "InventoryItem"("fieldJobId");
CREATE INDEX "InventoryItem_reservedForFieldJobId_idx" ON "InventoryItem"("reservedForFieldJobId");

ALTER TABLE "InventoryMovement"
  ADD COLUMN "fieldJobId" INTEGER,
  ADD COLUMN "employeeId" INTEGER,
  ADD COLUMN "movementType" VARCHAR(24) NOT NULL DEFAULT 'STATUS_CHANGE',
  ADD COLUMN "idempotencyKey" VARCHAR(120);

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InventoryMovement_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "EmployeeProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InventoryMovement_idempotencyKey_key"
  ON "InventoryMovement"("idempotencyKey");
CREATE INDEX "InventoryMovement_fieldJobId_createdAt_idx"
  ON "InventoryMovement"("fieldJobId", "createdAt");
CREATE INDEX "InventoryMovement_employeeId_createdAt_idx"
  ON "InventoryMovement"("employeeId", "createdAt");

ALTER TABLE "Task" ADD COLUMN "reminderAt" TIMESTAMP(3);

CREATE TABLE "TaskReminder" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "taskId" INTEGER NOT NULL,
  "assignedEmployeeId" INTEGER,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "messageId" INTEGER,
  "idempotencyKey" VARCHAR(120) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskReminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskReminder_taskId_companyId_fkey"
    FOREIGN KEY ("taskId", "companyId") REFERENCES "Task"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskReminder_assignedEmployeeId_fkey"
    FOREIGN KEY ("assignedEmployeeId") REFERENCES "EmployeeProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TaskReminder_idempotencyKey_key"
  ON "TaskReminder"("idempotencyKey");
CREATE UNIQUE INDEX "TaskReminder_taskId_scheduledAt_key"
  ON "TaskReminder"("taskId", "scheduledAt");
CREATE INDEX "TaskReminder_companyId_status_scheduledAt_idx"
  ON "TaskReminder"("companyId", "status", "scheduledAt");
CREATE INDEX "TaskReminder_assignedEmployeeId_scheduledAt_idx"
  ON "TaskReminder"("assignedEmployeeId", "scheduledAt");

ALTER TABLE "Message" ADD COLUMN "idempotencyKey" VARCHAR(120);
CREATE UNIQUE INDEX "Message_idempotencyKey_key"
  ON "Message"("idempotencyKey");
