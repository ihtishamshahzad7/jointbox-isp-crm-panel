import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'fs';
import { chmod, chown, mkdir, open, rename, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { isPrimaryInstance } from '../common/cluster-util';
import {
  BROKEN_WILDCARD_INCLUDE,
  VAULT_FILE_NAME,
  VAULT_INCLUDE_LINE,
  detectClientMode,
  renderClients,
  secretProblem,
  staticClientIps,
  VaultNasRow,
  normaliseIp,
} from './radius-clients-render';
import * as host from './radius-host';

/** What one synchronisation did — returned to the screen that triggered it. */
export interface VaultResult {
  ok: boolean;
  mode: 'file' | 'sql';
  /** The client file now differs from before (FreeRADIUS needed a restart). */
  changed: boolean;
  restarted: boolean;
  clients: number;
  skipped: Array<{ id: number; ip: string | null; reason: string }>;
  message: string;
  at: string;
}

/**
 * THE BOUNDARY BETWEEN THE ENCRYPTED ROUTER SECRETS AND FREERADIUS.
 *
 * Router (NAS) shared secrets are stored encrypted (nas.radius_secret_enc).
 * FreeRADIUS cannot read that, so this service renders the routers into one
 * file — clients.d/jointbox-nas.conf — and makes FreeRADIUS load it.
 *
 * Safe by construction, because a broken client list means no customer can
 * sign in anywhere:
 *
 *   • MODE FOLLOWS THE SERVER. Until the server's FreeRADIUS has been switched
 *     to the file (scripts/radius-vault-cutover.sh, run by the update script),
 *     FreeRADIUS still reads secrets from the database, so the plaintext column
 *     is kept and nothing is cleared. Only once the file is the source does the
 *     plaintext go.
 *   • NEVER A PARTIAL FILE. If any active router's secret cannot be decrypted
 *     (SECRETS_KEY changed), the previous file is kept and the failure reported
 *     — dropping those routers would cut their customers off.
 *   • VALIDATE BEFORE RESTART. FreeRADIUS's own config check runs, as the user
 *     FreeRADIUS runs as, before every restart. If it fails, the previous file
 *     is put back and the running FreeRADIUS is not touched.
 *   • CONFIRM AFTER RESTART. If FreeRADIUS does not come back up, the previous
 *     file is restored and it is restarted again.
 *   • ONE WRITER PER MACHINE. pm2 cluster workers and the cutover script take
 *     the same host lock; changes made while a sync runs are folded into ONE
 *     follow-up sync (one restart), not one restart each.
 *   • SELF-HEALING. Every few minutes the primary instance compares FreeRADIUS's
 *     file with the database and re-syncs if they differ or the last sync
 *     failed — a change made while FreeRADIUS was down is applied once it is
 *     back.
 *   • READABLE ONLY BY FREERADIUS. Written atomically (new file, fsync,
 *     rename), 0640, owner root, group = the FreeRADIUS config group.
 */
@Injectable()
export class RadiusClientVaultService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RadiusClientVaultService.name);
  private running: Promise<VaultResult> | null = null;
  private queued: Promise<VaultResult> | null = null;
  private last: VaultResult | null = null;
  /** The last failure is one a later sync could fix (FreeRADIUS down, lock busy…). */
  private lastRetry = false;
  private lastLogged: { message: string; at: number } | null = null;
  private modeCache: { mode: 'file' | 'sql'; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  // ── where things are ─────────────────────────────────────────────

  /** FreeRADIUS config directory on this server, or null when it is not here. */
  radDir(): string | null {
    return host.radDir();
  }

  get filePath(): string | null {
    const env = (process.env.FREERADIUS_CLIENTS_FILE || '').trim();
    if (env) return env;
    const dir = this.radDir();
    return dir ? join(dir, 'clients.d', VAULT_FILE_NAME) : null;
  }

  private readText(p: string | null): string | null {
    if (!p) return null;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }

  /** Where FreeRADIUS takes router secrets from on this server (see detectClientMode). */
  mode(): 'file' | 'sql' {
    const forced = (process.env.RADIUS_CLIENTS_MODE || '').trim().toLowerCase();
    if (forced === 'file' || forced === 'sql') return forced;
    if (this.modeCache && Date.now() - this.modeCache.at < 10_000)
      return this.modeCache.mode;
    const dir = this.radDir();
    const mode = dir
      ? detectClientMode(
          this.readText(join(dir, 'clients.conf')),
          this.readText(join(dir, 'mods-enabled', 'sql')),
        )
      : 'sql';
    this.modeCache = { mode, at: Date.now() };
    return mode;
  }

  /** mode(), read fresh from the config files (no 10-second cache). */
  refreshMode(): 'file' | 'sql' {
    this.modeCache = null;
    return this.mode();
  }

  /** The secret FreeRADIUS needs for one router: the vault copy, else legacy plaintext. */
  secretOf(row: {
    radiusSecretEnc?: string | null;
    secret?: string | null;
  }): string | null {
    if (row?.radiusSecretEnc) {
      const plain = this.secrets.decryptValue(row.radiusSecretEnc);
      if (plain != null) return plain;
    }
    return row?.secret || null;
  }

  // ── the database side ────────────────────────────────────────────

  /**
   * Every router with a plaintext secret gets a working encrypted copy: one is
   * added where missing, and one that no longer decrypts (the key changed
   * while the plaintext was still kept) is re-made from the plaintext. The
   * plaintext itself is only cleared once FreeRADIUS reads the file — see
   * clearPlaintext().
   */
  async encryptMissing(): Promise<number> {
    const rows = await this.prisma.nas.findMany({
      where: { secret: { not: null } },
      select: { id: true, secret: true, radiusSecretEnc: true },
    });
    let added = 0;
    let repaired = 0;
    for (const row of rows) {
      if (!row.secret || secretProblem(row.secret)) continue;
      if (
        row.radiusSecretEnc &&
        this.secrets.decryptValue(row.radiusSecretEnc) != null
      )
        continue;
      await this.prisma.nas.update({
        where: { id: row.id },
        data: { radiusSecretEnc: this.secrets.encryptValue(row.secret) },
      });
      if (row.radiusSecretEnc) repaired++;
      else added++;
    }
    if (added)
      this.logger.log(`Encrypted ${added} router secret(s) into the vault`);
    if (repaired)
      this.logger.warn(
        `Re-encrypted ${repaired} router secret(s) whose vault copy no longer decrypted (encryption key changed) from the kept plaintext`,
      );
    return added + repaired;
  }

  /**
   * SQL mode only: FreeRADIUS on this server still reads router secrets from
   * the database, so every router with only an encrypted copy (saved by an
   * earlier build that cleared the column too early) gets its plaintext back.
   * Without it FreeRADIUS does not know the router and every login times out.
   */
  async restorePlaintextForSql(): Promise<number> {
    if (this.mode() !== 'sql') return 0;
    const rows = await this.prisma.nas.findMany({
      where: { isActive: true, secret: null, radiusSecretEnc: { not: null } },
      select: { id: true, radiusSecretEnc: true },
    });
    let n = 0;
    for (const row of rows) {
      const plain = row.radiusSecretEnc
        ? this.secrets.decryptValue(row.radiusSecretEnc)
        : null;
      if (plain && !secretProblem(plain)) {
        await this.prisma.nas.update({
          where: { id: row.id },
          data: { secret: plain },
        });
        n++;
      }
    }
    if (n)
      this.logger.warn(
        `Put back ${n} router secret(s) FreeRADIUS reads from the database (server not yet switched to the vault file)`,
      );
    return n;
  }

  /**
   * SQL mode only: FreeRADIUS's client query loads EVERY row of the nas table
   * that has a secret — a router disabled in the panel included. Its plaintext
   * is withheld (the encrypted copy stays) so FreeRADIUS skips it, and
   * restorePlaintextForSql() puts it back when the router is enabled again.
   */
  async withholdInactiveForSql(): Promise<number> {
    if (this.mode() !== 'sql') return 0;
    const rows = await this.prisma.nas.findMany({
      where: {
        isActive: false,
        secret: { not: null },
        radiusSecretEnc: { not: null },
      },
      select: { id: true, secret: true, radiusSecretEnc: true },
    });
    let n = 0;
    for (const row of rows) {
      if (
        row.radiusSecretEnc &&
        this.secrets.decryptValue(row.radiusSecretEnc) === row.secret
      ) {
        await this.prisma.nas.update({
          where: { id: row.id },
          data: { secret: null },
        });
        n++;
      }
    }
    if (n)
      this.logger.log(
        `Withheld ${n} disabled router(s) from FreeRADIUS's SQL client list`,
      );
    return n;
  }

  /**
   * Has FreeRADIUS accepted accounting from this router address since `since`?
   * Accounting-Request packets are signed with the router's shared secret and
   * FreeRADIUS drops any that do not verify, so a radacct row written after
   * the cutover proves the secret FreeRADIUS now takes from the vault file is
   * the one the router uses.
   */
  async seenSince(ip: string, since: Date): Promise<Date | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ seen: Date | null }>>`
        SELECT max(greatest(acctstarttime, acctupdatetime, acctstoptime)) AS seen
        FROM radacct
        WHERE nasipaddress = ${ip}::inet
          AND (acctstarttime > ${since}
               OR acctstoptime > ${since}
               OR (acctstoptime IS NULL AND acctupdatetime > ${since}))`;
      const seen = rows?.[0]?.seen;
      return seen ? new Date(seen) : null;
    } catch {
      return null;
    }
  }

  /**
   * File mode only: retire LEGACY plaintext copies — the ones kept from before
   * the cutover — router by router, and only once that router is proven to work
   * through the vault file (seenSince the cutover). `all` retires every copy
   * whose encrypted twin decrypts to the same value, for an operator who has
   * tested logins by hand. A copy that does not round-trip is never touched.
   *
   * Reversible while the key is kept: if FreeRADIUS is ever switched back to
   * reading routers from SQL, restorePlaintextForSql() rebuilds the column
   * from the encrypted copies.
   */
  async retireProvenPlaintext(
    opts: { all?: boolean } = {},
  ): Promise<{ retired: number; kept: Array<{ id: number; reason: string }> }> {
    const kept: Array<{ id: number; reason: string }> = [];
    if (this.mode() !== 'file') return { retired: 0, kept };
    const rows = await this.prisma.nas.findMany({
      where: { secret: { not: null }, radiusSecretEnc: { not: null } },
      select: { id: true, nasIp: true, secret: true, radiusSecretEnc: true },
    });
    if (!rows.length) return { retired: 0, kept };
    const cutoverAt = host.readState().cutoverAt;
    const since = cutoverAt ? new Date(cutoverAt) : null;
    let retired = 0;
    for (const row of rows) {
      const same =
        !!row.radiusSecretEnc &&
        this.secrets.decryptValue(row.radiusSecretEnc) === row.secret;
      if (!same) {
        kept.push({
          id: row.id,
          reason:
            'encrypted copy differs from the plaintext — re-save the secret on the router page',
        });
        continue;
      }
      let proven = !!opts.all;
      if (!proven && since && row.nasIp)
        proven = !!(await this.seenSince(row.nasIp, since));
      if (!proven) {
        kept.push({
          id: row.id,
          reason: 'no accounting from this router through the vault file yet',
        });
        continue;
      }
      await this.prisma.nas.update({
        where: { id: row.id },
        data: { secret: null },
      });
      retired++;
    }
    if (retired) {
      this.logger.log(
        `Retired ${retired} legacy plaintext router secret(s)${opts.all ? ' (operator confirmed)' : ' — proven by accounting through the vault file'}`,
      );
    }
    host.writeState({
      retired: {
        at: new Date().toISOString(),
        count: retired,
        kept: kept.length,
      },
    });
    return { retired, kept };
  }

  // ── the file ─────────────────────────────────────────────────────

  private async render() {
    const rows = (await this.prisma.nas.findMany({
      select: {
        id: true,
        nasIp: true,
        nasname: true,
        shortname: true,
        isActive: true,
        secret: true,
        radiusSecretEnc: true,
      },
    })) as VaultNasRow[];
    const dir = this.radDir();
    const reserved = staticClientIps(
      dir ? this.readText(join(dir, 'clients.conf')) : null,
    );
    return renderClients(rows, {
      decrypt: (p) => this.secrets.decryptValue(p),
      reservedIps: reserved,
    });
  }

  /**
   * Write atomically: a new file (created exclusively, so nothing can be
   * pre-planted at its name), flushed to disk, then renamed over the old one.
   * A crash or power cut leaves either the old list or the new one — never an
   * empty or half-written file that would start FreeRADIUS with no routers.
   */
  private async writeClientFile(file: string, content: string): Promise<void> {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const rad = this.radDir();
    let gid: number | null = null;
    try {
      gid = rad ? statSync(rad).gid : null;
    } catch {
      gid = null;
    }
    if (gid != null) await chown(dir, 0, gid).catch(() => undefined);
    await chmod(dir, 0o750).catch(() => undefined);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fh = await open(tmp, 'wx', 0o640);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      if (gid != null) await chown(tmp, 0, gid).catch(() => undefined);
      await chmod(tmp, 0o640);
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    const dh = await open(dir, 'r').catch(() => null);
    if (dh)
      await dh
        .sync()
        .catch(() => undefined)
        .finally(() => dh.close());
  }

  /** True when the router file changed after the running FreeRADIUS started. */
  private async fileNewerThanFreeradius(file: string): Promise<boolean> {
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return false;
    }
    const started = await host.freeradiusStartedAt();
    // Not running / cannot tell: nothing to compare (the restart path handles
    // a stopped FreeRADIUS). 2s of slack for clock granularity.
    return started != null && mtime > started + 2000;
  }

  // ── the one entry point ──────────────────────────────────────────

  /**
   * Bring FreeRADIUS in line with the routers in the database. Called after a
   * router is added, changed, enabled/disabled or removed, and at start-up.
   *
   * At most one sync runs at a time in this process, and the host lock keeps
   * other processes out. A request that arrives while one is running joins
   * the single follow-up sync — it reads the database when it starts, so it
   * covers every change made in the meantime with one restart.
   */
  apply(reason: string): Promise<VaultResult> {
    if (this.queued) return this.queued;
    if (!this.running) return this.start(reason);
    this.queued = this.running
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.start(reason);
      });
    return this.queued;
  }

  private start(reason: string): Promise<VaultResult> {
    const p = host
      .withHostLock(() => this.applyNow(reason))
      .catch((e: unknown) =>
        this.done({
          ok: false,
          mode: this.mode(),
          changed: false,
          restarted: false,
          clients: 0,
          skipped: [],
          message: String(e instanceof Error ? e.message : e).slice(0, 300),
        }),
      )
      .finally(() => {
        if (this.running === p) this.running = null;
      });
    this.running = p;
    return p;
  }

  /** @deprecated kept for older call sites — same as apply('sync'). */
  async syncClients(): Promise<void> {
    await this.apply('sync');
  }

  private done(r: Omit<VaultResult, 'at'>, retry = true): VaultResult {
    const out = { ...r, at: new Date().toISOString() };
    this.last = out;
    this.lastRetry = !out.ok && retry;
    host.writeState(out.ok ? { last: out, lastOkAt: out.at } : { last: out });
    // The same failure repeated by the periodic re-check is logged once an hour.
    const repeat =
      this.lastLogged?.message === out.message &&
      Date.now() - this.lastLogged.at < 3_600_000;
    if (!out.ok && !repeat) {
      this.lastLogged = { message: out.message, at: Date.now() };
      this.logger.error(`RADIUS clients: ${out.message}`);
      this.prisma.systemLog
        ?.create?.({
          data: {
            level: 'ERROR',
            source: 'radius-vault',
            message: `RADIUS client sync failed: ${out.message}`.slice(0, 900),
          },
        })
        ?.catch?.(() => null);
    }
    return out;
  }

  private async applyNow(reason: string): Promise<VaultResult> {
    const lastFailed = !!this.last && !this.last.ok;
    this.modeCache = null;
    const mode = this.mode();
    const base = {
      mode,
      changed: false,
      restarted: false,
      clients: 0,
      skipped: [] as VaultResult['skipped'],
    };
    try {
      await this.encryptMissing();
      const r = await this.render();
      base.clients = r.clients.length;
      base.skipped = r.skipped;
      const file = this.filePath;

      // Legacy server: FreeRADIUS reads the plaintext column. Keep the file
      // ready for the switch (only where its directory already exists) and
      // restart so changed routers are re-read from the database.
      if (mode === 'sql') {
        const restored =
          (await this.restorePlaintextForSql()) +
          (await this.withholdInactiveForSql());
        if (file && existsSync(dirname(file)) && !r.undecryptable.length) {
          const before = this.readText(file);
          if (before !== r.content) await this.writeClientFile(file, r.content);
        }
        const broken = r.undecryptable.length
          ? ` ${r.undecryptable.length} router secret(s) cannot be decrypted (router #${r.undecryptable.join(', #')}) — re-enter them on the router page.`
          : '';
        // Nothing changed for FreeRADIUS at start-up or in a routine re-check
        // (unless the last restart failed): no restart.
        if (
          (reason === 'startup' && !restored) ||
          (reason === 'self-heal' && !restored && !lastFailed) ||
          !this.radDir()
        ) {
          return this.done(
            {
              ...base,
              ok: !broken,
              message: `FreeRADIUS reads routers from the database on this server (not switched to the vault file yet).${broken}`,
            },
            false,
          );
        }
        // Never restart into a configuration FreeRADIUS would refuse: the
        // running server keeps answering with what it has.
        const check = await host.validateConfig();
        if (!check.ok) {
          return this.done({
            ...base,
            ok: false,
            message: `FreeRADIUS was not restarted because its configuration has an error (it keeps running as it is): ${check.error}`,
          });
        }
        const rs = await host.restart();
        return this.done(
          {
            ...base,
            ok: rs.ok && !broken,
            restarted: rs.ok,
            message: rs.ok
              ? `FreeRADIUS restarted and re-read the routers.${broken}`
              : rs.error || 'FreeRADIUS restart failed.',
          },
          !rs.ok,
        );
      }

      if (!file)
        return this.done({
          ...base,
          ok: false,
          message:
            'FreeRADIUS configuration directory not found on this server.',
        });
      if (r.undecryptable.length) {
        return this.done(
          {
            ...base,
            ok: false,
            message:
              `${r.undecryptable.length} router secret(s) cannot be decrypted (router #${r.undecryptable.join(', #')}). ` +
              'The previous FreeRADIUS client list was kept. Check SECRETS_KEY in backend/.env has not changed, or re-enter those secrets on the router page.',
          },
          false,
        );
      }

      const before = this.readText(file);
      if (before === r.content && !(await this.fileNewerThanFreeradius(file))) {
        await this.retireProvenPlaintext();
        return this.done({
          ...base,
          ok: true,
          message: `FreeRADIUS is up to date (${r.clients.length} router(s)).`,
        });
      }

      // A current file that the RUNNING FreeRADIUS has not loaded yet (written
      // but never restarted after) is stale in effect: check and restart.
      if (before !== r.content) {
        await this.writeClientFile(file, r.content);
        base.changed = true;
      }
      const restore = async () => {
        if (!base.changed) return;
        if (before == null) await unlink(file).catch(() => undefined);
        else await this.writeClientFile(file, before);
      };

      const check = await host.validateConfig(r.clients);
      if (!check.ok) {
        await restore();
        return this.done({
          ...base,
          ok: false,
          message: `FreeRADIUS rejected the new client list, so the previous one was kept: ${check.error}`,
        });
      }
      const rs = await host.restart();
      if (!rs.ok) {
        await restore();
        await host.restart();
        return this.done({
          ...base,
          ok: false,
          message: `${(rs.error || 'FreeRADIUS did not restart').replace(/\.?$/, '.')} The previous client list was restored.`,
        });
      }
      base.restarted = true;
      if (!host.readState().cutoverAt)
        host.writeState({ cutoverAt: new Date().toISOString() });
      await this.retireProvenPlaintext();
      return this.done({
        ...base,
        ok: true,
        message: `FreeRADIUS ${base.changed ? 'reloaded' : 'restarted to load the current list'} with ${r.clients.length} router(s).`,
      });
    } catch (e: unknown) {
      return this.done({
        ...base,
        ok: false,
        message: String(e instanceof Error ? e.message : e).slice(0, 300),
      });
    }
  }

  // ── self-healing ─────────────────────────────────────────────────

  /**
   * Does FreeRADIUS need a sync? True when the last one failed, when the file
   * no longer matches the database (a change made while FreeRADIUS or this
   * process was down, an edit by hand), or — on a server still reading the
   * database — when a router's plaintext copy is missing.
   */
  async needsSync(): Promise<boolean> {
    if (this.last && !this.last.ok && this.lastRetry) return true;
    this.modeCache = null;
    if (this.mode() === 'sql') {
      if (!this.radDir()) return false;
      const [missing, inactiveLoaded] = await Promise.all([
        this.prisma.nas.count({
          where: {
            isActive: true,
            secret: null,
            radiusSecretEnc: { not: null },
          },
        }),
        this.prisma.nas.count({
          where: {
            isActive: false,
            secret: { not: null },
            radiusSecretEnc: { not: null },
          },
        }),
      ]);
      return missing + inactiveLoaded > 0;
    }
    const file = this.filePath;
    if (!file) return false;
    const r = await this.render();
    if (r.undecryptable.length) return false; // nothing a re-sync can fix; already reported
    return (
      this.readText(file) !== r.content ||
      (await this.fileNewerThanFreeradius(file))
    );
  }

  /** Periodic check (primary instance only): re-sync when needed. */
  async recheck(): Promise<VaultResult | null> {
    if (this.running) return null;
    try {
      if (!(await this.needsSync())) {
        await this.retireProvenPlaintext();
        return null;
      }
    } catch {
      return null;
    }
    return this.apply('self-heal');
  }

  onApplicationBootstrap(): void {
    if (!isPrimaryInstance() || process.env.NODE_ENV === 'test') return;
    // After the app is listening; never blocks start-up.
    this.startupTimer = setTimeout(() => {
      this.apply('startup').catch(() => undefined);
    }, 4000);
    this.startupTimer.unref?.();
    const every = Number(process.env.RADIUS_VAULT_RECHECK_MS ?? 300_000);
    if (every > 0) {
      this.timer = setInterval(
        () => {
          this.recheck().catch(() => undefined);
        },
        Math.max(every, 30_000),
      );
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  // ── for the platform account ─────────────────────────────────────

  async status() {
    const dir = this.radDir();
    const file = this.filePath;
    const clientsConf = dir ? this.readText(join(dir, 'clients.conf')) : null;
    const sqlMod = dir ? this.readText(join(dir, 'mods-enabled', 'sql')) : null;
    let fileInfo: {
      exists: boolean;
      mode?: string;
      groupReadable?: boolean;
      worldReadable?: boolean;
      clients?: number;
      matchesDatabase?: boolean;
      loadedByFreeradius?: boolean | null;
    } = { exists: false };
    const r = await this.render().catch(() => null);
    const startedAt = dir ? await host.freeradiusStartedAt() : null;
    if (file && existsSync(file)) {
      const st = statSync(file);
      let radGid: number | null = null;
      try {
        radGid = dir ? statSync(dir).gid : null;
      } catch {
        radGid = null;
      }
      const text = this.readText(file) || '';
      fileInfo = {
        exists: true,
        mode: (st.mode & 0o777).toString(8),
        groupReadable:
          !!(st.mode & 0o040) && (radGid == null || st.gid === radGid),
        worldReadable: !!(st.mode & 0o004),
        clients: (text.match(/^client jointbox-nas-/gm) || []).length,
        matchesDatabase: r ? text === r.content : undefined,
        loadedByFreeradius:
          startedAt == null ? null : st.mtimeMs <= startedAt + 2000,
      };
    }
    const [active, plaintext, encrypted, running] = await Promise.all([
      this.prisma.nas.count({ where: { isActive: true } }),
      this.prisma.nas.count({ where: { secret: { not: null } } }),
      this.prisma.nas.count({ where: { radiusSecretEnc: { not: null } } }),
      dir ? host.isRunning(1) : Promise.resolve(null),
    ]);
    const state = host.readState();
    return {
      freeradiusOnThisServer: !!dir,
      running,
      freeradiusStartedAt: startedAt ? new Date(startedAt).toISOString() : null,
      mode: this.mode(),
      file: { path: file, ...fileInfo },
      includeConfigured:
        !!clientsConf && detectClientMode(clientsConf, '') === 'file',
      brokenWildcardInclude:
        !!clientsConf && BROKEN_WILDCARD_INCLUDE.test(clientsConf),
      sqlReadsClients: /^\s*read_clients\s*=\s*(yes|true)\b/m.test(
        sqlMod || '',
      ),
      routers: {
        active,
        encrypted,
        /** Legacy plaintext copies still kept (retired per router once proven). */
        plaintext,
        inFile: r?.clients.length ?? null,
        skipped: r?.skipped ?? [],
        undecryptable: r?.undecryptable.length ?? 0,
      },
      syncing: !!this.running,
      // This worker's last result, else the last one any worker recorded.
      last: this.last ?? state.last ?? null,
      lastOkAt: state.lastOkAt ?? null,
      cutoverAt: state.cutoverAt ?? null,
      rolledBackAt: state.rolledBackAt ?? null,
      retired: state.retired ?? null,
      includeLine: VAULT_INCLUDE_LINE,
    };
  }

  /**
   * One line per router: is it in FreeRADIUS's list, why not, is a legacy
   * plaintext copy still kept, and when FreeRADIUS last accepted accounting
   * from it. `where` scopes the routers (a company sees only its own). Never
   * contains a secret.
   */
  async routerReport(where: Record<string, unknown>) {
    const rows = await this.prisma.nas.findMany({
      where,
      select: {
        id: true,
        nasIp: true,
        shortname: true,
        isActive: true,
        secret: true,
        radiusSecretEnc: true,
      },
      orderBy: { id: 'asc' },
    });
    const r = await this.render().catch(() => null);
    const inFile = new Set((r?.clients ?? []).map((c) => c.id));
    const skipped = new Map((r?.skipped ?? []).map((x) => [x.id, x.reason]));
    const ips = rows
      .map((x) => x.nasIp)
      .filter((x): x is string => !!x && !!normaliseIp(x));
    const seen = new Map<string, { last: Date | null; online: number }>();
    if (ips.length) {
      try {
        const acct = await this.prisma.$queryRaw<
          Array<{ ip: string; last: Date | null; online: bigint | number }>
        >`
          SELECT host(nasipaddress) AS ip,
                 max(greatest(acctstarttime, acctupdatetime, acctstoptime)) AS last,
                 count(*) FILTER (WHERE acctstoptime IS NULL) AS online
          FROM radacct
          WHERE nasipaddress = ANY(${ips}::inet[])
            AND (acctstoptime IS NULL
                 OR acctstoptime > now() - interval '1 day'
                 OR acctstarttime > now() - interval '1 day')
          GROUP BY 1`;
        for (const a of acct)
          seen.set(a.ip, {
            last: a.last ? new Date(a.last) : null,
            online: Number(a.online),
          });
      } catch {
        /* accounting table unavailable: leave unknown */
      }
    }
    const mode = this.mode();
    return rows.map((x) => {
      const ip = x.nasIp ? normaliseIp(x.nasIp) : null;
      const acct = ip ? seen.get(ip) : undefined;
      const state = !x.isActive
        ? 'disabled'
        : inFile.has(x.id)
          ? 'in-freeradius'
          : 'left-out';
      return {
        id: x.id,
        name: x.shortname || null,
        ip: x.nasIp,
        active: x.isActive,
        state,
        reason:
          state === 'left-out'
            ? skipped.get(x.id) || 'not in the router list'
            : null,
        hasSecret: !!(x.radiusSecretEnc || x.secret),
        legacyPlaintextKept: mode === 'file' && !!x.secret,
        lastAccountingAt: acct?.last ? acct.last.toISOString() : null,
        onlineSessions: acct?.online ?? 0,
      };
    });
  }
}
