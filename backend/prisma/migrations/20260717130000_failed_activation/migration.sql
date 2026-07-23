-- Failed activation attempts log
CREATE TABLE IF NOT EXISTS "failed_activation" (
    "id" SERIAL NOT NULL,
    "username" TEXT,
    "fullName" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "failed_activation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "failed_activation_createdById_idx" ON "failed_activation"("createdById");
CREATE INDEX IF NOT EXISTS "failed_activation_createdAt_idx" ON "failed_activation"("createdAt");
