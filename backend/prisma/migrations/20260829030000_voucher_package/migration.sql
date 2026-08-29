-- Give a prepaid card a plan.
--
-- A hotspot card has to grant a SPEED: "1 hour of internet" is meaningless to
-- a router with no rate limit behind it. Existing cards are top-up/credit
-- cards whose plan comes from the subscriber's own package, so the column is
-- NULLABLE and every existing row stays valid — this is purely additive and
-- rewrites no data.
--
-- ON DELETE SET NULL, not CASCADE: retiring a package must never delete
-- printed cards that physically exist in a dealer's drawer. They fall back to
-- having no plan, which redeemAtHotspot() refuses loudly rather than
-- silently selling an unlimited session.

ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "packageId" INTEGER;

-- Redemption looks the card up by code and joins the package; the index also
-- serves "which cards sell this plan" for stock reporting.
CREATE INDEX IF NOT EXISTS "Voucher_packageId_idx" ON "Voucher"("packageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Voucher_packageId_fkey'
  ) THEN
    ALTER TABLE "Voucher"
      ADD CONSTRAINT "Voucher_packageId_fkey"
      FOREIGN KEY ("packageId") REFERENCES "Package"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
