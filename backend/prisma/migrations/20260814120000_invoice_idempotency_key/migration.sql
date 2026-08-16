-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");
