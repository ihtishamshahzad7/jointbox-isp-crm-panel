-- Invoice idempotency key (one activation click = one invoice, enforced by a
-- UNIQUE index). IF NOT EXISTS guards both statements so the deploy still
-- completes when an earlier `prisma db push` already created them — a failed
-- migrate deploy aborts the whole deploy and leaves the OLD backend running.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");
