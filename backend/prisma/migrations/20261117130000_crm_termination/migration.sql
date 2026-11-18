-- Advanced CRM: termination audit + equipment-recovery follow-up. Additive.
-- Rollback (manual): DROP TABLE IF EXISTS "crm_termination";

CREATE TABLE IF NOT EXISTS "crm_termination" (
    "id"                 SERIAL           NOT NULL,
    "subscriberId"       INTEGER          NOT NULL,
    "reason"             VARCHAR(2000)    NOT NULL,
    "terminatedById"     INTEGER,
    "monthlyRevenueLoss" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status"             VARCHAR(20)      NOT NULL,
    "ticketId"           INTEGER,
    "terminatedAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt"        TIMESTAMP(3),
    CONSTRAINT "crm_termination_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "crm_termination_subscriberId_idx" ON "crm_termination"("subscriberId");
-- A customer has at most one equipment recovery open at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "crm_termination_one_pending_per_customer"
    ON "crm_termination"("subscriberId") WHERE "status" = 'RECOVERY_PENDING';
