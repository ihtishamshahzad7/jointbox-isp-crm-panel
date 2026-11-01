# UPLINKO ISP CRM — Update 1D Migration Validation Report

## Gate: Disposable-PostgreSQL migration validation — **PASS**

This is the gate Update 1C left **BLOCKED** ("no disposable database available"). It
is now closed with real execution against a throwaway PostgreSQL 16 instance.

- **Branch:** `uplinko/update1b-integration` @ `3a0bc22`
- **Migrations under test:** `20261101120000_ledger_idempotency_key`, `20261101140000_nas_snmp_monitoring`
- **Where run:** a disposable PostgreSQL 16 cluster created with `initdb` in an
  isolated sandbox, destroyed afterwards. **No production, staging, or customer
  database was contacted.** The 57 migration `*.sql` files were copied
  **read-only** from the integration worktree; nothing in the worktree was modified.
- **Method:** plain `psql` applying the real migration SQL — this deliberately
  avoids the Prisma engine entirely, so the Prisma engine download being
  firewalled in CI sandboxes does not block this gate.

### What was executed

1. Applied **all 55 migrations before the two targets, in lexical (Prisma) order**,
   to a fresh database (`psql -v ON_ERROR_STOP=1 -f <each>`). This reconstructs the
   "expected existing schema" exactly as `prisma migrate deploy` would on a clean DB.
2. Seeded **representative existing data**: a `Subscriber` → `subscriber_balance`
   → `subscriber_balance_ledger` chain, and a `nas` row.
3. Applied `20261101120000_ledger_idempotency_key`, then
   `20261101140000_nas_snmp_monitoring`.
4. Re-applied both a second time (idempotency of the migrations themselves).
5. Ran assertions.

### Results

| # | Check | Result |
|---|---|---|
| 1 | 55 pre-target migrations apply in order on a fresh DB | **PASS** (0 failures) |
| 2 | `20261101120000_ledger_idempotency_key` applies on the existing schema | **PASS** |
| 3 | `20261101140000_nas_snmp_monitoring` applies on the existing schema | **PASS** |
| 4 | Both migrations are safely re-runnable (`IF NOT EXISTS` → NOTICE, no error) | **PASS** |
| 5 | Existing ledger row survived; `idempotencyKey` column present and **NULL** on it | **PASS** (rows=1, non-null keys=0) |
| 6 | `idempotencyKey` is `character varying(120)` | **PASS** |
| 7 | Unique index is **partial** (`… WHERE "idempotencyKey" IS NOT NULL`) | **PASS** |
| 8 | Multiple NULL idempotency keys allowed (no false clash on legacy rows) | **PASS** |
| 9 | Duplicate **non-null** idempotency key rejected (exactly-once enforced) | **PASS** (`duplicate key value violates unique constraint`) |
| 10 | `nas_snmp_state` + `nas_event` tables created | **PASS** |
| 11 | `nas_snmp_state` columns present (nasId, status, lastPollAt, lastSuccessAt, lastErrorAt, lastError, consecutiveFailures, nextPollAt, sysDescr, uptimeSec, updatedAt) | **PASS** |
| 12 | `nas_event` columns present (id, nasId, type, severity, message, details, ts, ownerId, acknowledged, acknowledgedAt, acknowledgedBy) | **PASS** |
| 13 | All 8 indexes created (`nas_snmp_state_status_idx`, `nas_snmp_state_nextPollAt_idx`, `nas_event_nasId_ts_idx`, `nas_event_nasId_type_ts_idx`, `nas_event_acknowledged_ts_idx`, `nas_event_ownerId_ts_idx`, + 2 PKs) | **PASS** |
| 14 | FKs to `nas` with `ON DELETE CASCADE` (both tables) | **PASS** |
| 15 | Cascade verified: seed state+event for a nas, `DELETE` the nas → rows gone (1/1 → 0/0) | **PASS** |
| 16 | Orphan FK rejected (`INSERT nas_event(nasId=999999)` → FK violation) | **PASS** |
| 17 | Existing data intact after both migrations (Subscriber=1, balance=1, ledger rows preserved) | **PASS** |

### Application order & existing-data compatibility

- Order is correct and additive: `…_ledger_idempotency_key` (index 56) then
  `…_nas_snmp_monitoring` (index 57), after `20261018120000_nas_l2tp_config`.
- Both are **non-destructive**: one `ADD COLUMN` (nullable) + one partial index,
  and two `CREATE TABLE IF NOT EXISTS` with FKs. No existing table or row is
  altered. Confirmed empirically (check 17).

### Recovery procedure (Prisma has no down-migrations)

Prisma Migrate does not generate or run rollback SQL. The supported recovery is:

- **Before deploying to staging:** take a database snapshot/backup
  (`pg_dump`/managed snapshot). To recover, restore that snapshot or recreate a
  fresh disposable database and replay migrations.
- **Manual reversal (both migrations are reversible by hand; additive only):**
  ```sql
  -- nas_snmp_monitoring
  DROP TABLE IF EXISTS "nas_event";
  DROP TABLE IF EXISTS "nas_snmp_state";
  -- ledger_idempotency_key
  DROP INDEX IF EXISTS "subscriber_balance_ledger_idempotencyKey_key";
  ALTER TABLE "subscriber_balance_ledger" DROP COLUMN IF EXISTS "idempotencyKey";
  ```
  (Both migration files also document these in-line.)

### Not covered here (documented, not claimed)

- TimescaleDB: `20260829020000_timescaledb_telemetry` is a guarded no-op without
  the extension (it emits a NOTICE and skips) — it applied cleanly; the two
  Update 1A/1B/1C target tables are **not** hypertables and do not require Timescale.
- Load/volume behaviour and `VACUUM`/bloat under production data were not tested
  (out of scope for a correctness gate).
- This validates the SQL migrations; it does not substitute for `prisma migrate
  deploy` on staging, which should still be run against a staging snapshot.
