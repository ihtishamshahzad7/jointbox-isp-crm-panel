-- Per-package FUP action: what happens when the data quota is exhausted.
--   THROTTLE — reduce to the FUP speeds (default)
--   BLOCK    — suspend the connection until the cycle restarts / quota tops up
--   NONE     — measure and report usage, take no action
-- NULL keeps the legacy behaviour: follow the global FUP_MODE env.
ALTER TABLE "packages" ADD COLUMN "fupAction" TEXT;