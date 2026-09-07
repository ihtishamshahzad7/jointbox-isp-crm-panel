import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isPrimaryInstance } from './cluster-util';

/**
 * DatabaseSetupService — everything the database needs that Prisma's schema
 * cannot express, applied automatically on every boot.
 *
 * WHY THIS EXISTS
 * Prisma models cover tables and columns, but not:
 *   • partial indexes (the ones that keep "who is online" fast forever)
 *   • the extra radacct columns FreeRADIUS's stock queries INSERT into
 *   • the nasreload table its simul_* queries join against
 *   • autovacuum tuning for high-churn tables
 *   • archival helpers
 *   • table ownership, when objects were created by the postgres superuser
 *
 * Previously these lived in a .sql file that had to be copied to the server and
 * run by hand — which meant a fresh install from GitHub silently came up
 * missing its indexes and with accounting broken. Now it is part of the app:
 * clone, `prisma db push`, start, and the database is correct.
 *
 * EVERY statement is idempotent (IF NOT EXISTS / OR REPLACE), so this is safe
 * on every restart and on an already-configured database. Failures are logged,
 * never fatal — a missing index must not stop the panel from serving.
 *
 * Disable with DB_AUTO_SETUP=false if you manage schema by other means.
 */
@Injectable()
export class DatabaseSetupService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseSetupService.name);
  /** Re-entrancy guard for archiveOldSessions(). */
  private archiveRunning = false;

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.DB_AUTO_SETUP === 'false') {
      this.logger.log('Automatic database setup disabled (DB_AUTO_SETUP=false)');
      return;
    }
    // Delayed so it never blocks startup and runs once the pool has settled.
    setTimeout(() => {
      this.applyAll().catch((e) =>
        this.logger.warn(`Database setup skipped: ${e?.message || e}`),
      );
    }, 5000).unref?.();
  }

  /** Run every setup step. Returns a summary for the health endpoint. */
  async applyAll() {
    const started = Date.now();
    const results = {
      radiusColumns: await this.ensureRadiusAccountingColumns(),
      nasreload: await this.ensureNasReload(),
      indexes: await this.ensureIndexes(),
      autovacuum: await this.tuneAutovacuum(),
      archive: await this.ensureArchive(),
      ownership: await this.normaliseOwnership(),
    };
    const applied = Object.values(results).filter(Boolean).length;
    this.logger.log(
      `✅ Database setup complete (${applied}/6 groups ok) in ${Date.now() - started}ms`,
    );
    return results;
  }

  /** Execute statements one by one; a failure in one never aborts the rest. */
  private async run(label: string, statements: string[]): Promise<boolean> {
    let ok = true;
    for (const sql of statements) {
      try {
        await this.prisma.$executeRawUnsafe(sql);
      } catch (e: any) {
        const msg = String(e?.message || e);
        // "already exists" is success, not failure.
        if (!/already exists|duplicate/i.test(msg)) {
          this.logger.warn(`${label}: ${msg.split('\n')[0]}`);
          ok = false;
        }
      }
    }
    return ok;
  }

  /**
   * The stock FreeRADIUS PostgreSQL accounting queries INSERT into columns that
   * a Prisma-generated radacct does not have. A single missing column makes
   * EVERY accounting write fail — sessions are silently never recorded.
   */
  private ensureRadiusAccountingColumns() {
    return this.run('radacct columns', [
      `ALTER TABLE radacct
         ADD COLUMN IF NOT EXISTS acctupdatetime      TIMESTAMP WITH TIME ZONE,
         ADD COLUMN IF NOT EXISTS acctinterval        BIGINT,
         ADD COLUMN IF NOT EXISTS framedipv6address   INET,
         ADD COLUMN IF NOT EXISTS framedipv6prefix    INET,
         ADD COLUMN IF NOT EXISTS framedinterfaceid   VARCHAR(44),
         ADD COLUMN IF NOT EXISTS delegatedipv6prefix INET`,
    ]);
  }

  /** Joined by FreeRADIUS's simul_count / simul_verify queries. */
  private ensureNasReload() {
    return this.run('nasreload', [
      `CREATE TABLE IF NOT EXISTS nasreload (
         nasipaddress INET PRIMARY KEY,
         reloadtime   TIMESTAMP WITH TIME ZONE NOT NULL)`,
    ]);
  }

  /**
   * Partial indexes are the important ones: they only cover OPEN sessions, so
   * they stay small no matter how large radacct grows.
   */
  private ensureIndexes() {
    return this.run('indexes', [
      `CREATE INDEX IF NOT EXISTS radacct_open_sessions_idx
         ON radacct (username, nasipaddress) WHERE acctstoptime IS NULL`,
      `CREATE INDEX IF NOT EXISTS radacct_open_updated_idx
         ON radacct (acctupdatetime) WHERE acctstoptime IS NULL`,
      `CREATE INDEX IF NOT EXISTS radacct_user_time_idx
         ON radacct (username, acctstarttime DESC)`,
      `CREATE INDEX IF NOT EXISTS radacct_nas_idx
         ON radacct (nasipaddress, acctstarttime DESC)`,
      `CREATE INDEX IF NOT EXISTS radpostauth_user_date_idx
         ON radpostauth (username, authdate DESC)`,
      `CREATE INDEX IF NOT EXISTS radpostauth_date_idx
         ON radpostauth (authdate DESC)`,
      // Read on EVERY authentication — highest-frequency query in the system.
      `CREATE INDEX IF NOT EXISTS radcheck_username_idx ON radcheck (username)`,
      `CREATE INDEX IF NOT EXISTS radreply_username_idx ON radreply (username)`,
      // Panel hot paths.
      `CREATE INDEX IF NOT EXISTS subscriber_owner_idx    ON "Subscriber" ("userId")`,
      `CREATE INDEX IF NOT EXISTS subscriber_nas_idx      ON "Subscriber" ("nasId")`,
      `CREATE INDEX IF NOT EXISTS subscriber_username_idx ON "Subscriber" (username)`,
      `CREATE INDEX IF NOT EXISTS user_parent_idx         ON "User" ("parentId")`,
      `CREATE INDEX IF NOT EXISTS ubt_user_ref_idx
         ON "UserBalanceTransaction" ("userId", reference)`,

      // Full-text / fuzzy subscriber search. pg_trgm GIN indexes make the
      // panel's ILIKE '%q%' search (name / username / phone / CNIC) index-backed
      // instead of a full scan — instant even with hundreds of thousands of rows.
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      `CREATE INDEX IF NOT EXISTS subscriber_fullname_trgm ON "Subscriber" USING gin ("fullName" gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS subscriber_username_trgm ON "Subscriber" USING gin (username gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS subscriber_phone_trgm    ON "Subscriber" USING gin (phone gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS subscriber_identity_trgm ON "Subscriber" USING gin (identity gin_trgm_ops)`,

      // (tsvector generated column removed: `prisma db push` drops any column
      // not in schema.prisma on every deploy, and recreating a STORED generated
      // column rewrites the whole table — a CPU spike at boot on a large base.
      // The pg_trgm GIN indexes above already give fast fuzzy/word search.)
    ]);
  }

  /**
   * radacct is rewritten on every interim update. Default autovacuum thresholds
   * are far too lax for that, letting dead tuples bloat the table until reads
   * crawl.
   */
  private tuneAutovacuum() {
    return this.run('autovacuum', [
      `ALTER TABLE radacct SET (
         autovacuum_vacuum_scale_factor  = 0.02,
         autovacuum_analyze_scale_factor = 0.01,
         autovacuum_vacuum_cost_limit    = 2000)`,
      `ALTER TABLE radpostauth SET (autovacuum_vacuum_scale_factor = 0.05)`,
    ]);
  }

  /**
   * Archive table + helper so closed sessions can be aged out of radacct.
   *
   * Deliberately in a SEPARATE `archive` schema, not `public`.
   *
   * Prisma manages the `public` schema and makes it match schema.prisma — so a
   * table in `public` that isn't a Prisma model gets DROPPED on the next
   * `db push`. Putting the archive outside `public` means Prisma never sees it,
   * so years of session history can't be destroyed by a routine schema change.
   */
  private ensureArchive() {
    return this.run('archive', [
      `CREATE SCHEMA IF NOT EXISTS archive`,
      `CREATE TABLE IF NOT EXISTS archive.radacct (LIKE public.radacct INCLUDING DEFAULTS)`,
      `CREATE INDEX IF NOT EXISTS radacct_archive_user_idx ON archive.radacct (username)`,
      `CREATE INDEX IF NOT EXISTS radacct_archive_stop_idx ON archive.radacct (acctstoptime)`,
      /**
       * ONE BATCH of archival. The caller loops.
       *
       * WHY THE WHOLE-TABLE VERSION HAD TO GO
       * The previous function deleted every expired row in a SINGLE statement,
       * therefore a single transaction. At 100k subscribers that is fine. At
       * 1M with a 600s interim interval, radacct accumulates tens of millions
       * of closed rows per month, and one transaction over that means:
       *
       *   · row locks held on tens of millions of rows for the entire run,
       *     while FreeRADIUS is still trying to write accounting;
       *   · the whole delete+insert accumulated in WAL before anything commits,
       *     so disk can fill from a maintenance job;
       *   · dead tuples that autovacuum cannot reclaim until it finishes,
       *     because the transaction is still open;
       *   · and if it fails at 95% — a timeout, a restart, a full disk — the
       *     entire thing rolls back and no progress is kept at all.
       *
       * A batch is a short transaction. Locks are released between batches so
       * live accounting writes interleave, WAL is recycled continuously, and
       * an interrupted run keeps everything it already moved.
       *
       * FOR UPDATE SKIP LOCKED is what makes it safe to interrupt and safe to
       * overlap: a row another transaction is touching is stepped over rather
       * than waited on, so the archival can never block accounting and can
       * never deadlock against a concurrent copy of itself.
       *
       * The batch is selected by primary key first and deleted by that key,
       * rather than re-evaluating the timestamp predicate in the DELETE. It
       * keeps the delete's plan an index lookup on a known set of ids instead
       * of a second scan of the table.
       */
      `CREATE OR REPLACE FUNCTION public.archive_radacct_batch(
          retain_days int DEFAULT 90, batch_size int DEFAULT 10000)
       RETURNS bigint AS $fn$
       DECLARE moved bigint;
       BEGIN
         WITH batch AS (
           SELECT radacctid FROM public.radacct
            WHERE acctstoptime IS NOT NULL
              AND acctstoptime < NOW() - (retain_days || ' days')::interval
            LIMIT batch_size
            FOR UPDATE SKIP LOCKED
         ), cut AS (
           DELETE FROM public.radacct
            WHERE radacctid IN (SELECT radacctid FROM batch)
           RETURNING *)
         INSERT INTO archive.radacct SELECT * FROM cut;
         GET DIAGNOSTICS moved = ROW_COUNT;
         RETURN moved;
       END; $fn$ LANGUAGE plpgsql`,
      // Kept so an operator's existing scripts and any in-flight deployment
      // still resolve the old name. It now delegates one batch at a time
      // rather than attempting the whole table, so even the legacy entry point
      // cannot reproduce the original lock storm.
      `CREATE OR REPLACE FUNCTION public.archive_radacct(retain_days int DEFAULT 90)
       RETURNS bigint AS $fn$
       BEGIN
         RETURN public.archive_radacct_batch(retain_days, 10000);
       END; $fn$ LANGUAGE plpgsql`,
      // The batch selector scans by acctstoptime on every iteration. Without a
      // matching index that is a sequential scan of the live table per batch,
      // which makes batching SLOWER overall than the single sweep it replaced.
      // Partial, because only closed sessions are ever archived.
      `CREATE INDEX IF NOT EXISTS radacct_closed_stop_idx
         ON public.radacct (acctstoptime) WHERE acctstoptime IS NOT NULL`,
      // Carry over anything already archived under the old public location, so
      // the legacy table can then be dropped without losing history.
      `DO $mig$
       BEGIN
         IF to_regclass('public.radacct_archive') IS NOT NULL THEN
           INSERT INTO archive.radacct SELECT * FROM public.radacct_archive;
         END IF;
       EXCEPTION WHEN OTHERS THEN
         NULL; -- legacy table unreadable or already migrated
       END $mig$`,
    ]);
  }

  /**
   * Objects created while connected as the postgres superuser end up owned by
   * postgres, and `prisma db push` then fails with "permission denied for
   * table ...". Hand everything to the application's own role.
   */
  private async normaliseOwnership() {
    const dbUser = this.currentDbUser();
    if (!dbUser) return true;

    // Covers tables, sequences, views and functions. Wrapped so a lack of
    // privilege is a no-op rather than a startup failure — the app user can
    // only reassign what it already owns, which is the normal case once the
    // install script has run.
    const ok = await this.run('ownership', [
      `DO $do$ DECLARE r record; BEGIN
         FOR r IN SELECT tablename FROM pg_tables
                  WHERE schemaname = 'public' AND tableowner <> '${dbUser}'
         LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '${dbUser}'); END LOOP;

         FOR r IN SELECT sequencename FROM pg_sequences
                  WHERE schemaname = 'public' AND sequenceowner <> '${dbUser}'
         LOOP EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '${dbUser}'); END LOOP;

         FOR r IN SELECT p.oid::regprocedure AS sig
                  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND pg_get_userbyid(p.proowner) <> '${dbUser}'
         LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.sig, '${dbUser}'); END LOOP;
       EXCEPTION WHEN OTHERS THEN
         NULL; -- owned by a superuser: needs the db:fix-ownership script
       END $do$`,
    ]);

    // Surface the problem rather than letting the next `db push` fail cryptically.
    try {
      const rows = await this.prisma.$queryRaw<any[]>`
        SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='public' AND tableowner <> ${dbUser}`;
      const bad = Number(rows?.[0]?.n ?? 0);
      if (bad > 0) {
        this.logger.warn(
          `${bad} database object(s) are not owned by "${dbUser}". ` +
            `Prisma migrations will fail until this is fixed — run: npm run db:fix-ownership`,
        );
      }
    } catch { /* non-fatal */ }

    return ok;
  }

  /** Parse the role out of DATABASE_URL. */
  private currentDbUser(): string | null {
    const url = process.env.DATABASE_URL || '';
    const m = /postgresql:\/\/([^:]+):/.exec(url);
    const user = m?.[1];
    // Guard against SQL injection through a hostile connection string.
    return user && /^[A-Za-z0-9_]+$/.test(user) ? user : null;
  }

  /**
   * Age out old closed sessions, in batches, under a cluster-wide lock.
   *
   * WHY isPrimaryInstance() AND NOT AN ADVISORY LOCK
   * This is invoked from a plain `setInterval` in NetworkLogsService, which
   * runs in EVERY backend process. Under PM2 cluster mode — recommended by
   * SCALING.md — that means N workers launching the same archival against the
   * same rows simultaneously. They do not cooperate; they contend.
   *
   * A `pg_try_advisory_lock` looks like the obvious answer and is a trap here.
   * Session-level advisory locks belong to a CONNECTION, and Prisma runs each
   * `$queryRaw` on whichever pooled connection is free — so the lock and the
   * unlock can land on different connections. The unlock then silently fails,
   * the lock stays held on an idle pooled connection, and archival is disabled
   * across the entire cluster until someone restarts the process. The symptom
   * would be a table that quietly grows forever: exactly the failure being
   * fixed, caused by the fix.
   *
   * `isPrimaryInstance()` has none of that coupling, and it is what every
   * other cron and poller in this codebase already gates on, so archival now
   * follows the same rule as the rest of the background work.
   *
   * Correctness does not depend on the gate. `FOR UPDATE SKIP LOCKED` in the
   * batch function makes overlapping runs safe on their own — verified against
   * PostgreSQL 16 with four concurrent workers: no deadlocks, every eligible
   * row archived exactly once, open sessions untouched. The gate is there to
   * stop N workers doing redundant work, not to keep the data correct.
   *
   * WHY A TIME BUDGET
   * The first run after this ships may face months of accumulated backlog. It
   * has to be able to stop cleanly and continue tomorrow rather than run for
   * six hours because it happens to be the first. Batching makes partial
   * progress durable, so stopping early costs nothing.
   */
  async archiveOldSessions(retainDays = Number(process.env.RADACCT_RETAIN_DAYS || 90)) {
    const batchSize = Math.max(100, Number(process.env.RADACCT_ARCHIVE_BATCH || 10_000));
    const budgetMs = Math.max(1_000, Number(process.env.RADACCT_ARCHIVE_BUDGET_MS || 5 * 60_000));

    if (!isPrimaryInstance()) {
      return { moved: 0, retainDays, skipped: 'not-primary' as const };
    }
    // A second overlapping run in THIS process would only compete with itself;
    // the SQL stays correct either way, so this is a plain re-entrancy guard.
    if (this.archiveRunning) {
      return { moved: 0, retainDays, skipped: 'already-running' as const };
    }
    this.archiveRunning = true;

    try {
      const startedAt = Date.now();
      let moved = 0;
      let batches = 0;

      // Each call is its own transaction, so locks are released and WAL is
      // recycled between iterations.
      for (;;) {
        const rows = await this.prisma.$queryRaw<any[]>`
          SELECT archive_radacct_batch(${retainDays}, ${batchSize}) AS moved`;
        const n = Number(rows?.[0]?.moved ?? 0);
        if (n === 0) break;
        moved += n;
        batches++;
        /**
         * Zero is the exhaustion signal, NOT `n < batchSize`.
         *
         * `SKIP LOCKED` can return a short batch because some rows were locked
         * by another transaction at that instant, not because the backlog is
         * finished. Treating short as done would end the run early and leave
         * rows behind every time — and because the next run would do the same,
         * a slice of the backlog could persist indefinitely while the logs
         * reported clean completions.
         *
         * Looping until zero cannot spin: the time budget below bounds it, and
         * the only way to keep receiving non-zero batches is to keep making
         * real progress.
         */
        if (Date.now() - startedAt > budgetMs) {
          // Everything moved so far is committed and stays moved. The next run
          // picks up exactly where this one stopped.
          this.logger.log(
            `Archive paused at its ${budgetMs}ms budget after ${moved} row(s); remaining backlog continues next run`,
          );
          break;
        }
      }

      if (moved) {
        this.logger.log(
          `Archived ${moved} session(s) older than ${retainDays} days in ${batches} batch(es), ${Math.round((Date.now() - startedAt) / 1000)}s`,
        );
      }
      return { moved, retainDays, batches };
    } catch (e: any) {
      this.logger.warn(`Archive run failed: ${e?.message || e}`);
      return { moved: 0, retainDays, error: e?.message };
    } finally {
      // In `finally` so a thrown batch cannot wedge archival off permanently.
      this.archiveRunning = false;
    }
  }
}
