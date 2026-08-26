-- Prepaid card stock: allocate cards to the reseller who sells them.
--
-- Cards already had batch generation, a PIN and a redeem flow, but no owner:
-- Voucher recorded who created it and who used it, with nothing in between.
-- So there was no way to hand a dealer 500 cards, see what they were holding,
-- or reconcile what they sold against what they owe — which in a prepaid,
-- dealer-distributed market is the sales channel itself.
--
-- PURELY ADDITIVE and safe to run on a live database: two nullable columns and
-- an index. Every existing card gets assignedToUserId = NULL, which reads as
-- "unassigned — held by the ISP", the correct state for cards printed before
-- allocation existed. No backfill required, no row is rewritten.

ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "assignedToUserId" INTEGER;
ALTER TABLE "Voucher" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);

-- Stock questions are always "what does this account hold, unredeemed", so the
-- index is on the pair rather than on the account alone.
CREATE INDEX IF NOT EXISTS "Voucher_assignedToUserId_status_idx"
  ON "Voucher"("assignedToUserId", "status");

-- ON DELETE SET NULL, deliberately not CASCADE: removing a dealer account must
-- never delete cards that physically exist in someone's hand. They fall back to
-- unassigned stock so they can be re-issued or written off explicitly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Voucher_assignedToUserId_fkey'
  ) THEN
    ALTER TABLE "Voucher"
      ADD CONSTRAINT "Voucher_assignedToUserId_fkey"
      FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
