ALTER TYPE "FieldJobStatus" ADD VALUE 'PENDING_REVIEW';

CREATE TYPE "TaskStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "TaskActivityType" AS ENUM ('CREATED', 'UPDATED', 'ASSIGNED', 'STATUS_CHANGED', 'COMMENT');

ALTER TABLE "FieldJob"
  ADD COLUMN "appointmentEndsAt" TIMESTAMP(3),
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "customerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "workInstructions" TEXT,
  ADD COLUMN "requiredSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "checklist" JSONB,
  ADD COLUMN "technicianNotes" TEXT,
  ADD COLUMN "cancellationReason" VARCHAR(500),
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "nextAction" TEXT,
  ADD COLUMN "leadId" INTEGER;

ALTER TABLE "FieldJob"
  ADD CONSTRAINT "FieldJob_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FieldJob_leadId_idx" ON "FieldJob"("leadId");
CREATE INDEX "FieldJob_assignedTo_scheduledAt_appointmentEndsAt_idx"
  ON "FieldJob"("assignedTo", "scheduledAt", "appointmentEndsAt");

CREATE TABLE "FieldJobActivity" (
  "id" SERIAL NOT NULL,
  "fieldJobId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "action" VARCHAR(40) NOT NULL,
  "detail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FieldJobActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldJobActivity_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FieldJobActivity_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FieldJobActivity_fieldJobId_createdAt_idx"
  ON "FieldJobActivity"("fieldJobId", "createdAt");
CREATE INDEX "FieldJobActivity_actorUserId_idx"
  ON "FieldJobActivity"("actorUserId");

CREATE TABLE "FieldJobVisit" (
  "id" SERIAL NOT NULL,
  "fieldJobId" INTEGER NOT NULL,
  "technicianId" INTEGER,
  "visitNumber" INTEGER NOT NULL,
  "arrivedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "outcome" VARCHAR(40),
  "notes" TEXT,
  "nextAction" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FieldJobVisit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldJobVisit_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FieldJobVisit_technicianId_fkey"
    FOREIGN KEY ("technicianId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FieldJobVisit_fieldJobId_visitNumber_key"
  ON "FieldJobVisit"("fieldJobId", "visitNumber");
CREATE INDEX "FieldJobVisit_technicianId_createdAt_idx"
  ON "FieldJobVisit"("technicianId", "createdAt");

CREATE TABLE "Task" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "createdById" INTEGER,
  "assignedEmployeeId" INTEGER,
  "subscriberId" INTEGER,
  "leadId" INTEGER,
  "ticketId" INTEGER,
  "fieldJobId" INTEGER,
  "title" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "category" VARCHAR(80),
  "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "TaskStatus" NOT NULL DEFAULT 'PLANNED',
  "dueAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Task_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Task_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Task_assignedEmployeeId_fkey"
    FOREIGN KEY ("assignedEmployeeId") REFERENCES "EmployeeProfile"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Task_subscriberId_fkey"
    FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Task_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "CrmLead"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Task_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Task_fieldJobId_fkey"
    FOREIGN KEY ("fieldJobId") REFERENCES "FieldJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Task_id_companyId_key" ON "Task"("id", "companyId");
CREATE INDEX "Task_companyId_status_dueAt_idx" ON "Task"("companyId", "status", "dueAt");
CREATE INDEX "Task_companyId_assignedEmployeeId_status_idx"
  ON "Task"("companyId", "assignedEmployeeId", "status");
CREATE INDEX "Task_companyId_createdAt_idx" ON "Task"("companyId", "createdAt");
CREATE INDEX "Task_subscriberId_idx" ON "Task"("subscriberId");
CREATE INDEX "Task_leadId_idx" ON "Task"("leadId");
CREATE INDEX "Task_ticketId_idx" ON "Task"("ticketId");
CREATE INDEX "Task_fieldJobId_idx" ON "Task"("fieldJobId");

CREATE TABLE "TaskActivity" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "taskId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "type" "TaskActivityType" NOT NULL,
  "detail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskActivity_taskId_companyId_fkey"
    FOREIGN KEY ("taskId", "companyId") REFERENCES "Task"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskActivity_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TaskActivity_companyId_taskId_createdAt_idx"
  ON "TaskActivity"("companyId", "taskId", "createdAt");
CREATE INDEX "TaskActivity_actorUserId_idx" ON "TaskActivity"("actorUserId");
