-- Profit ledger: margins earned by upline tiers. Reporting only — these are
-- NOT wallet movements (the parent was already paid when it sold the credit
-- the child spent, so crediting the wallet again would double-count).
CREATE TABLE IF NOT EXISTS "profit_entry" (
  "id"           SERIAL PRIMARY KEY,
  "at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"       INTEGER NOT NULL,
  "fromUserId"   INTEGER,
  "subscriberId" INTEGER,
  "packageId"    INTEGER,
  "saleAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "costAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "profitAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reference"    VARCHAR(120),
  "note"         VARCHAR(200),
  CONSTRAINT "profit_entry_userId_fkey"       FOREIGN KEY ("userId")       REFERENCES "User"("id")       ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "profit_entry_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "profit_entry_userId_at_idx"     ON "profit_entry"("userId", "at");
CREATE INDEX IF NOT EXISTS "profit_entry_fromUserId_at_idx" ON "profit_entry"("fromUserId", "at");
CREATE INDEX IF NOT EXISTS "profit_entry_reference_idx"     ON "profit_entry"("reference");
