CREATE TABLE "EmployeeProfile" (
  "id" SERIAL NOT NULL,
  "companyId" INTEGER NOT NULL,
  "userId" INTEGER,
  "employeeNumber" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "department" TEXT,
  "designation" TEXT,
  "hiredAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeProfile_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmployeeProfile_userId_key"
  ON "EmployeeProfile"("userId");
CREATE UNIQUE INDEX "EmployeeProfile_companyId_employeeNumber_key"
  ON "EmployeeProfile"("companyId", "employeeNumber");
CREATE INDEX "EmployeeProfile_companyId_status_idx"
  ON "EmployeeProfile"("companyId", "status");
CREATE INDEX "EmployeeProfile_companyId_name_idx"
  ON "EmployeeProfile"("companyId", "name");
