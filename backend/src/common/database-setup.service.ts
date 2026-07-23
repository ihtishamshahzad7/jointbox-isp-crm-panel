import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
      `CREATE OR REPLACE FUNCTION public.archive_radacct(retain_days int DEFAULT 90)
       RETURNS bigint AS $fn$
       DECLARE moved bigint;
       BEGIN
         WITH cut AS (
           DELETE FROM public.radacct
            WHERE acctstoptime IS NOT NULL
              AND acctstoptime < NOW() - (retain_days || ' days')::interval
           RETURNING *)
         INSERT INTO archive.radacct SELECT * FROM cut;
         GET DIAGNOSTICS moved = ROW_COUNT;
         RETURN moved;
       END; $fn$ LANGUAGE plpgsql`,
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
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='public' AND tableowner <> $1`,
        dbUser,
      );
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
   * Age out old closed sessions. Call from a cron/scheduled task, or expose it
   * so the panel can run it — no external psql needed.
   */
  async archiveOldSessions(retainDays = Number(process.env.RADACCT_RETAIN_DAYS || 90)) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT archive_radacct($1) AS moved`,
        retainDays,
      );
      const moved = Number(rows?.[0]?.moved ?? 0);
      if (moved) this.logger.log(`Archived ${moved} session(s) older than ${retainDays} days`);
      return { moved, retainDays };
    } catch (e: any) {
      this.logger.warn(`Archive run failed: ${e?.message || e}`);
      return { moved: 0, retainDays, error: e?.message };
    }
  }
}
