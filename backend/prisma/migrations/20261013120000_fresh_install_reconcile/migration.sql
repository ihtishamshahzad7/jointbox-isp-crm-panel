-- =============================================================================
-- Reconcile the migrated schema with schema.prisma (end of the chain).
--
-- After every earlier migration has run on an EMPTY database, these are the
-- last differences from what Prisma generates for the current schema.prisma:
--   * enum values the application writes ("OutageCause");
--   * three money columns that must allow NULL (company invoices and platform
--     adjustments have no subscriber; the init migration created them NOT NULL);
--   * unique indexes the monitoring tables are declared with;
--   * eight foreign keys whose ON DELETE / ON UPDATE rule the init migration
--     created as RESTRICT while schema.prisma declares SET NULL / CASCADE;
--   * four log ids schema.prisma declares BigInt that 20260906120000 widened
--     only under lower-case names ("LoginLog", "ActivityLog", "SessionLog",
--     "NetworkLog" were never converted).
--
-- SAFE ON EXISTING DATABASES: idempotent. Anything already matching the schema
-- is left untouched (production databases built with `prisma db push` already
-- match, so this is a no-op there).
--   * a unique index that existing duplicate rows would violate is not forced;
--   * a foreign key is replaced inside a subtransaction, so if existing rows
--     violate it the original key is kept;
--   * a log table larger than ~1M rows / 256 MB is NOT widened here (that
--     rewrites the table under an exclusive lock);
-- each of these raises a WARNING naming the object instead of failing the
-- deploy. The subscriber delete path (SubscribersService.remove) deletes or
-- detaches dependent rows itself, so the FK rule change does not alter what a
-- delete removes. See docs/MIGRATIONS-FRESH-INSTALL.md.
-- =============================================================================


-- Session-local helper (pg_temp: gone when the migration's session ends).
-- Runs one DDL statement only where it is meaningful and still missing:
--   * skipped when the table is not a plain table here (e.g. radacct after
--     scripts/radius-schema-apply.sh turned it into a view over radius.radacct);
--   * an object that already exists is left exactly as it is;
--   * a constraint the EXISTING data violates is not forced: a WARNING names it
--     and the deploy continues (fresh databases have no data, so this never
--     applies to a new install).
CREATE OR REPLACE FUNCTION pg_temp.jbx_apply(p_table text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $jbx$
BEGIN
  IF p_table IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = p_table AND c.relkind IN ('r', 'p')) THEN
    RAISE NOTICE 'jointbox: skipped, % is not a table in this schema: %', p_table, left(p_sql, 140);
    RETURN;
  END IF;
  EXECUTE p_sql;
EXCEPTION
  WHEN duplicate_object OR duplicate_table OR duplicate_column THEN
    NULL; -- already present
  WHEN unique_violation OR foreign_key_violation OR not_null_violation OR check_violation THEN
    RAISE WARNING 'jointbox: not applied, existing rows conflict: % (%)', left(p_sql, 200), SQLERRM;
END
$jbx$;


-- A foreign key whose ON DELETE / ON UPDATE differs from schema.prisma is
-- re-created with the schema's rule. Drop and re-add happen in one
-- subtransaction: if existing rows violate the key, BOTH are undone (the
-- original key stays) and a WARNING names it.
CREATE OR REPLACE FUNCTION pg_temp.jbx_replace_fk(p_table text, p_name text, p_def text) RETURNS void
LANGUAGE plpgsql AS $jbx$
DECLARE cur text;
BEGIN
  SELECT pg_get_constraintdef(k.oid) INTO cur
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = p_table AND k.conname = p_name AND k.contype = 'f';
  IF cur IS NULL OR regexp_replace(cur, '\s+', ' ', 'g') = regexp_replace(p_def, '\s+', ' ', 'g') THEN RETURN; END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', p_table, p_name);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', p_table, p_name, p_def);
    RAISE NOTICE 'jointbox: % now %', p_name, p_def;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE WARNING 'jointbox: % kept as "%" — existing rows conflict with "%" (%)', p_name, cur, p_def, SQLERRM;
  END;
END
$jbx$;

-- integer -> bigint for a key column schema.prisma declares BigInt. Done here
-- only while the table is small (a fresh install: empty), because the change
-- rewrites the table under an exclusive lock. A large existing table is left
-- as it is with a WARNING; convert it in a maintenance window (see
-- docs/MIGRATIONS-FRESH-INSTALL.md). Prisma reads and writes BigInt fields on
-- an integer column correctly until then.
CREATE OR REPLACE FUNCTION pg_temp.jbx_widen_bigint(p_table text, p_col text) RETURNS void
LANGUAGE plpgsql AS $jbx$
DECLARE typ text; est real; seq text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod), c.reltuples INTO typ, est
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = p_table AND c.relkind IN ('r', 'p') AND a.attname = p_col;
  IF typ IS DISTINCT FROM 'integer' THEN RETURN; END IF;
  -- reltuples is -1 on a table never analysed, so the on-disk size decides too
  IF est > 1000000 OR pg_total_relation_size(format('%I', p_table)::regclass) > 268435456 THEN
    RAISE WARNING 'jointbox: %.% left as integer (about % rows) — convert to bigint in a maintenance window', p_table, p_col, greatest(est, 0)::bigint;
    RETURN;
  END IF;
  EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE bigint', p_table, p_col);
  RAISE NOTICE 'jointbox: %.% widened to bigint', p_table, p_col;
  seq := pg_get_serial_sequence(format('%I', p_table), p_col);
  IF seq IS NOT NULL THEN EXECUTE format('ALTER SEQUENCE %s AS bigint', seq); END IF;
EXCEPTION WHEN feature_not_supported OR dependent_objects_still_exist THEN
  RAISE WARNING 'jointbox: %.% left as integer — %', p_table, p_col, SQLERRM;
END
$jbx$;

ALTER TYPE "OutageCause" ADD VALUE IF NOT EXISTS 'POWER_RELATED';
ALTER TYPE "OutageCause" ADD VALUE IF NOT EXISTS 'FIBER_CUT';
ALTER TYPE "OutageCause" ADD VALUE IF NOT EXISTS 'EQUIPMENT_FAILURE';
ALTER TYPE "OutageCause" ADD VALUE IF NOT EXISTS 'UPSTREAM_ISP';
SELECT pg_temp.jbx_apply('BalanceTransaction', 'ALTER TABLE "BalanceTransaction" ALTER COLUMN "subscriberId" DROP NOT NULL');
SELECT pg_temp.jbx_apply('Invoice', 'ALTER TABLE "Invoice" ALTER COLUMN "subscriberId" DROP NOT NULL');
SELECT pg_temp.jbx_apply('Payment', 'ALTER TABLE "Payment" ALTER COLUMN "subscriberId" DROP NOT NULL');
SELECT pg_temp.jbx_apply('network_interface', 'CREATE UNIQUE INDEX IF NOT EXISTS "network_interface_deviceId_ifIndex_key" ON network_interface USING btree ("deviceId", "ifIndex")');
SELECT pg_temp.jbx_apply('snmp_configuration', 'CREATE UNIQUE INDEX IF NOT EXISTS "snmp_configuration_deviceId_key" ON snmp_configuration USING btree ("deviceId")');
SELECT pg_temp.jbx_apply('syslog_server_setting', 'CREATE UNIQUE INDEX IF NOT EXISTS syslog_server_setting_protocol_key ON syslog_server_setting USING btree (protocol)');
SELECT pg_temp.jbx_replace_fk('BalanceTransaction', 'BalanceTransaction_subscriberId_fkey', 'FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"(id) ON UPDATE CASCADE ON DELETE SET NULL');
SELECT pg_temp.jbx_replace_fk('Invoice', 'Invoice_subscriberId_fkey', 'FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"(id) ON UPDATE CASCADE ON DELETE SET NULL');
SELECT pg_temp.jbx_replace_fk('Payment', 'Payment_subscriberId_fkey', 'FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"(id) ON UPDATE CASCADE ON DELETE SET NULL');
SELECT pg_temp.jbx_replace_fk('ServiceSettings', 'ServiceSettings_subscriberId_fkey', 'FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"(id) ON UPDATE CASCADE ON DELETE CASCADE');
SELECT pg_temp.jbx_replace_fk('SessionLog', 'SessionLog_userId_fkey', 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE');
SELECT pg_temp.jbx_replace_fk('Ticket', 'Ticket_subscriberId_fkey', 'FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"(id) ON UPDATE CASCADE ON DELETE CASCADE');
SELECT pg_temp.jbx_replace_fk('UserBalanceTransaction', 'UserBalanceTransaction_userId_fkey', 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE');
SELECT pg_temp.jbx_replace_fk('prefix_allocation', 'prefix_allocation_poolId_fkey', 'FOREIGN KEY ("poolId") REFERENCES prefix_pool(id) ON UPDATE CASCADE ON DELETE SET NULL');
SELECT pg_temp.jbx_widen_bigint('ActivityLog', 'id');
SELECT pg_temp.jbx_widen_bigint('LoginLog', 'id');
SELECT pg_temp.jbx_widen_bigint('NetworkLog', 'id');
SELECT pg_temp.jbx_widen_bigint('SessionLog', 'id');
