-- Per-subscriber auto-renewal opt-out.
--
-- THE BUG THIS CLOSES
-- `runAutoRenewal` (nightly, 01:00) selected every subscriber with
-- `balance > 0` and a lapsed expiry, deducted the wallet, wrote a paid
-- invoice, and set the account ACTIVE. Nothing in that query could be turned
-- off: `autoRenew` existed on User and on StaticIp, but never on the
-- subscriber, so there was no per-customer switch anywhere in the product.
--
-- The consequence was a workflow an operator simply could not perform —
-- expire a customer and refund them:
--
--   1. staff expire the account
--   2. the refund credits the customer's wallet
--   3. 01:00: the job sees credit + a lapsed expiry, charges the wallet and
--      sets the account ACTIVE again
--
-- The refund re-arms the exact thing it was meant to undo, so from the
-- operator's side accounts "go active by themselves" however many times they
-- are expired. Reported from the field on two live subscribers.
--
-- DEFAULT TRUE, DELIBERATELY
-- Renewing from a wallet is a feature ISPs rely on; the defect was the
-- absent opt-out, not the behaviour. Defaulting to true means every existing
-- subscriber on every existing install behaves exactly as it does today, and
-- this migration changes no observable behaviour on its own. Operators turn
-- it off for the specific customers who need it off.
--
-- NOT NULL with a default is safe on a populated table: PostgreSQL 11+ fills
-- existing rows from the default without rewriting the table.

ALTER TABLE "ServiceSettings"
  ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT true;

-- The renewal job filters on (expiryDate, autoRenew) every night across the
-- whole subscriber base, so give it an index that answers exactly that.
-- Partial, because rows with autoRenew = false are precisely the ones the job
-- must NOT look at — indexing them would be dead weight.
CREATE INDEX IF NOT EXISTS "ServiceSettings_autoRenew_expiry_idx"
  ON "ServiceSettings" ("expiryDate")
  WHERE "autoRenew" = true;
