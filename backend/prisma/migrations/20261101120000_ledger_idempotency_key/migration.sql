-- D2 idempotency: exactly-once financial operations.
-- Safe on existing data: the column is NEW and NULL for every existing row, and
-- the unique index is PARTIAL (only indexes non-NULL keys), so it cannot clash
-- with any historical row. Additive and reversible.

ALTER TABLE "subscriber_balance_ledger"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_balance_ledger_idempotencyKey_key"
  ON "subscriber_balance_ledger" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Rollback:
--   DROP INDEX IF EXISTS "subscriber_balance_ledger_idempotencyKey_key";
--   ALTER TABLE "subscriber_balance_ledger" DROP COLUMN IF EXISTS "idempotencyKey";
