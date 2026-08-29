-- WireGuard management tunnels.
--
-- Purely additive: a new table, no change to `nas`. Every existing router keeps
-- working exactly as before and simply has no tunnel row.
--
-- The two UNIQUE constraints are the integrity of the whole feature:
--   • nasId     — one tunnel per router. A second row would leave two peers
--                 authorised for one device, so revoking "the" tunnel would
--                 revoke only one of them and access would quietly persist.
--   • overlayIp — two routers on one address does not error, it silently
--                 routes one router's traffic to the other, so a CoA
--                 disconnect meant for a defaulter lands on somebody else's
--                 paying customer. This constraint is what makes concurrent
--                 provisioning safe: the loser of the race gets a rejection
--                 and picks the next free address.
--
-- publicKey is UNIQUE too: WireGuard identifies a peer by its key alone, so two
-- rows sharing one would make the peer list ambiguous in both directions.
--
-- ON DELETE CASCADE on nasId is deliberate, and the opposite of the choice made
-- for voucher stock. A tunnel is not a record of anything — it is live access
-- configuration for a router. If the router is gone, an orphaned peer is a
-- credential still installed on hardware nobody is tracking.

CREATE TABLE IF NOT EXISTS "NasTunnel" (
  "id"              SERIAL PRIMARY KEY,
  "nasId"           INTEGER NOT NULL,
  "publicKey"       VARCHAR(64) NOT NULL,
  "overlayIp"       VARCHAR(45) NOT NULL,
  "serverEndpoint"  VARCHAR(255) NOT NULL,
  "serverPublicKey" VARCHAR(64) NOT NULL,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "lastHandshake"   TIMESTAMP(3),
  "rxBytes"         BIGINT NOT NULL DEFAULT 0,
  "txBytes"         BIGINT NOT NULL DEFAULT 0,
  "createdBy"       INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt"       TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "NasTunnel_nasId_key"     ON "NasTunnel"("nasId");
CREATE UNIQUE INDEX IF NOT EXISTS "NasTunnel_publicKey_key" ON "NasTunnel"("publicKey");
CREATE UNIQUE INDEX IF NOT EXISTS "NasTunnel_overlayIp_key" ON "NasTunnel"("overlayIp");
CREATE INDEX        IF NOT EXISTS "NasTunnel_enabled_idx"   ON "NasTunnel"("enabled");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'NasTunnel_nasId_fkey'
  ) THEN
    ALTER TABLE "NasTunnel"
      ADD CONSTRAINT "NasTunnel_nasId_fkey"
      FOREIGN KEY ("nasId") REFERENCES "nas"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
