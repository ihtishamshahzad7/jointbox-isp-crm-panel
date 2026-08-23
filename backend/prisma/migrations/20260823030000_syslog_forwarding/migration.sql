-- Syslog forwarding targets (Kiwi-style relay).
--
-- The panel receives syslog but had no way to pass it on, so operators had to
-- point devices at two collectors — doubling load on the device and letting the
-- two copies drift. This records where to relay, with an optional filter using
-- the same clause DSL as the syslog alert rules.
--
-- Idempotent: safe to re-run and safe after `prisma db push`.

CREATE TABLE IF NOT EXISTS "syslog_forward_target" (
  "id"         SERIAL PRIMARY KEY,
  "name"       VARCHAR(120) NOT NULL,
  "host"       VARCHAR(255) NOT NULL,
  "port"       INTEGER NOT NULL DEFAULT 514,
  "protocol"   VARCHAR(8)  NOT NULL DEFAULT 'UDP',
  "enabled"    BOOLEAN     NOT NULL DEFAULT true,
  "condition"  VARCHAR(240),
  "sentCount"  INTEGER     NOT NULL DEFAULT 0,
  "failCount"  INTEGER     NOT NULL DEFAULT 0,
  "lastSentAt" TIMESTAMP(3),
  "lastError"  VARCHAR(300),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "syslog_forward_target_enabled_idx"
  ON "syslog_forward_target" ("enabled");
