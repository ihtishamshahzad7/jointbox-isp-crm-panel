-- Per-subscriber prepaid accounting stamps
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "sellPrice" DOUBLE PRECISION;
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "costPrice" DOUBLE PRECISION;
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "profit" DOUBLE PRECISION;

-- Permission to top up downline wallets
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "canTopupDownline" BOOLEAN NOT NULL DEFAULT false;
