CREATE TYPE "AttendanceStatus" AS ENUM (
  'PRESENT',
  'ABSENT',
  'LATE',
  'HALF_DAY',
  'APPROVED_LEAVE'
);

CREATE UNIQUE INDEX "EmployeeProfile_id_companyId_key"
  ON "EmployeeProfile"("id", "companyId");

CREATE TABLE "EmployeeAttendance" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "attendanceDate" DATE NOT NULL,
  "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
  "checkInAt" TIMESTAMP(3),
  "checkOutAt" TIMESTAMP(3),
  "durationMinutes" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeAttendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeAttendance_employee_company_fkey"
    FOREIGN KEY ("employeeId", "companyId")
    REFERENCES "EmployeeProfile"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeAttendance_check_out_requires_check_in"
    CHECK ("checkOutAt" IS NULL OR "checkInAt" IS NOT NULL),
  CONSTRAINT "EmployeeAttendance_check_out_after_check_in"
    CHECK ("checkOutAt" IS NULL OR "checkOutAt" > "checkInAt"),
  CONSTRAINT "EmployeeAttendance_nonworking_status_has_no_times"
    CHECK (
      "status" NOT IN ('ABSENT', 'APPROVED_LEAVE')
      OR ("checkInAt" IS NULL AND "checkOutAt" IS NULL)
    ),
  CONSTRAINT "EmployeeAttendance_duration_nonnegative"
    CHECK ("durationMinutes" IS NULL OR "durationMinutes" >= 0)
);

CREATE UNIQUE INDEX "EmployeeAttendance_id_companyId_key"
  ON "EmployeeAttendance"("id", "companyId");
CREATE UNIQUE INDEX "EmployeeAttendance_companyId_employeeId_attendanceDate_key"
  ON "EmployeeAttendance"("companyId", "employeeId", "attendanceDate");
CREATE INDEX "EmployeeAttendance_companyId_attendanceDate_idx"
  ON "EmployeeAttendance"("companyId", "attendanceDate");
CREATE INDEX "EmployeeAttendance_companyId_employeeId_attendanceDate_idx"
  ON "EmployeeAttendance"("companyId", "employeeId", "attendanceDate");
CREATE INDEX "EmployeeAttendance_companyId_status_attendanceDate_idx"
  ON "EmployeeAttendance"("companyId", "status", "attendanceDate");

CREATE TABLE "EmployeeAttendanceCorrection" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "attendanceId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "reason" TEXT NOT NULL,
  "previousStatus" "AttendanceStatus" NOT NULL,
  "newStatus" "AttendanceStatus" NOT NULL,
  "previousCheckInAt" TIMESTAMP(3),
  "newCheckInAt" TIMESTAMP(3),
  "previousCheckOutAt" TIMESTAMP(3),
  "newCheckOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeAttendanceCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeAttendanceCorrection_attendance_company_fkey"
    FOREIGN KEY ("attendanceId", "companyId")
    REFERENCES "EmployeeAttendance"("id", "companyId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeAttendanceCorrection_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EmployeeAttendanceCorrection_companyId_attendanceId_createdAt_idx"
  ON "EmployeeAttendanceCorrection"("companyId", "attendanceId", "createdAt");
CREATE INDEX "EmployeeAttendanceCorrection_actorUserId_idx"
  ON "EmployeeAttendanceCorrection"("actorUserId");
