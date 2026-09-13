-- Where a poller left off, stored rather than guessed.
--
-- THE BUG THIS CLOSES
-- `NetworkLogsService` kept its radacct position in a process variable that
-- `seedHighWaterMarks()` reset to MAX(radacctid) on every boot. Every deploy,
-- crash and PM2 restart therefore skipped the entire window the process was
-- down: no CONNECTION or DISCONNECTION event was ever written for any session
-- that started or ended during a deployment, and nothing anywhere recorded
-- that a gap existed.
--
-- WHY (ts, id) AND NOT AN id ALONE
-- FreeRADIUS UPDATES a radacct row in place on every interim update and on
-- Accounting-Stop; `radacctid` never changes. A cursor on the id alone passes
-- a live session's id while it is still open, and can then never select that
-- same row again when it closes — which is how half the session history went
-- missing. The timestamp carries the ordering.
--
-- And the id is still needed, because a timestamp alone is not a cursor:
-- FreeRADIUS writes in bursts, so many rows share one to the microsecond.
-- With `>` those rows are skipped; with `>=` the poller reads them forever.
-- The pair gives a total order, compared as a row value:
--   (acctupdatetime, radacctid) > (cursor_ts, cursor_id)
--
-- Two rows are seeded, one per stream. A stop is a different transition on the
-- same row and needs its own high-water mark.
CREATE TABLE IF NOT EXISTS "poller_cursor" (
  "name"      TEXT        NOT NULL,
  "ts"        TIMESTAMPTZ(6) NOT NULL,
  "id"        BIGINT      NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "poller_cursor_pkey" PRIMARY KEY ("name")
);

-- Seeded to NOW() rather than to the epoch, deliberately.
--
-- An existing install has up to 90 days of radacct history. Starting from the
-- epoch would replay millions of long-finished sessions as though they had
-- just happened, flooding the network log and the live feed on first boot
-- after the upgrade. Starting from now means this install loses nothing it
-- was going to keep anyway — the old code had already discarded that history
-- — and every event from this point forward is captured.
INSERT INTO "poller_cursor" ("name", "ts", "id") VALUES
  ('radacct_activity', NOW(), 0),
  ('radacct_stop',     NOW(), 0)
ON CONFLICT ("name") DO NOTHING;
