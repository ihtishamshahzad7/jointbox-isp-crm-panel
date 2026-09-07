-- 64-BIT PRIMARY KEYS FOR THE APPEND-ONLY TABLES.
--
-- THE CEILING
-- These tables use `Int` primary keys, which in PostgreSQL means `integer`:
-- a hard maximum of 2,147,483,647. They are append-only and grow with
-- subscriber count and elapsed time, never shrinking, so that number is a
-- date rather than a limit. `radacct` gets one row per accounting session:
-- at 10M subscribers reconnecting a few times a day it is a matter of weeks,
-- not years. When it arrives, FreeRADIUS simply stops being able to write
-- accounting, and nothing before that moment looks wrong.
--
-- Converting a primary key rewrites the table under an ACCESS EXCLUSIVE lock.
-- Doing it now, while the tables are small, takes seconds. Doing it at 10M
-- subscribers is a maintenance window measured in hours — which is precisely
-- why this is worth doing before the data exists rather than after.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE TWO TRAPS THIS MIGRATION EXISTS TO AVOID
-- Both were found by running the obvious version against PostgreSQL 16.
--
-- TRAP 1 — ALTERING THE COLUMN DOES NOT MOVE THE CEILING.
--   `ALTER TABLE t ALTER COLUMN id TYPE bigint` is the whole recommendation
--   in most write-ups of this problem, and on its own it accomplishes
--   nothing. `serial` creates a SEQUENCE typed `integer`, and altering the
--   column leaves the sequence untouched:
--
--     ALTER TABLE ... TYPE bigint;      -- column is bigint
--     SELECT setval(seq, 2147483646);
--     INSERT ...                        -- ok
--     INSERT ...                        -- ERROR: nextval: reached maximum
--                                       --   value of sequence (2147483647)
--
--   So the migration appears to succeed, the schema looks correct, and the
--   table still dies at exactly the same row. The sequence must be altered
--   too, and that is the line that actually fixes the bug.
--
-- TRAP 2 — A DEPENDENT VIEW BLOCKS THE ALTER OUTRIGHT.
--   `radius-schema-apply.sh` moves the RADIUS tables into schema `radius`
--   and leaves compatibility views behind in `public`. A view's column types
--   are fixed when it is created, so PostgreSQL refuses:
--
--     ERROR: cannot alter type of a column used by a view or rule
--     DETAIL: rule _RETURN on view radacct depends on column "radacctid"
--
--   Every install that has run the RADIUS separation is in this state, so
--   the naive migration fails on all of them and succeeds only on a fresh
--   database — the environment least likely to be tested against.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THESE TABLES AND NOT Invoice / Payment / Alert
-- Those three have inbound foreign keys (InvoiceItem, PaymentTransaction,
-- InvoiceReversal, Notification), so converting them means converting every
-- referencing column in the same transaction — a much larger blast radius
-- across the money tables. They also do not need it: one invoice per
-- subscriber per month is ~120M rows/year at 10M subscribers, roughly
-- seventeen years of headroom. The twelve tables below have NO inbound
-- foreign keys at all, which is what makes this migration safe to do in one
-- step.
--
-- Idempotent throughout: every conversion is skipped when the column is
-- already `bigint`, so re-running is a no-op and installs that partially
-- applied it can simply run it again.

DO $migrate$
DECLARE
  spec        record;
  tbl_schema  text;
  seq_name    text;
  view_defs   text[] := ARRAY[]::text[];
  view_names  text[] := ARRAY[]::text[];
  v           record;
  i           int;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- RADIUS accounting: the urgent one. Lives in schema `radius` on any
      -- install that has run radius-schema-apply.sh, and in `public` on one
      -- that has not, so it is resolved dynamically below.
      ('radacct',                 'radacctid'),
      -- Monitoring / telemetry: written continuously per device, per port.
      ('nas_traffic_sample',      'id'),
      ('onu_telemetry',           'id'),
      ('onu_signal_sample',       'id'),
      ('interface_status_history','id'),
      ('interface_traffic_history','id'),
      ('syslog_event',            'id'),
      ('network_event',           'id'),
      -- Audit / activity: one row per action, forever.
      ('loginlog',                'id'),
      ('activitylog',             'id'),
      ('sessionlog',              'id'),
      ('networklog',              'id')
    ) AS t(tbl, col)
  LOOP
    -- Resolve which schema actually holds the table on THIS install.
    SELECT n.nspname INTO tbl_schema
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = spec.tbl AND c.relkind = 'r'
       AND n.nspname IN ('public', 'radius')
     ORDER BY (n.nspname = 'radius') DESC
     LIMIT 1;

    IF tbl_schema IS NULL THEN
      RAISE NOTICE 'skip %: table not present', spec.tbl;
      CONTINUE;
    END IF;

    -- Already converted? Then this is a re-run.
    PERFORM 1 FROM information_schema.columns
      WHERE table_schema = tbl_schema AND table_name = spec.tbl
        AND column_name = spec.col AND data_type = 'bigint';
    IF FOUND THEN
      CONTINUE;
    END IF;

    -- ── TRAP 2: save and drop every dependent view ───────────────────────
    view_defs  := ARRAY[]::text[];
    view_names := ARRAY[]::text[];
    FOR v IN
      SELECT DISTINCT vn.nspname AS schema_name, vc.relname AS view_name
        FROM pg_depend d
        JOIN pg_rewrite r  ON r.oid = d.objid
        JOIN pg_class   vc ON vc.oid = r.ev_class
        JOIN pg_namespace vn ON vn.oid = vc.relnamespace
        JOIN pg_class   tc ON tc.oid = d.refobjid
        JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       WHERE tc.relname = spec.tbl AND tn.nspname = tbl_schema
         AND vc.relkind = 'v'
    LOOP
      view_names := view_names || format('%I.%I', v.schema_name, v.view_name);
      view_defs  := view_defs  || pg_get_viewdef(
                      format('%I.%I', v.schema_name, v.view_name)::regclass, true);
      EXECUTE format('DROP VIEW %I.%I', v.schema_name, v.view_name);
    END LOOP;

    -- ── The column ───────────────────────────────────────────────────────
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE bigint',
                   tbl_schema, spec.tbl, spec.col);

    -- ── TRAP 1: the sequence, which is the line that actually matters ────
    seq_name := pg_get_serial_sequence(format('%I.%I', tbl_schema, spec.tbl), spec.col);
    IF seq_name IS NOT NULL THEN
      EXECUTE format('ALTER SEQUENCE %s AS bigint MAXVALUE 9223372036854775807', seq_name);
    END IF;

    -- ── Put the views back exactly as they were ──────────────────────────
    FOR i IN 1 .. coalesce(array_length(view_names, 1), 0) LOOP
      EXECUTE format('CREATE VIEW %s AS %s', view_names[i], view_defs[i]);
    END LOOP;

    RAISE NOTICE 'converted %.% (%) to bigint', tbl_schema, spec.tbl, spec.col;
  END LOOP;
END
$migrate$;

-- Recreating a view drops the grants that were on it, and the RADIUS role
-- reads `public.radacct` through exactly such a view. Without this, FreeRADIUS
-- loses read access the moment this migration runs — an outage caused by the
-- fix. Applied unconditionally and tolerantly: the role does not exist on a
-- development database, and that must not fail the migration.
DO $grants$
DECLARE
  radius_role text;
BEGIN
  SELECT rolname INTO radius_role FROM pg_roles
   WHERE pg_has_role(rolname, 'USAGE')
     AND rolname NOT IN ('postgres', current_user)
     AND rolcanlogin
   LIMIT 1;

  IF to_regclass('public.radacct') IS NOT NULL AND radius_role IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.radacct TO %I', radius_role);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grant refresh skipped: %', SQLERRM;
END
$grants$;
