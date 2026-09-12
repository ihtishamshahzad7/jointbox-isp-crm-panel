-- Monitor targets learn WHAT they check, not only where.
--
-- A device answering ICMP tells you the box is powered and routable. It does
-- not tell you the service on it is alive: a web server can ping happily while
-- its application returns 500, and that is the outage a customer feels.
--
-- Existing rows keep their behaviour exactly — checkType defaults to 'ICMP',
-- which is what every monitor was doing before this migration.
ALTER TABLE "monitor_target"
  ADD COLUMN IF NOT EXISTS "checkType"  VARCHAR(10) NOT NULL DEFAULT 'ICMP',
  ADD COLUMN IF NOT EXISTS "port"       INTEGER,
  ADD COLUMN IF NOT EXISTS "path"       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "lastStatus" INTEGER;

-- Only the four the application understands. A row with any other value would
-- silently fall through to a ping, and the operator would believe a service was
-- being watched when it was not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'monitor_target_checktype_chk'
  ) THEN
    ALTER TABLE "monitor_target"
      ADD CONSTRAINT "monitor_target_checktype_chk"
      CHECK ("checkType" IN ('ICMP', 'TCP', 'HTTP', 'HTTPS'));
  END IF;
END $$;

-- A non-ICMP monitor without a port cannot be checked at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'monitor_target_port_chk'
  ) THEN
    ALTER TABLE "monitor_target"
      ADD CONSTRAINT "monitor_target_port_chk"
      -- `"port" IS NOT NULL` is load-bearing, not belt-and-braces. A CHECK
      -- constraint passes when its expression is NULL rather than FALSE, and
      -- `NULL BETWEEN 1 AND 65535` is NULL — so without this the constraint
      -- silently accepted an HTTPS monitor with no port, which is the one row
      -- it exists to reject. Verified against a real Postgres both ways.
      CHECK (
        ("checkType" = 'ICMP' AND "port" IS NULL)
        OR ("checkType" <> 'ICMP' AND "port" IS NOT NULL AND "port" BETWEEN 1 AND 65535)
      );
  END IF;
END $$;
