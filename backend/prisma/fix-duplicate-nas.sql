-- ─────────────────────────────────────────────────────────────────────────────
-- Clean up duplicate NAS rows created by the old double-write bug.
--
-- Cause: the app inserted a NAS via Prisma (nasname = friendly name, nasIp = IP)
-- and then addNasToRadius() inserted a SECOND row into the same table
-- (nasname = IP, nasIp = NULL). FreeRADIUS matches clients on `nasname`, so the
-- correct shape is exactly one row per device with nasname = nasIp.
--
-- Run:  sudo -u postgres psql -d jointbox -f fix-duplicate-nas.sql
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== BEFORE ==='
SELECT id, nasname, "nasIp", shortname, type FROM nas ORDER BY id;

-- 1. Drop the orphan rows written by the RADIUS-side insert: they never got the
--    app columns (nasIp / apiUsername), so they are the duplicates, not the
--    real records.
DELETE FROM nas
WHERE "nasIp" IS NULL
  AND EXISTS (SELECT 1 FROM nas n2 WHERE n2."nasIp" = nas.nasname);

-- 2. Any remaining orphan with no nasIp but a valid IP in nasname: promote it
--    rather than lose it.
UPDATE nas SET "nasIp" = nasname
WHERE "nasIp" IS NULL AND nasname ~ '^\d+\.\d+\.\d+\.\d+$';

-- 3. Enforce the FreeRADIUS convention on every surviving row.
UPDATE nas SET nasname = "nasIp" WHERE "nasIp" IS NOT NULL AND nasname IS DISTINCT FROM "nasIp";

-- 4. Collapse any leftover duplicates on the same IP, keeping the richest row
--    (the one that actually has API credentials).
DELETE FROM nas a USING nas b
WHERE a."nasIp" = b."nasIp"
  AND a.id > b.id
  AND (a."apiUsername" IS NULL OR a."apiUsername" = '');

\echo '=== AFTER (expect one row per device, nasname = nasIp) ==='
SELECT id, nasname, "nasIp", shortname, type, "apiUsername" FROM nas ORDER BY id;
