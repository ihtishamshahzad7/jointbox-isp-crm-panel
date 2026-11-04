ALTER TYPE "AttendanceStatus" ADD VALUE 'CANCELLED_LEAVE';

CREATE TYPE "EmployeeLeaveStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TYPE "EmployeeLeaveHistoryAction" AS ENUM (
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TYPE "EmployeeLeaveBalanceEntryType" AS ENUM (
  'ALLOCATION',
  'ADJUSTMENT',
  'LEAVE_APPROVAL',
  'LEAVE_REVERSAL'
);

CREATE TABLE "EmployeeLeaveType" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isPaid" BOOLEAN NOT NULL DEFAULT false,
  "annualAllocationDays" DECIMAL(7,2),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeLeaveType_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveType_annualAllocationDays_check"
    CHECK ("annualAllocationDays" IS NULL OR "annualAllocationDays" > 0),
  CONSTRAINT "EmployeeLeaveType_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeLeaveType_id_companyId_key"
  ON "EmployeeLeaveType"("id", "companyId");
CREATE UNIQUE INDEX "EmployeeLeaveType_companyId_name_key"
  ON "EmployeeLeaveType"("companyId", "name");
CREATE INDEX "EmployeeLeaveType_companyId_isActive_name_idx"
  ON "EmployeeLeaveType"("companyId", "isActive", "name");

CREATE TABLE "EmployeeLeaveRequest" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "leaveTypeId" INTEGER NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "leaveDates" DATE[] NOT NULL,
  "requestedDays" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "EmployeeLeaveStatus" NOT NULL DEFAULT 'PENDING',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" INTEGER,
  "decisionComment" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeLeaveRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveRequest_dates_check"
    CHECK ("endDate" >= "startDate" AND "requestedDays" > 0
      AND cardinality("leaveDates") = "requestedDays"),
  CONSTRAINT "EmployeeLeaveRequest_employee_company_fkey"
    FOREIGN KEY ("employeeId", "companyId")
    REFERENCES "EmployeeProfile"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveRequest_type_company_fkey"
    FOREIGN KEY ("leaveTypeId", "companyId")
    REFERENCES "EmployeeLeaveType"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveRequest_decidedByUserId_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeLeaveRequest_id_companyId_key"
  ON "EmployeeLeaveRequest"("id", "companyId");
CREATE INDEX "EmployeeLeaveRequest_companyId_status_submittedAt_idx"
  ON "EmployeeLeaveRequest"("companyId", "status", "submittedAt");
CREATE INDEX "EmployeeLeaveRequest_companyId_employeeId_startDate_endDate_idx"
  ON "EmployeeLeaveRequest"("companyId", "employeeId", "startDate", "endDate");
CREATE INDEX "EmployeeLeaveRequest_companyId_leaveTypeId_status_idx"
  ON "EmployeeLeaveRequest"("companyId", "leaveTypeId", "status");
CREATE INDEX "EmployeeLeaveRequest_decidedByUserId_idx"
  ON "EmployeeLeaveRequest"("decidedByUserId");

CREATE TABLE "EmployeeLeaveHistory" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "requestId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "action" "EmployeeLeaveHistoryAction" NOT NULL,
  "previousStatus" "EmployeeLeaveStatus",
  "newStatus" "EmployeeLeaveStatus" NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeLeaveHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveHistory_request_company_fkey"
    FOREIGN KEY ("requestId", "companyId")
    REFERENCES "EmployeeLeaveRequest"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveHistory_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EmployeeLeaveHistory_companyId_requestId_createdAt_idx"
  ON "EmployeeLeaveHistory"("companyId", "requestId", "createdAt");
CREATE INDEX "EmployeeLeaveHistory_actorUserId_idx"
  ON "EmployeeLeaveHistory"("actorUserId");

CREATE TABLE "EmployeeLeaveBalance" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "leaveTypeId" INTEGER NOT NULL,
  "periodYear" INTEGER NOT NULL,
  "allocatedDays" DECIMAL(7,2) NOT NULL,
  "adjustmentDays" DECIMAL(7,2) NOT NULL DEFAULT 0,
  "usedDays" DECIMAL(7,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeLeaveBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveBalance_days_check"
    CHECK ("allocatedDays" >= 0 AND "usedDays" >= 0),
  CONSTRAINT "EmployeeLeaveBalance_periodYear_check"
    CHECK ("periodYear" BETWEEN 1900 AND 2200),
  CONSTRAINT "EmployeeLeaveBalance_employee_company_fkey"
    FOREIGN KEY ("employeeId", "companyId")
    REFERENCES "EmployeeProfile"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveBalance_type_company_fkey"
    FOREIGN KEY ("leaveTypeId", "companyId")
    REFERENCES "EmployeeLeaveType"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeLeaveBalance_id_companyId_key"
  ON "EmployeeLeaveBalance"("id", "companyId");
CREATE UNIQUE INDEX "EmployeeLeaveBalance_companyId_employeeId_leaveTypeId_periodYear_key"
  ON "EmployeeLeaveBalance"("companyId", "employeeId", "leaveTypeId", "periodYear");
CREATE INDEX "EmployeeLeaveBalance_companyId_periodYear_leaveTypeId_idx"
  ON "EmployeeLeaveBalance"("companyId", "periodYear", "leaveTypeId");
CREATE INDEX "EmployeeLeaveBalance_companyId_employeeId_periodYear_idx"
  ON "EmployeeLeaveBalance"("companyId", "employeeId", "periodYear");

CREATE TABLE "EmployeeLeaveBalanceEntry" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "balanceId" INTEGER NOT NULL,
  "leaveRequestId" INTEGER,
  "actorUserId" INTEGER,
  "entryType" "EmployeeLeaveBalanceEntryType" NOT NULL,
  "deltaDays" DECIMAL(7,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeLeaveBalanceEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveBalanceEntry_deltaDays_check" CHECK ("deltaDays" <> 0),
  CONSTRAINT "EmployeeLeaveBalanceEntry_balance_company_fkey"
    FOREIGN KEY ("balanceId", "companyId")
    REFERENCES "EmployeeLeaveBalance"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveBalanceEntry_request_company_fkey"
    FOREIGN KEY ("leaveRequestId", "companyId")
    REFERENCES "EmployeeLeaveRequest"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveBalanceEntry_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EmployeeLeaveBalanceEntry_companyId_balanceId_createdAt_idx"
  ON "EmployeeLeaveBalanceEntry"("companyId", "balanceId", "createdAt");
CREATE INDEX "EmployeeLeaveBalanceEntry_companyId_leaveRequestId_idx"
  ON "EmployeeLeaveBalanceEntry"("companyId", "leaveRequestId");
CREATE INDEX "EmployeeLeaveBalanceEntry_actorUserId_idx"
  ON "EmployeeLeaveBalanceEntry"("actorUserId");

ALTER TABLE "EmployeeAttendance"
  ADD COLUMN "leaveRequestId" INTEGER;

ALTER TABLE "EmployeeAttendance"
  ADD CONSTRAINT "EmployeeAttendance_cancelled_leave_has_no_times"
  CHECK (
    "status" <> 'CANCELLED_LEAVE'
    OR ("checkInAt" IS NULL AND "checkOutAt" IS NULL)
  );
ALTER TABLE "EmployeeAttendance"
  ADD CONSTRAINT "EmployeeAttendance_linked_leave_status"
  CHECK (
    "leaveRequestId" IS NULL
    OR "status" = 'APPROVED_LEAVE'
  );

CREATE INDEX "EmployeeAttendance_companyId_leaveRequestId_idx"
  ON "EmployeeAttendance"("companyId", "leaveRequestId");
ALTER TABLE "EmployeeAttendance"
  ADD CONSTRAINT "EmployeeAttendance_leaveRequest_company_fkey"
  FOREIGN KEY ("leaveRequestId", "companyId")
  REFERENCES "EmployeeLeaveRequest"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
