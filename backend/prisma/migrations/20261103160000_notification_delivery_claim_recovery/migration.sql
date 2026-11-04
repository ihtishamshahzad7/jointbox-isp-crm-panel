ALTER TABLE "Message"
ADD COLUMN "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "sendingAt" TIMESTAMP(3);

CREATE INDEX "Message_status_queuedAt_idx"
ON "Message"("status", "queuedAt");
CREATE INDEX "Message_status_sendingAt_idx"
ON "Message"("status", "sendingAt");
