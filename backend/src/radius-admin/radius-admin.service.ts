import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

const run = promisify(exec);
const RAD = '/etc/freeradius/3.0';

/**
 * FreeRADIUS + database admin — SUPER_ADMIN only (enforced in the controller).
 *
 * Everything that writes touches system files as root, so it is deliberately
 * constrained: file paths are whitelisted to the FreeRADIUS config tree, every
 * write is validated with `freeradius -XC` BEFORE the service is restarted, and
 * a timestamped backup is kept so a bad edit can be rolled back.
 */
@Injectable()
export class RadiusAdminService {
  private readonly log = new Logger('RadiusAdmin');

  constructor(private prisma: PrismaService) {}

  private async sh(cmd: string) {
    try { const { stdout, stderr } = await run(cmd, { maxBuffer: 8 * 1024 * 1024 }); return { ok: true, out: (stdout || stderr || '').trim() }; }
    catch (e: any) { return { ok: false, out: (e.stdout || '') + (e.stderr || e.message || '') }; }
  }

  /** Reject anything outside the FreeRADIUS config tree (path-traversal safe). */
  private safePath(rel: string): string {
    const abs = path.resolve(RAD, rel.replace(/^\/+/, ''));
    if (abs !== RAD && !abs.startsWith(RAD + path.sep)) {
      throw new BadRequestException('Path is outside the FreeRADIUS config directory.');
    }
    return abs;
  }

  // ---- status -------------------------------------------------------------
  async status() {
    const [active, version, ports, xc] = await Promise.all([
      this.sh('systemctl is-active freeradius'),
      this.sh("freeradius -v 2>/dev/null | head -1"),
      this.sh("ss -ulnp 2>/dev/null | grep -E ':1812|:1813' || true"),
      this.sh('freeradius -XC 2>&1 | tail -3'),
    ]);
    return {
      running: active.out === 'active',
      version: version.out,
      listening: { auth1812: ports.out.includes(':1812'), acct1813: ports.out.includes(':1813') },
      configCheck: xc.out,
    };
  }

  async control(action: 'restart' | 'stop' | 'start' | 'test') {
    if (action === 'test') return this.sh('freeradius -XC 2>&1 | tail -20');
    if (!['restart', 'stop', 'start'].includes(action)) throw new BadRequestException('Invalid action');
    // Validate config before a (re)start so we never leave RADIUS down.
    if (action !== 'stop') {
      const check = await this.sh('freeradius -XC 2>&1 | tail -5');
      if (!/Configuration appears to be OK/.test(check.out)) {
        return { ok: false, out: `Refusing to ${action}: config check failed.\n${check.out}` };
      }
    }
    return this.sh(`systemctl ${action} freeradius`);
  }

  // ---- modules (enable/disable) -------------------------------------------
  async modules() {
    const [avail, enabled] = await Promise.all([
      fs.readdir(path.join(RAD, 'mods-available')).catch(() => [] as string[]),
      fs.readdir(path.join(RAD, 'mods-enabled')).catch(() => [] as string[]),
    ]);
    const enabledSet = new Set(enabled);
    // Modules the panel needs vs optional — surfaced so an operator knows what
    // is safe to turn off.
    const REQUIRED = new Set(['pap', 'chap', 'mschap', 'sql', 'preprocess', 'files', 'expiration', 'realm', 'detail', 'attr_filter', 'radutmp', 'exec', 'expr', 'unix', 'eap']);
    return avail.filter((m) => !m.endsWith('.bak')).sort().map((name) => ({
      name,
      enabled: enabledSet.has(name),
      required: REQUIRED.has(name),
    }));
  }

  async toggleModule(name: string, enable: boolean) {
    if (!/^[a-z0-9_\-]+$/i.test(name) || name.includes('..')) throw new BadRequestException('Invalid module name');
    const availFile = path.join(RAD, 'mods-available', name);
    if (!(await fs.stat(availFile).then(() => true).catch(() => false))) {
      throw new BadRequestException(`Module "${name}" not found in mods-available.`);
    }
    const link = path.join(RAD, 'mods-enabled', name);
    if (enable) await this.sh(`ln -sf ../mods-available/${name} '${link}'`);
    else await this.sh(`rm -f '${link}'`);
    const check = await this.sh('freeradius -XC 2>&1 | tail -5');
    return { name, enabled: enable, configOk: /Configuration appears to be OK/.test(check.out), check: check.out };
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

  async readFile(rel: string) {
    const abs = this.safePath(rel);
    const content = await fs.readFile(abs, 'utf8').catch((e) => { throw new BadRequestException(`Cannot read: ${e.message}`); });
    return { path: rel, content };
  }

  async writeFile(rel: string, content: string) {
    const abs = this.safePath(rel);
    // Backup first.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.sh(`cp -a '${abs}' '${abs}.bak.${stamp}' 2>/dev/null || true`);
    await fs.writeFile(abs, content, 'utf8').catch((e) => { throw new BadRequestException(`Cannot write: ${e.message}`); });
    // Validate — if it breaks, restore the backup and report.
    const check = await this.sh('freeradius -XC 2>&1 | tail -8');
    const ok = /Configuration appears to be OK/.test(check.out);
    if (!ok) {
      await this.sh(`cp -a '${abs}.bak.${stamp}' '${abs}' 2>/dev/null || true`);
      return { ok: false, restored: true, check: check.out };
    }
    const restart = await this.sh('systemctl restart freeradius');
    return { ok: true, restarted: restart.ok, check: check.out };
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
