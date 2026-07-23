-- CreateTable
CREATE TABLE "reseller_package_price" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "packageId" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_package_price_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reseller_package_price_userId_packageId_key" ON "reseller_package_price"("userId", "packageId");
CREATE INDEX "reseller_package_price_userId_idx" ON "reseller_package_price"("userId");
CREATE INDEX "reseller_package_price_packageId_idx" ON "reseller_package_price"("packageId");

-- AddForeignKey
ALTER TABLE "reseller_package_price" ADD CONSTRAINT "reseller_package_price_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reseller_package_price" ADD CONSTRAINT "reseller_package_price_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
