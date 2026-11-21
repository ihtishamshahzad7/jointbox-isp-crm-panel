import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { VpnService } from '../vpn/vpn.service';

/**
 * L2TP/IPsec HUB — "Add router → Via VPN".
 *
 * A router on a private/remote network (behind NAT or CGNAT) cannot be reached
 * by Uplinko, so the ROUTER dials in: MikroTik is the L2TP/IPsec client,
 * Uplinko is the server (strongSwan + xl2tpd + pppd).
 *
 *  • Each router gets its own PPP login and a fixed tunnel address. pppd
 *    hands that address to the router from /etc/ppp/chap-secrets (the 4th
 *    field), so the router is always at the same IP.
 *  • That tunnel address is the router's NAS IP in Uplinko: FreeRADIUS matches
 *    requests arriving through the tunnel, and API / CoA go back through it.
 *  • One IPsec pre-shared key for the hub, generated and stored (encrypted) by
 *    the panel. Per-router security is the PPP login (MS-CHAPv2).
 *
 * The database is the source of truth; the managed block in chap-secrets is
 * re-written from it on every change and at start-up.
 *
 * NOT HARDWARE VERIFIED — the generated server setup and router script have
 * not yet been run against a real MikroTik.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const BEGIN = '# BEGIN uplinko-l2tp-hub (managed by Uplinko — do not edit)';
const END = '# END uplinko-l2tp-hub';
const DEFAULT_SUBNET = '10.68.0.0/24';

export type CmdResult = { code: number; stdout: string; stderr: string };

@Injectable()
export class L2tpHubService implements OnApplicationBootstrap {
  private readonly logger = new Logger(L2tpHubService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    @Optional() private readonly vpn?: VpnService,
  ) {}

  // ── overridable for tests ────────────────────────────────────────────────
  chapSecretsPath = process.env.PPP_CHAP_SECRETS || '/etc/ppp/chap-secrets';
  swanConfPath = '/etc/swanctl/conf.d/uplinko-l2tp-server.conf';
  xl2tpdConfPath = '/etc/xl2tpd/xl2tpd.conf';
  pppOptionsPath = '/etc/ppp/options.uplinko-l2tp';
  run = (cmd: string, args: string[], timeoutMs = 8000): Promise<CmdResult> =>
    new Promise((resolve) =>
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        }),
      ),
    );
  readFile = (f: string) => fs.readFile(f, 'utf8').catch(() => null);
  writeFileAtomic = async (f: string, data: string) => {
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o755 });
    const tmp = `${f}.uplinko-${process.pid}`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, f);
  };

  onApplicationBootstrap() {
    const inst = process.env.NODE_APP_INSTANCE;
    if (process.env.NODE_ENV === 'test' || (inst !== undefined && inst !== '0')) return;
    // pppd reads chap-secrets per connection, so restoring the managed block
    // after a server rebuild is all that is needed — no daemon restart.
    setTimeout(() => {
      this.ensureServer()
        .catch((e) => this.logger.warn(`L2TP server not configured: ${e?.message || e}`))
        .finally(() =>
          this.writeSecrets().catch((e) => this.logger.warn(`L2TP hub logins not written: ${e?.message || e}`)),
        );
    }, 5_000).unref?.();
  }

  // ── settings ─────────────────────────────────────────────────────────────
  private async settingsRow(): Promise<any> {
    try {
      return await (this.prisma as any).l2tpHubSettings.findUnique({ where: { id: 1 } });
    } catch {
      return null;
    }
  }

  /** Address routers dial: the public IP / hostname set in Settings. */
  endpointHost(): string {
    let h = '';
    try {
      h = this.vpn?.getConfig()?.endpointHost || '';
    } catch {
      h = '';
    }
    return h || process.env.UPLINKO_PUBLIC_IP || '';
  }

  async subnet(): Promise<string> {
    return (await this.settingsRow())?.subnet || DEFAULT_SUBNET;
  }

  /** Host .1 of the hub subnet: Uplinko's own address inside every tunnel. */
  async serverIp(): Promise<string> {
    const { network } = this.parseSubnet(await this.subnet());
    return this.intToIp(network + 1);
  }

  /** The hub PSK, generated on first use and kept encrypted. */
  async psk(create = true): Promise<string | null> {
    const row = await this.settingsRow();
    const cur = row?.pskEnc ? this.secrets.decryptValue(row.pskEnc) : null;
    if (cur || !create) return cur ?? null;
    const psk = randomBytes(24).toString('base64url');
    await (this.prisma as any).l2tpHubSettings.upsert({
      where: { id: 1 },
      create: { id: 1, pskEnc: this.secrets.encryptValue(psk) },
      update: { pskEnc: this.secrets.encryptValue(psk) },
    });
    return psk;
  }

  async setSubnet(subnet: string) {
    const s = String(subnet || '').trim();
    this.parseSubnet(s); // validates
    const cur = await this.subnet();
    if (s !== cur) {
      const n = await (this.prisma as any).nasL2tpHub.count();
      if (n > 0)
        throw new BadRequestException(
          `${n} router(s) already use addresses in ${cur}. Changing the tunnel network would cut them off, so it is locked while routers use it.`,
        );
    }
    await (this.prisma as any).l2tpHubSettings.upsert({
      where: { id: 1 },
      create: { id: 1, subnet: s },
      update: { subnet: s },
    });
  }

  // ── addresses ────────────────────────────────────────────────────────────
  private ipToInt(ip: string) {
    return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  }
  private intToIp(n: number) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  private parseSubnet(s: string) {
    const m = CIDR.exec(s);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) < 16 || Number(m[5]) > 29)
      throw new BadRequestException('Tunnel network must be a CIDR between /16 and /29, e.g. 10.68.0.0/24.');
    const bits = Number(m[5]);
    const size = 2 ** (32 - bits);
    const network = (this.ipToInt(s.split('/')[0]) & ~(size - 1)) >>> 0;
    return { network, size };
  }

  /** Lowest free address (.2 upward), never one another router uses as NAS IP. */
  async nextTunnelIp(): Promise<string> {
    const subnet = await this.subnet();
    const { network, size } = this.parseSubnet(subnet);
    const taken = new Set<string>();
    for (const r of (await (this.prisma as any).nasL2tpHub.findMany({ select: { tunnelIp: true } })) ?? [])
      taken.add(r.tunnelIp);
    for (const r of (await (this.prisma as any).nas.findMany({ select: { nasIp: true } })) ?? [])
      if (r?.nasIp) taken.add(r.nasIp);
    for (let h = 2; h < size - 1; h++) {
      const ip = this.intToIp((network + h) >>> 0);
      if (!taken.has(ip)) return ip;
    }
    throw new ConflictException(`No tunnel addresses left in ${subnet}.`);
  }

  // ── readiness ────────────────────────────────────────────────────────────
  /**
   * Can a router connect right now? Never hand out a script that cannot.
   * No platform step is needed: update-jointbox.sh installs the packages, and
   * the panel writes and loads the server configuration itself.
   */
  async readiness(): Promise<{ ok: boolean; running: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const [x, w] = await Promise.all([this.run('which', ['xl2tpd']), this.run('which', ['swanctl'])]);
    if (x.code !== 0 || w.code !== 0) {
      reasons.push('The VPN server software (xl2tpd + strongSwan) is not installed on this Uplinko server yet. The server administrator needs to run update-jointbox.sh once — it installs it.');
      return { ok: false, running: false, reasons };
    }
    await this.ensureServer().catch((e) => reasons.push(`The VPN server could not be configured: ${e?.message || e}`));
    const active = await this.run('systemctl', ['is-active', '--quiet', 'xl2tpd']);
    const running = active.code === 0 && reasons.length === 0;
    if (!running && !reasons.length) reasons.push('The VPN server (xl2tpd) is not running on this Uplinko server.');
    return { ok: running, running, reasons };
  }

  /**
   * Write the L2TP/IPsec server configuration and load it. Idempotent: files
   * are only rewritten when their content changes, and services are only
   * reloaded then.
   */
  async ensureServer(): Promise<{ changed: boolean }> {
    const files = await this.serverFiles();
    let swanChanged = false;
    let l2tpChanged = false;
    for (const f of files) {
      if ((await this.readFile(f.path)) === f.content) continue;
      await this.writeFileAtomic(f.path, f.content);
      if (f.path === this.swanConfPath) swanChanged = true;
      else l2tpChanged = true;
    }
    if (swanChanged) {
      await this.run('systemctl', ['enable', '--now', 'strongswan']);
      const r = await this.run('swanctl', ['--load-all'], 15_000);
      if (r.code !== 0) throw new Error(`swanctl --load-all failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    if (l2tpChanged) {
      await this.run('systemctl', ['enable', 'xl2tpd']);
      const r = await this.run('systemctl', ['restart', 'xl2tpd'], 15_000);
      if (r.code !== 0) throw new Error(`xl2tpd did not start: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    if (swanChanged || l2tpChanged) this.logger.log('L2TP/IPsec server configuration written and loaded');
    return { changed: swanChanged || l2tpChanged };
  }

  private async serverFiles(): Promise<Array<{ path: string; content: string }>> {
    const psk = (await this.psk()) as string;
    const serverIp = await this.serverIp();
    const pskB64 = Buffer.from(psk).toString('base64');
    return [
      {
        path: this.swanConfPath,
        content: [
          '# Uplinko — L2TP/IPsec server for remote routers (managed by Uplinko)',
          'connections {',
          '  uplinko-l2tp-server {',
          '    version = 1',
          '    proposals = aes256-sha256-modp2048,aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024',
          '    local { auth = psk }',
          '    remote { auth = psk }',
          '    children {',
          '      l2tp {',
          '        mode = transport',
          '        local_ts = dynamic[udp/1701]',
          '        remote_ts = dynamic[udp]',
          "        # MikroTik's default IPsec proposal uses PFS (modp1024), so offer DH groups too.",
          '        esp_proposals = aes256-sha1-modp1024,aes128-sha1-modp1024,aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha256-modp2048,aes256-sha1,aes128-sha1,aes256-sha256,3des-sha1',
          '      }',
          '    }',
          '  }',
          '}',
          'secrets {',
          '  ike-uplinko-l2tp-server {',
          `    secret = 0s${pskB64}`,
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: this.pppOptionsPath,
        content: [
          '# Uplinko — options for routers dialling in (managed by Uplinko)',
          'require-mschap-v2',
          'refuse-pap',
          'refuse-chap',
          'refuse-mschap',
          'noccp',
          'nodefaultroute',
          'noproxyarp',
          'mtu 1400',
          'mru 1400',
          'lcp-echo-interval 20',
          'lcp-echo-failure 4',
          '',
        ].join('\n'),
      },
      {
        path: this.xl2tpdConfPath,
        content: [
          '; Uplinko — L2TP server for remote routers (managed by Uplinko)',
          '[global]',
          'port = 1701',
          '',
          '[lns default]',
          `local ip = ${serverIp}`,
          'assign ip = no',
          'require chap = yes',
          'refuse pap = yes',
          'require authentication = yes',
          'name = uplinko',
          `pppoptfile = ${this.pppOptionsPath}`,
          'length bit = yes',
          '',
        ].join('\n'),
      },
    ];
  }

  // ── per-router logins ────────────────────────────────────────────────────
  async provision(nasId: number, tunnelIp: string) {
    if (!IPV4.test(tunnelIp)) throw new BadRequestException('Bad tunnel address.');
    const username = `uplinko-nas${nasId}`;
    const password = randomBytes(18).toString('base64url');
    try {
      await (this.prisma as any).nasL2tpHub.create({
        data: { nasId, username, passwordEnc: this.secrets.encryptValue(password), tunnelIp },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(`Tunnel address ${tunnelIp} was just taken by another router. Try again.`);
      throw e;
    }
    const written = await this.writeSecrets();
    return { username, password, tunnelIp, applied: written.ok, warning: written.ok ? undefined : written.error };
  }

  async revoke(nasId: number) {
    const row = await (this.prisma as any).nasL2tpHub.findUnique({ where: { nasId } });
    if (!row) return { revoked: false };
    await (this.prisma as any).nasL2tpHub.delete({ where: { nasId } });
    await this.writeSecrets();
    return { revoked: true, tunnelIp: row.tunnelIp };
  }

  /** Re-write the managed block of chap-secrets from the database. */
  async writeSecrets(): Promise<{ ok: boolean; error?: string }> {
    try {
      const rows = (await (this.prisma as any).nasL2tpHub.findMany({ orderBy: { id: 'asc' } })) ?? [];
      const lines = rows
        .map((r: any) => {
          const pw = this.secrets.decryptValue(r.passwordEnc);
          if (!pw || !/^[A-Za-z0-9_-]+$/.test(pw) || !/^[A-Za-z0-9_.-]+$/.test(r.username) || !IPV4.test(r.tunnelIp)) return null;
          return `"${r.username}" * "${pw}" ${r.tunnelIp}`;
        })
        .filter(Boolean);
      const cur = (await this.readFile(this.chapSecretsPath)) ?? '';
      const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`, 'g');
      const kept = cur.replace(re, '').replace(/\n*$/, '\n');
      const block = [BEGIN, ...lines, END].join('\n') + '\n';
      await this.writeFileAtomic(this.chapSecretsPath, (kept.trim() ? kept : '') + block);
      return { ok: true };
    } catch (e: any) {
      const error = `Router logins could not be written to ${this.chapSecretsPath}: ${e?.message || e}`;
      this.logger.warn(error);
      return { ok: false, error };
    }
  }

  /** Connected = a ppp link exists whose peer is this router's tunnel address. */
  async status(nasId: number) {
    const row = await (this.prisma as any).nasL2tpHub.findUnique({ where: { nasId } });
    if (!row) return null;
    const r = await this.run('ip', ['-j', '-4', 'addr', 'show']);
    let online = false;
    try {
      const ifs = JSON.parse(r.stdout || '[]');
      online = ifs.some((i: any) =>
        (i.addr_info || []).some((a: any) => a.address === row.tunnelIp && a.local && a.local !== row.tunnelIp),
      );
    } catch {
      online = false;
    }
    return { type: 'l2tp', tunnelIp: row.tunnelIp, username: row.username, online, lastHandshake: null };
  }

  // ── generated text ───────────────────────────────────────────────────────
  /** Everything the router needs, in one paste (RouterOS 6.4x or 7). */
  routerScript(o: {
    name: string;
    username: string;
    password: string;
    tunnelIp: string;
    serverIp: string;
    endpoint: string;
    psk: string;
    radiusSecret: string;
    apiUsername: string;
    apiPassword: string;
    apiPort: number;
    coaPort: number;
    snmpCommunity?: string;
  }): string {
    const q = (v: string) => v.replace(/[\\"$?]/g, (c) => '\\' + c);
    const safe = o.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24) || 'uplinko';
    const ifc = 'l2tp-uplinko';
    const fw = `chain=input in-interface=${ifc} src-address=${o.serverIp} action=accept comment="Uplinko VPN"`;
    return [
      `# Uplinko — connect "${safe}" over L2TP/IPsec. Paste into the MikroTik terminal.`,
      `# 0) Remove anything left from an earlier paste (safe to run again)`,
      `/interface l2tp-client remove [find comment="Uplinko"]`,
      `/ip firewall filter remove [find comment="Uplinko VPN"]`,
      `/radius remove [find comment="Uplinko"]`,
      `/user remove [find comment="Uplinko"]`,
      `/user group remove [find name=uplinko]`,
      `# 1) L2TP/IPsec tunnel to Uplinko (the router dials out; works behind NAT/CGNAT)`,
      `/interface l2tp-client add name=${ifc} connect-to=${o.endpoint} user="${q(o.username)}" password="${q(o.password)}" use-ipsec=yes ipsec-secret="${q(o.psk)}" allow=mschap2 add-default-route=no disabled=no comment="Uplinko"`,
      `:if ([:len [/ip firewall filter find]] > 0) do={ /ip firewall filter add ${fw} place-before=0 } else={ /ip firewall filter add ${fw} }`,
      `# 2) RADIUS — users authenticate with Uplinko through the tunnel`,
      `/radius add address=${o.serverIp} secret="${q(o.radiusSecret)}" service=ppp,hotspot src-address=${o.tunnelIp} authentication-port=1812 accounting-port=1813 timeout=3s comment="Uplinko"`,
      `/radius incoming set accept=yes port=${o.coaPort}`,
      `/ppp aaa set use-radius=yes accounting=yes interim-update=5m`,
      `# 3) API user for Uplinko (only reachable from Uplinko's tunnel address)`,
      `/user group add name=uplinko policy=read,write,api,test comment="Uplinko"`,
      `/user add name="${q(o.apiUsername)}" password="${q(o.apiPassword)}" group=uplinko address=${o.serverIp}/32 comment="Uplinko"`,
      `/ip service set api disabled=no port=${o.apiPort}`,
      ...(o.snmpCommunity && /^[A-Za-z0-9_.-]{1,32}$/.test(o.snmpCommunity)
        ? [
            `# 4) SNMP (read-only, only from Uplinko) — used when SNMP is turned on for this router in Uplinko`,
            `/snmp community remove [find comment="Uplinko"]`,
            `/snmp community add name="${o.snmpCommunity}" addresses=${o.serverIp}/32 read-access=yes write-access=no comment="Uplinko"`,
            `/snmp set enabled=yes`,
          ]
        : []),
    ].join('\n');
  }
}
