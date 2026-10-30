import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusClientVaultService } from '../nas/radius-client-vault.service';
import * as host from '../nas/radius-host';
import { VAULT_INCLUDE_LINE } from '../nas/radius-clients-render';
import { tenancyHooks } from '../nas/radius-tenancy-site';

/** Installed and refreshed by scripts/radius-tenancy.sh; not edited here. */
export const TENANCY_POLICY_FILE = 'policy.d/jointbox-tenancy';

const run = promisify(exec);
const backupRoot = () => process.env.JOINTBOX_RADIUS_BACKUP_DIR || '/var/backups/jointbox-radius/admin';

/**
 * FreeRADIUS + database admin — SUPER_ADMIN only (enforced in the controller).
 *
 * Everything that writes touches system files as root, so it is deliberately
 * constrained:
 *   • paths are confined to the FreeRADIUS config tree, and the router file
 *     the panel generates (clients.d/), private keys and certificates (certs/)
 *     are off-limits — they hold every company's router secrets / TLS keys;
 *   • secret values are never sent to the browser: they show as <hidden> and
 *     a save puts the stored value back in its place;
 *   • every change is checked with FreeRADIUS's own config check, AS THE USER
 *     FREERADIUS RUNS AS, before a restart, and rolled back if it fails or if
 *     FreeRADIUS does not come back up;
 *   • backups go OUTSIDE the config tree — a copy left in sites-enabled/ or
 *     mods-enabled/ would itself be loaded and stop FreeRADIUS from starting;
 *   • the same host lock as the router vault, so a save never races a router
 *     sync.
 */
@Injectable()
export class RadiusAdminService {
  private readonly log = new Logger('RadiusAdmin');

  constructor(
    private prisma: PrismaService,
    private vault: RadiusClientVaultService,
  ) {}

  private get RAD(): string {
    return host.radDir() || '/etc/freeradius/3.0';
  }

  private async sh(cmd: string) {
    try { const { stdout, stderr } = await run(cmd, { maxBuffer: 8 * 1024 * 1024 }); return { ok: true, out: (stdout || stderr || '').trim() }; }
    catch (e: any) { return { ok: false, out: (e.stdout || '') + (e.stderr || e.message || '') }; }
  }

  /** Reject anything outside the FreeRADIUS config tree (path-traversal safe). */
  private safePath(rel: string): string {
    // Plain file names only — no quotes, spaces or shell metacharacters.
    // Allow both POSIX and Windows separators because this service runs in a
    // mixed Windows/Linux environment and path validation must stay consistent.
    const raw = String(rel || '');
    if (!/^[A-Za-z0-9._\\/-]+$/.test(raw)) {
      throw new BadRequestException('That is not a valid FreeRADIUS config path.');
    }
    const RAD = this.RAD;
    const cleanRel = raw.replace(/^[/\\]+/, '');
    const abs = path.resolve(RAD, cleanRel);
    const rootNorm = RAD.replace(/[\\/]+$/, '');
    const absNorm = abs.replace(/[\\/]+$/, '');
    if (absNorm !== rootNorm && !absNorm.startsWith(rootNorm + path.sep)) {
      throw new BadRequestException('Path is outside the FreeRADIUS config directory.');
    }
    const inside = path.relative(RAD, abs).replace(/\\/g, '/');
    if (/^clients\.d(\/|$)/.test(inside)) {
      throw new BadRequestException(
        'clients.d/ holds the router list the panel generates from the encrypted vault — change routers on the NAS page instead.',
      );
    }
    if (/^certs(\/|$)/.test(inside) || /\.(key|pem|p12|pfx|der|crt)$/i.test(inside)) {
      throw new BadRequestException('Certificates and private keys are not shown or edited from the panel.');
    }
    return abs;
  }

  /** A symlink inside the tree may point anywhere — resolve and re-check. */
  private async realSafePath(rel: string): Promise<string> {
    const abs = this.safePath(rel);
    const real = await fs.realpath(abs).catch(() => abs);
    const RAD = await fs.realpath(this.RAD).catch(() => this.RAD);
    if (real !== RAD && !real.startsWith(RAD + path.sep)) {
      throw new BadRequestException('Path is outside the FreeRADIUS config directory.');
    }
    this.safePath(path.relative(RAD, real));
    return real;
  }

  // ---- status -------------------------------------------------------------
  async status() {
    const [running, version, ports, check] = await Promise.all([
      host.isRunning(1),
      this.sh("freeradius -v 2>/dev/null | head -1"),
      this.sh("ss -ulnp 2>/dev/null | grep -E ':1812|:1813' || true"),
      host.validateConfig(),
    ]);
    return {
      running,
      version: version.out,
      listening: { auth1812: ports.out.includes(':1812'), acct1813: ports.out.includes(':1813') },
      configCheck: check.ok ? 'Configuration appears to be OK' : check.error,
    };
  }

  async control(action: 'restart' | 'stop' | 'start' | 'test') {
    if (action === 'test') {
      const c = await host.validateConfig();
      return { ok: c.ok, out: c.ok ? 'Configuration appears to be OK' : c.error };
    }
    if (!['restart', 'stop', 'start'].includes(action)) throw new BadRequestException('Invalid action');
    return host.withHostLock(async () => {
      // Validate config before a (re)start so we never leave RADIUS down.
      if (action !== 'stop') {
        const check = await host.validateConfig();
        if (!check.ok) return { ok: false, out: `Refusing to ${action}: config check failed.\n${check.error}` };
      }
      if (action === 'restart') {
        const r = await host.restart();
        return { ok: r.ok, out: r.ok ? 'FreeRADIUS restarted and running.' : r.error };
      }
      const r = await host.run('systemctl', [action, 'freeradius'], 45_000);
      if (action === 'start' && r.ok && !(await host.isRunning())) {
        return { ok: false, out: 'FreeRADIUS did not stay up (see: journalctl -u freeradius -n 50).' };
      }
      return { ok: r.ok, out: r.out.trim() || `FreeRADIUS ${action === 'stop' ? 'stopped' : 'started'}.` };
    });
  }

  // ---- modules (enable/disable) -------------------------------------------
  async modules() {
    const RAD = this.RAD;
    const [avail, enabled] = await Promise.all([
      fs.readdir(path.join(RAD, 'mods-available')).catch(() => [] as string[]),
      fs.readdir(path.join(RAD, 'mods-enabled')).catch(() => [] as string[]),
    ]);
    const enabledSet = new Set(enabled);
    // Modules the panel needs vs optional — surfaced so an operator knows what
    // is safe to turn off.
    const REQUIRED = new Set(['pap', 'chap', 'mschap', 'sql', 'preprocess', 'files', 'expiration', 'realm', 'detail', 'attr_filter', 'radutmp', 'exec', 'expr', 'unix', 'eap']);
    // Short "what it does · what breaks if OFF" per module.
    const DESC: Record<string, string> = {
      pap: 'Plain-password auth. OFF: PAP logins fail.',
      chap: 'CHAP auth. OFF: CHAP logins fail.',
      mschap: 'MS-CHAP (Windows/MikroTik PPPoE). OFF: most PPPoE logins break.',
      sql: 'Reads users & accounting from PostgreSQL — the panel’s brain. OFF: no one can authenticate.',
      eap: 'EAP for WiFi / 802.1X (PEAP, TTLS). OFF: WiFi/enterprise auth fails.',
      preprocess: 'Normalises incoming requests (hints, huntgroups). OFF: some NAS quirks break auth.',
      files: 'Static users file. OFF: file-based users ignored (panel uses SQL anyway).',
      expiration: 'Enforces the Expiration attribute. OFF: RADIUS expiry dates ignored.',
      logintime: 'Enforces Login-Time windows. OFF: time-of-day restrictions ignored.',
      detail: 'Writes raw accounting to a detail log (backup of radacct). OFF: no detail log.',
      'detail.log': 'Auth/reply audit detail logs. OFF: those audit logs stop.',
      radutmp: 'Tracks who is online (radwho / simultaneous-use). OFF: online tracking degraded.',
      sradutmp: 'Compact online-session log. OFF: sradutmp file not written.',
      attr_filter: 'Filters reply attributes to safe values. OFF: unfiltered replies sent.',
      exec: 'Runs external programs from policy. OFF: exec-based policies fail.',
      expr: 'Math/string expressions in config. OFF: expressions in policy fail.',
      unix: 'Auth against /etc/passwd. OFF: system-account login off (fine for an ISP).',
      realm: 'Splits user@realm for proxying/routing. OFF: realm routing off.',
      digest: 'SIP Digest auth (VoIP). OFF: SIP digest auth fails.',
      always: 'Test module that always returns a fixed result. Used in policy; harmless.',
      echo: 'Example exec module. Safe to leave as-is.',
      replicate: 'Copies requests to another server. OFF: replication off (usually fine).',
      linelog: 'One-line custom logging. OFF: those custom log lines stop.',
      passwd: 'Reads flat password files (e.g. /etc/passwd fields). OFF: that lookup off.',
      soh: 'Statement-of-Health (NAP). OFF: SoH off (rarely used).',
      unpack: 'Unpacks binary attributes in policy. OFF: those policies fail.',
      utf8: 'Allows UTF-8 usernames/passwords. OFF: non-ASCII logins may fail.',
      ntlm_auth: 'NTLM auth via winbind (AD). OFF: AD/NTLM auth off.',
      dynamic_clients: 'Learns NAS clients at runtime. OFF: only the routers in the panel’s router file.',
      cache_eap: 'Caches EAP sessions for faster reconnect. OFF: slightly slower EAP.',
      redis: 'Redis backend for RADIUS (not the panel’s Redis). Optional.',
      rest: 'Call external HTTP APIs from policy. Optional.',
      ldap: 'Authenticate against LDAP/AD. Optional — panel uses SQL.',
      perl: 'Run Perl from policy. Optional.',
      python: 'Run Python from policy. Optional.',
      python3: 'Run Python 3 from policy. Optional.',
      counter: 'Time/data counters in flat files. Panel handles quotas itself.',
      sqlcounter: 'SQL-based session/data counters. Optional (panel enforces FUP).',
      sqlippool: 'Assign IPs from a SQL pool. Optional — panel manages IP pools.',
      ippool: 'Assign IPs from a flat-file pool. Optional.',
      cache: 'Generic attribute cache. Optional tuning.',
    };
    return avail.filter((m) => !m.endsWith('.bak')).sort().map((name) => ({
      name,
      enabled: enabledSet.has(name),
      required: REQUIRED.has(name),
      desc: DESC[name] || 'Optional FreeRADIUS module — leave OFF unless a specific feature needs it.',
    }));
  }

  /**
   * Enable/disable a module. The change only stands if FreeRADIUS still
   * accepts its configuration — otherwise it is undone on the spot, so the
   * next restart (by anyone) cannot fail because of it.
   */
  async toggleModule(name: string, enable: boolean) {
    if (!/^[a-z0-9_\-]+$/i.test(name) || name.includes('..')) throw new BadRequestException('Invalid module name');
    const RAD = this.RAD;
    const availFile = path.join(RAD, 'mods-available', name);
    if (!(await fs.stat(availFile).then(() => true).catch(() => false))) {
      throw new BadRequestException(`Module "${name}" not found in mods-available.`);
    }
    const link = path.join(RAD, 'mods-enabled', name);
    return host.withHostLock(async () => {
      const before = await fs.readlink(link).catch(() => null);
      const wasFile = before == null && (await fs.lstat(link).then(() => true).catch(() => false));
      if (wasFile) throw new BadRequestException(`mods-enabled/${name} is a regular file, not a link — edit it on the server.`);
      try {
        if (enable) {
          await fs.unlink(link).catch(() => undefined);
          await fs.symlink(`../mods-available/${name}`, link);
        } else {
          await fs.unlink(link).catch(() => undefined);
        }
      } catch (err: any) {
        const code = err?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EINVAL') {
          await fs.unlink(link).catch(() => undefined);
          if (before != null) await fs.symlink(before, link).catch(() => undefined);
          return { name, enabled: !enable, configOk: false, reverted: true, check: `Symlink creation is not supported on this host for mods-enabled/${name}.` };
        }
        throw err;
      }
      const check = await host.validateConfig();
      if (!check.ok) {
        // Put it back exactly as it was.
        await fs.unlink(link).catch(() => undefined);
        if (before != null) await fs.symlink(before, link).catch(() => undefined);
        return { name, enabled: !enable, configOk: false, reverted: true, check: check.error };
      }
      return { name, enabled: enable, configOk: true, check: 'Configuration appears to be OK — restart FreeRADIUS to apply.' };
    });
  }

  // ---- config files -------------------------------------------------------
  /** The files an operator most often needs, plus the mods-enabled listing. */
  async files() {
    const key = [
      'radiusd.conf', 'clients.conf', 'proxy.conf',
      'mods-available/sql', 'sites-enabled/default', 'sites-enabled/inner-tunnel',
      'mods-config/sql/main/postgresql/queries.conf',
    ];
    const out: Array<{ path: string; exists: boolean; size: number }> = [];
    for (const rel of key) {
      const abs = this.safePath(rel);
      const st = await fs.stat(abs).catch(() => null);
      out.push({ path: rel, exists: !!st, size: st?.size ?? 0 });
    }
    return out;
  }

  /** File content for the editor — secret values shown as <hidden>. */
  async readFile(rel: string) {
    const abs = await this.realSafePath(rel);
    const content = await fs.readFile(abs, 'utf8').catch((e) => { throw new BadRequestException(`Cannot read: ${e.message}`); });
    return { path: rel, content: host.redactConfig(content), secretsHidden: true };
  }

  private async backup(abs: string, rel: string): Promise<string | null> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupRoot(), stamp, rel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.chmod(backupRoot(), 0o700).catch(() => undefined);
      await fs.copyFile(abs, dest);
      return dest;
    } catch {
      return null;
    }
  }

  async writeFile(rel: string, content: string) {
    const abs = await this.realSafePath(rel);
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) {
      throw new BadRequestException('File content is missing or too large.');
    }
    const relFromRad = path
      .relative(await fs.realpath(this.RAD).catch(() => this.RAD), abs)
      .replace(/\\/g, '/');
    const modeBefore = this.vault.refreshMode();
    return host.withHostLock(async () => {
      const current = await fs.readFile(abs, 'utf8').catch(() => null);
      if (current == null) throw new BadRequestException('Only existing FreeRADIUS files can be edited here.');
      // Secrets came to the browser as <hidden>: put the stored values back.
      const merged = host.unredactConfig(content.replace(/\r\n/g, '\n'), current);
      if (!merged.ok) return { ok: false, restored: false, message: merged.error, check: merged.error };
      const next = merged.text;

      // clients.conf must keep including the router file once FreeRADIUS reads
      // routers from it — without that line every router is forgotten.
      if (relFromRad === 'clients.conf' && this.vault.mode() === 'file') {
        const keeps = next.split('\n').some((l) => l.replace(/#.*$/, '').trim() === VAULT_INCLUDE_LINE);
        if (!keeps) {
          const msg = `clients.conf must keep the line "${VAULT_INCLUDE_LINE}" — it is how FreeRADIUS gets the panel's routers.`;
          return { ok: false, restored: false, message: msg, check: msg };
        }
      }
        // The RADIUS tenancy policy (docs/RADIUS_TENANCY.md) is put in and taken
        // out by scripts/radius-tenancy.sh, which validates a staged copy and
        // can roll back. Its file is not edited here, and an edit of a virtual
        // server must keep the hooks that call it — removing one would quietly
        // stop the company check for every login through that server.
        if (relFromRad === TENANCY_POLICY_FILE) {
          const msg = `${TENANCY_POLICY_FILE} is managed by backend/scripts/radius-tenancy.sh and is not edited here.`;
          return { ok: false, restored: false, message: msg, check: msg };
        }
        const hadHooks = tenancyHooks(current);
        const keepsHooks = tenancyHooks(next);
        if (
          (hadHooks.authorize && !keepsHooks.authorize) ||
          (hadHooks.accounting && !keepsHooks.accounting)
        ) {
          const msg =
            'This file carries the RADIUS tenancy hooks (jointbox_tenancy); they must stay. ' +
            'To stop refusing use backend/scripts/radius-tenancy.sh --monitor; to remove the policy, --uninstall.';
          return { ok: false, restored: false, message: msg, check: msg };
        }
      if (next === current) return { ok: true, restarted: false, message: 'No changes.', check: 'No changes.' };

      const saved = await this.backup(abs, relFromRad);
      if (!saved) {
        const msg = `Could not make a backup in ${backupRoot()} — nothing was changed.`;
        return { ok: false, restored: false, message: msg, check: msg };
      }
      // In place, so the file keeps its owner, group and mode.
      await fs.writeFile(abs, next, 'utf8').catch((e) => { throw new BadRequestException(`Cannot write: ${e.message}`); });

      const check = await host.validateConfig();
      if (!check.ok) {
        await fs.writeFile(abs, current, 'utf8').catch(() => undefined);
        return { ok: false, restored: true, message: `FreeRADIUS rejected the change — previous version restored: ${check.error}`, check: check.error };
      }
      const rs = await host.restart();
      if (!rs.ok) {
        await fs.writeFile(abs, current, 'utf8').catch(() => undefined);
        await host.restart();
        return { ok: false, restored: true, message: `${rs.error} The previous version was restored.`, check: rs.error };
      }
      this.log.log(`FreeRADIUS ${relFromRad} edited from the panel (backup: ${saved})`);
      return { ok: true, restarted: true, backup: saved, message: 'Saved, config OK, FreeRADIUS restarted.', check: 'Configuration appears to be OK' };
    }).finally(() => {
      // An edit that changed where FreeRADIUS takes routers from (the
      // clients.conf include, read_clients in the sql module) needs the
      // database side brought in line: plaintext put back or cleared.
      if (this.vault.refreshMode() !== modeBefore) {
        this.vault.apply('admin-edit').catch(() => undefined);
      }
    });
  }

  // ---- database -----------------------------------------------------------
  async database() {
    const url = process.env.DATABASE_URL || '';
    // Parse without leaking the password.
    const m = url.match(/postgresql:\/\/([^:]+):[^@]*@([^:/]+):?(\d+)?\/([^?]+)/i);
    const conn = m ? { user: m[1], host: m[2], port: m[3] || '5432', database: m[4] } : null;
    const params = Object.fromEntries(new URLSearchParams((url.split('?')[1] || '')));

    const settings = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT name, setting, unit FROM pg_settings WHERE name IN
       ('max_connections','shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','server_version')`,
    ).catch(() => []);
    const activity = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT count(*)::int AS connections, count(*) FILTER (WHERE state='active')::int AS active FROM pg_stat_activity`,
    ).catch(() => [{ connections: 0, active: 0 }]);
    const sizes = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT relname AS table, n_live_tup::bigint AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
       FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15`,
    ).catch(() => []);

    return {
      connection: conn,
      poolParams: params,
      redis: process.env.REDIS_URL ? 'configured' : 'not set (in-memory cache)',
      settings: settings.map((s) => ({ ...s })),
      activity: activity[0],
      topTables: sizes.map((t) => ({ ...t, rows: Number(t.rows) })),
    };
  }
}
