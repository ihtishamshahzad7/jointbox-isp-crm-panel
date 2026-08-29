-- Stamp a currency onto every money record.
--
-- THE BUG THIS CLOSES
-- Invoice, Payment and LedgerEntry carried no currency at all. The panel
-- displayed amounts using `Isp.currency`, read at the moment of rendering —
-- and `Isp.currency` is an editable field on a settings screen. So changing it
-- silently reinterpreted the ENTIRE financial history: a 5,000 PKR invoice
-- issued last year becomes "5,000 USD" in every report, with no error, no
-- migration, and nothing anywhere recording what the money actually was.
--
-- That is the same class of defect as the gateway currency bug fixed earlier
-- (a 1,500 PKR invoice charged as USD 1,500, roughly 278x) — a number carried
-- into a context that reinterprets it. The fix is the same in shape: capture
-- the currency AT WRITE TIME and never infer it later.
--
-- WHY THE BACKFILL USES THE ISP'S CURRENT CURRENCY
-- It is the only defensible value. Every existing row was created while the
-- panel was displaying that currency, so that is what those amounts have
-- always implicitly been. Any other choice would invent history. Deployments
-- that have ALREADY changed Isp.currency at some point cannot be repaired by a
-- migration — the information was never recorded — which is precisely the
-- damage this column prevents from happening again.
--
-- Additive and idempotent: columns default to '' so an interrupted run leaves
-- nothing broken, and the backfill only touches rows still holding ''.

ALTER TABLE "Invoice"     ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment"     ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT '';
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT '';

-- A payment may arrive in a currency other than the invoice it settles.
--   amount     — what actually arrived, in `currency`
--   baseAmount — the same money expressed in the INVOICE's currency; this is
--                what is applied to Invoice.paidAmount and what reports sum
--   fxRate     — baseAmount / amount, recorded so the conversion is auditable.
--                A rate looked up at read time is not evidence of anything;
--                the rate that mattered is the one used on the day.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "baseAmount" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "fxRate"     DOUBLE PRECISION;

-- Backfill. `isps[0] ordered by id` is the same record the panel and
-- GatewayService.billingCurrency() already treat as the deployment's own.
DO $$
DECLARE
  isp_currency TEXT;
BEGIN
  SELECT UPPER(TRIM(COALESCE("currency", ''))) INTO isp_currency
  FROM "Isp" ORDER BY "id" ASC LIMIT 1;

  -- No ISP row yet (a fresh install migrating before setup): leave the columns
  -- empty rather than guessing. The application stamps every new row anyway,
  -- and there is no history here to mislabel.
  IF isp_currency IS NULL OR isp_currency = '' THEN
    RAISE NOTICE 'No ISP currency configured — money rows left unstamped; new rows are stamped by the application.';
    RETURN;
  END IF;

  UPDATE "Invoice"     SET "currency" = isp_currency WHERE "currency" = '';
  UPDATE "Payment"     SET "currency" = isp_currency WHERE "currency" = '';
  UPDATE "LedgerEntry" SET "currency" = isp_currency WHERE "currency" = '';

  -- Every historic payment was in the invoice's own currency by construction,
  -- because no other currency could be recorded before this migration existed.
  UPDATE "Payment"
     SET "baseAmount" = "amount", "fxRate" = 1
   WHERE "baseAmount" IS NULL;

  RAISE NOTICE 'Money rows stamped as %.', isp_currency;
END $$;

-- Reporting always slices by currency once more than one exists, so these are
-- the indexes those queries need.
CREATE INDEX IF NOT EXISTS "Invoice_currency_idx"     ON "Invoice"("currency");
CREATE INDEX IF NOT EXISTS "Payment_currency_idx"     ON "Payment"("currency");
CREATE INDEX IF NOT EXISTS "LedgerEntry_currency_idx" ON "LedgerEntry"("currency");
