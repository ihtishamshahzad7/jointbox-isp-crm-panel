import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Syslog archive — the raw feed, written to disk.
 *
 * WHY A FILE ARCHIVE WHEN EVERY LINE IS ALREADY IN POSTGRES
 *
 * The `syslog_event` table is the queryable, alertable, UI-facing copy, and it
 * is deliberately lossy: the message is truncated to 800 characters, the raw
 * line to 2048, and rows are aged out so the table stays fast. That is the
 * right trade for a live console and the wrong one for an audit trail.
 *
 * A file archive is what an investigation actually needs months later — the
 * complete byte-for-byte line, cheap to keep for a year, greppable with the
 * tools an operator already knows, and trivially shipped off-box. This is the
 * part of Kiwi that people are really paying for, and the part that was still
 * missing here: "retention" meant "whatever fits in the table".
 *
 * BEHAVIOUR
 *
 *   • One file per UTC day: <dir>/YYYY-MM-DD.log
 *   • Optionally one directory per source: <dir>/<source-ip>/YYYY-MM-DD.log
 *   • Writes are buffered and flushed on a timer, not per line. A busy edge
 *     router can emit thousands of lines a second during a flap, and one
 *     synchronous write per line turns a network incident into a disk incident.
 *   • Old files are deleted by a daily cron, oldest first, honouring both a day
 *     count and a total size ceiling so the disk cannot fill.
 *
 * CONFIGURATION (env, all optional)
 *   SYSLOG_ARCHIVE=off              disable entirely (default: on)
 *   SYSLOG_ARCHIVE_DIR=/var/log/jointbox-syslog
 *   SYSLOG_ARCHIVE_DAYS=90          delete files older than this
 *   SYSLOG_ARCHIVE_MAX_MB=5000      total ceiling across all files
 *   SYSLOG_ARCHIVE_PER_SOURCE=on    one subdirectory per sending IP
 */
@Injectable()
export class NdmSyslogArchiveService implements OnModuleDestroy {
  private readonly log = new Logger('NdmSyslogArchive');

  private readonly enabled = (process.env.SYSLOG_ARCHIVE || 'on').toLowerCase() !== 'off';
  private readonly dir =
    process.env.SYSLOG_ARCHIVE_DIR || path.join(process.cwd(), 'data', 'syslog-archive');
  private readonly days = Math.max(1, Number(process.env.SYSLOG_ARCHIVE_DAYS || 90));
  private readonly maxBytes =
    Math.max(100, Number(process.env.SYSLOG_ARCHIVE_MAX_MB || 5000)) * 1024 * 1024;
  private readonly perSource =
    (process.env.SYSLOG_ARCHIVE_PER_SOURCE || 'off').toLowerCase() === 'on';

  /** Pending lines, keyed by the file they belong in. */
  private buffers = new Map<string, string[]>();
  private flushTimer?: NodeJS.Timeout;
  private pendingLines = 0;
  private stats = { written: 0, dropped: 0, lastError: null as string | null, lastWriteAt: null as Date | null };

  private static readonly FLUSH_MS = 2000;
  private static readonly FLUSH_LINES = 500;
  /**
   * If the disk stops accepting writes we must not grow the buffer without
   * limit — the receiver would take the process down with it, losing the live
   * alerting that matters more than the archive.
   */
  private static readonly MAX_BUFFERED = 50_000;

  /**
   * Append one received line. Called from the receiver's hot path, so it does
   * no I/O and never throws: archiving is best-effort by design, and must not
   * be able to break syslog reception.
   */
  append(raw: string, srcIp: string, receivedAt = new Date()) {
    if (!this.enabled || !raw) return;

    if (this.pendingLines >= NdmSyslogArchiveService.MAX_BUFFERED) {
      this.stats.dropped++;
      return;
    }

    const day = receivedAt.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
    const file = this.perSource
      ? path.join(this.dir, this.safeName(srcIp), `${day}.log`)
      : path.join(this.dir, `${day}.log`);

    // ISO timestamp + source prefix: the raw line's own timestamp is whatever
    // the device's clock said, which during an incident is exactly the thing
    // you cannot trust. Recording our receive time alongside it makes the file
    // correlatable with everything else on the server.
    const line = `${receivedAt.toISOString()} ${srcIp} ${raw.replace(/\r?\n/g, ' ')}\n`;

    const buf = this.buffers.get(file);
    if (buf) buf.push(line);
    else this.buffers.set(file, [line]);
    this.pendingLines++;

    if (this.pendingLines >= NdmSyslogArchiveService.FLUSH_LINES) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), NdmSyslogArchiveService.FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Write everything buffered. Safe to call concurrently. */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.buffers.size) return;

    const batch = this.buffers;
    this.buffers = new Map();
    this.pendingLines = 0;

    for (const [file, lines] of batch) {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, lines.join(''), 'utf8');
        this.stats.written += lines.length;
        this.stats.lastWriteAt = new Date();
      } catch (e: any) {
        this.stats.dropped += lines.length;
        const msg = String(e?.message || e).slice(0, 300);
        // Log the first failure and then stay quiet: a full disk would
        // otherwise produce one error line per flush, forever.
        if (this.stats.lastError !== msg) {
          this.log.error(`Syslog archive write failed (${file}): ${msg}`);
        }
        this.stats.lastError = msg;
      }
    }
  }

  async onModuleDestroy() {
    await this.flush();
  }

  /**
   * Retention. Runs on the primary instance only — eleven web workers racing to
   * delete the same files would each see the others' deletions as errors.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge() {
    if (!isPrimaryInstance() || !this.enabled) return;
    try {
      const files = await this.listFiles();
      const cutoff = Date.now() - this.days * 86400_000;

      let freed = 0;
      let removed = 0;

      // Age first.
      for (const f of files) {
        if (f.mtimeMs < cutoff) {
          await fs.promises.unlink(f.file).catch(() => {});
          freed += f.size;
          removed++;
          f.deleted = true;
        }
      }

      // Then the size ceiling: oldest first until we are under it. Age-based
      // retention alone cannot protect the disk, because how much 90 days
      // weighs depends entirely on how chatty the network was.
      let total = files.filter((f) => !f.deleted).reduce((a, f) => a + f.size, 0);
      if (total > this.maxBytes) {
        const oldest = files.filter((f) => !f.deleted).sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const f of oldest) {
          if (total <= this.maxBytes) break;
          await fs.promises.unlink(f.file).catch(() => {});
          total -= f.size;
          freed += f.size;
          removed++;
        }
      }

      if (removed) {
        this.log.log(
          `Archive purge: removed ${removed} file(s), freed ${(freed / 1048576).toFixed(1)} MB ` +
            `(keep ${this.days} days, ceiling ${(this.maxBytes / 1048576).toFixed(0)} MB).`,
        );
      }
    } catch (e: any) {
      this.log.warn(`Archive purge failed: ${e?.message || e}`);
    }
  }

  /** Status for the UI — real numbers off the filesystem, never estimated. */
  async status() {
    if (!this.enabled) {
      return {
        enabled: false,
        directory: this.dir,
        note: 'Archiving is switched off (SYSLOG_ARCHIVE=off). Syslog is still received, stored in the database and alerted on.',
      };
    }
    let files: ArchiveFile[] = [];
    let readable = true;
    try {
      files = await this.listFiles();
    } catch {
      readable = false;
    }
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    return {
      enabled: true,
      readable,
      directory: this.dir,
      perSource: this.perSource,
      retentionDays: this.days,
      maxBytes: this.maxBytes,
      fileCount: files.length,
      totalBytes,
      oldestFile: sorted[0] ? path.basename(sorted[0].file) : null,
      newestFile: sorted.length ? path.basename(sorted[sorted.length - 1].file) : null,
      linesWritten: this.stats.written,
      linesDropped: this.stats.dropped,
      lastWriteAt: this.stats.lastWriteAt,
      lastError: this.stats.lastError,
      buffered: this.pendingLines,
    };
  }

  /** The archive as a browsable list, newest first. */
  async listArchive() {
    if (!this.enabled) return [];
    const files = await this.listFiles().catch(() => [] as ArchiveFile[]);
    return files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => ({
        name: path.relative(this.dir, f.file).replace(/\\/g, '/'),
        size: f.size,
        modifiedAt: new Date(f.mtimeMs),
      }));
  }

  /**
   * Resolve a caller-supplied archive name to a real path.
   *
   * The name arrives from an HTTP request, so it is hostile until proven
   * otherwise: `..%2f..%2fetc%2fpasswd` is the obvious attempt. Resolving and
   * then requiring the result to sit inside the archive directory is the check
   * that actually holds, rather than blacklisting ".." and hoping.
   */
  resolveArchiveFile(name: string): string | null {
    if (!this.enabled || !name) return null;
    const full = path.resolve(this.dir, name);
    const root = path.resolve(this.dir);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    if (!full.endsWith('.log')) return null;
    return fs.existsSync(full) ? full : null;
  }

  private safeName(v: string): string {
    return v.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 64) || 'unknown';
  }

  private async listFiles(dir = this.dir): Promise<ArchiveFile[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // not created yet — nothing archived so far
    }
    const out: ArchiveFile[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await this.listFiles(full)));
      } else if (e.isFile() && e.name.endsWith('.log')) {
        const st = await fs.promises.stat(full).catch(() => null);
        if (st) out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }
}

interface ArchiveFile {
  file: string;
  size: number;
  mtimeMs: number;
  deleted?: boolean;
}
