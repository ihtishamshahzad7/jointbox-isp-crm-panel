-- CreateTable
CREATE TABLE "GatewayTransaction" (
    "id" SERIAL NOT NULL,
    "gateway" TEXT NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "subscriberId" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "gatewayRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewayTransaction_idempotencyKey_key" ON "GatewayTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GatewayTransaction_invoiceId_idx" ON "GatewayTransaction"("invoiceId");

-- CreateIndex
CREATE INDEX "GatewayTransaction_subscriberId_idx" ON "GatewayTransaction"("subscriberId");

-- CreateIndex
CREATE INDEX "GatewayTransaction_status_idx" ON "GatewayTransaction"("status");

-- CreateIndex
CREATE INDEX "GatewayTransaction_gateway_createdAt_idx" ON "GatewayTransaction"("gateway", "createdAt");
