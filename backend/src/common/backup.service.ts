import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * BackupService — automated PostgreSQL dumps.
 *
 * An ISP's entire business lives in this database: every subscriber, invoice,
 * payment and wallet balance. One disk failure without a backup ends the
 * company. This ran nowhere before, so it is the highest-value/lowest-effort
 * safeguard in the system.
 *
 * Uses `pg_dump` in custom format (-Fc), which is compressed and restorable
 * selectively with `pg_restore`. Old dumps are pruned so the disk can't fill.
 *
 * Config (.env):
 *   BACKUP_ENABLED=true
 *   BACKUP_DIR=/var/backups/jointbox
 *   BACKUP_RETAIN_DAYS=14
 *   BACKUP_CRON="0 2 * * *"     (informational — schedule is the @Cron below)
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  private get enabled() {
    return process.env.BACKUP_ENABLED !== 'false';
  }
  private get dir() {
    return process.env.BACKUP_DIR || '/var/backups/jointbox';
  }
  private get retainDays() {
    return Number(process.env.BACKUP_RETAIN_DAYS || 14);
  }

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Backups disabled (BACKUP_ENABLED=false)');
      return;
    }
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const list = await this.list();
      this.logger.log(
        `Backups → ${this.dir} (${list.length} existing, keeping ${this.retainDays} days)`,
      );
      if (!list.length) {
        // No backup has ever been taken — do one now rather than waiting for 2am.
        this.logger.warn('No backup found — taking an initial one now');
        setTimeout(() => this.run().catch(() => {}), 15_000).unref?.();
      }
    } catch (e: any) {
      this.logger.warn(`Backup directory not usable: ${e?.message || e}`);
    }
  }

  /** Nightly at 02:00 — before the billing jobs at 00:30/01:00/02:00 finish. */
  @Cron('0 2 * * *')
  async scheduled() {
    if (!this.enabled) return;
    await this.run();
  }

  /**
   * Take a dump now. Returns the file path and size.
   *
   * pg_dump is invoked with PGPASSWORD in the environment rather than embedded
   * in the URL, so the password never appears in the process list.
   */
  async run(): Promise<{ ok: boolean; file?: string; sizeMb?: number; error?: string }> {
    const conn = this.parseDatabaseUrl();
    if (!conn) return { ok: false, error: 'DATABASE_URL could not be parsed' };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(this.dir, `jointbox-${stamp}.dump`);

    try {
      await fs.mkdir(this.dir, { recursive: true });
      const started = Date.now();

      await execAsync(
        `pg_dump -h ${conn.host} -p ${conn.port} -U ${conn.user} -d ${conn.database} -Fc -f "${file}"`,
        {
          env: { ...process.env, PGPASSWORD: conn.password },
          maxBuffer: 1024 * 1024 * 64,
          timeout: 30 * 60 * 1000, // a large database can take a while
        },
      );

      const { size } = await fs.stat(file);
      const sizeMb = Math.round((size / 1024 / 1024) * 100) / 100;
      this.logger.log(`✅ Backup ${file} (${sizeMb} MB) in ${Date.now() - started}ms`);

      await this.prune();
      return { ok: true, file, sizeMb };
    } catch (e: any) {
      const msg = e?.message || String(e);
      // The most common cause by far is pg_dump not being installed.
      if (/not found|ENOENT/i.test(msg)) {
        this.logger.error('pg_dump not found — install it: sudo apt install postgresql-client');
      } else {
        this.logger.error(`Backup failed: ${msg.split('\n')[0]}`);
      }
      return { ok: false, error: msg };
    }
  }

  /** Delete dumps older than the retention window. */
  async prune() {
    try {
      const cutoff = Date.now() - this.retainDays * 24 * 60 * 60 * 1000;
      const files = await fs.readdir(this.dir);
      let removed = 0;
      for (const f of files) {
        if (!f.startsWith('jointbox-') || !f.endsWith('.dump')) continue;
        const p = join(this.dir, f);
        const st = await fs.stat(p);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(p);
          removed++;
        }
      }
      if (removed) this.logger.log(`Pruned ${removed} backup(s) older than ${this.retainDays} days`);
      return removed;
    } catch {
      return 0;
    }
  }

  /** Available backups, newest first — surfaced in the panel. */
  async list(): Promise<Array<{ file: string; sizeMb: number; takenAt: Date }>> {
    try {
      const files = await fs.readdir(this.dir);
      const rows = await Promise.all(
        files
          .filter((f) => f.startsWith('jointbox-') && f.endsWith('.dump'))
          .map(async (f) => {
            const st = await fs.stat(join(this.dir, f));
            return {
              file: f,
              sizeMb: Math.round((st.size / 1024 / 1024) * 100) / 100,
              takenAt: st.mtime,
            };
          }),
      );
      return rows.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
    } catch {
      return [];
    }
  }

  /**
   * Health summary for the dashboard: is there a recent backup at all?
   *
   * A backup system nobody checks is barely better than none — this makes a
   * stale or missing backup visible instead of silently broken.
   */
  async status() {
    const list = await this.list();
    const latest = list[0] ?? null;
    const ageHours = latest
      ? Math.round((Date.now() - latest.takenAt.getTime()) / 3_600_000)
      : null;
    return {
      enabled: this.enabled,
      directory: this.dir,
      retainDays: this.retainDays,
      count: list.length,
      latest,
      ageHours,
      healthy: !!latest && (ageHours ?? 999) < 48,
      warning: !latest
        ? 'No backup has ever been taken.'
        : (ageHours ?? 0) >= 48
          ? `Newest backup is ${ageHours}h old — the nightly job may be failing.`
          : null,
    };
  }

  /** The restore command for a given dump — shown in the UI, never auto-run. */
  restoreCommand(file: string) {
    const c = this.parseDatabaseUrl();
    if (!c) return null;
    return (
      `pg_restore -h ${c.host} -p ${c.port} -U ${c.user} -d ${c.database} ` +
      `--clean --if-exists "${join(this.dir, file)}"`
    );
  }

  private parseDatabaseUrl() {
    const url = process.env.DATABASE_URL || '';
    const m = /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/.exec(url);
    if (!m) return null;
    return { user: m[1], password: m[2], host: m[3], port: m[4], database: m[5] };
  }
}
