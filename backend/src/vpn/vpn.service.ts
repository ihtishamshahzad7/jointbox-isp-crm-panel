import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * PANEL VPN SERVERS — how a remote MikroTik behind CGNAT reaches this panel so
 * its PPPoE users authenticate here over the tunnel, and the panel can run
 * RADIUS / CoA / API toward the router.
 *
 * Three server types, all MikroTik-native: WireGuard, OpenVPN, L2TP/IPsec.
 * Several can run at once, and many routers can connect to each.
 *
 * SETUP MODEL (chosen with the operator): the panel does not try to create
 * interfaces or run daemons itself — the backend is an unprivileged service and
 * a VPN server needs root. Instead the panel GENERATES, per VPN type:
 *   • a one-time install script the operator runs once on the panel host
 *     (with sudo) to bring the server up and keep it up across reboots, and
 *   • the exact MikroTik client config to paste on each router.
 * The panel then reports status by probing the host (ports / `wg show`).
 *
 * SAFETY: every value that reaches a generated command or config is validated
 * against a strict pattern first. Nothing is shelled out with string
 * interpolation from user input.
 */

const HOST = /^[A-Za-z0-9.-]{1,253}$/; // hostname or IPv4, for the endpoint
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export type VpnType = 'wireguard' | 'openvpn' | 'l2tp';

export interface VpnConfig {
  endpointHost: string;
  wireguard: { port: number; subnet: string };
  openvpn: { port: number; proto: 'udp' | 'tcp'; subnet: string };
  l2tp: { subnet: string };
}

/**
 * The one state vocabulary every VPN type reports in. It describes what we
 * were actually able to observe on the host — never "the port is open, so
 * assume connected".
 *   unconfigured    — no config file / endpoint host not set yet
 *   install_required— the daemon's binaries are not installed on the host
 *   starting        — daemon enabled but not yet active (transient)
 *   online          — daemon active AND the server's own overlay is up
 *   degraded        — running but something is off (stale peers, one of two
 *                     required daemons down, overlay IP missing)
 *   offline         — installed but the daemon is not running
 *   error           — the daemon is in a failed state
 *   unknown         — we could not determine it (a probe tool was missing or
 *                     timed out); NOT treated as either healthy or broken
 */
export type HealthState =
  | 'unconfigured'
  | 'install_required'
  | 'starting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'error'
  | 'unknown';

/** One probe we ran. ok=null means "could not determine", not "failed". */
export interface HealthCheck {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface Health {
  state: HealthState;
  summary: string;
  checkedAt: string; // ISO
  /** Non-secret, operator-facing numbers (peer counts, handshake age, …). */
  metrics: Record<string, number | string | boolean>;
  checks: HealthCheck[];
}

/**
 * OBSERVED state, persisted separately from the DESIRED config. The config
 * file holds what the operator wants; this holds what we last saw and did, so
 * a restart does not lose the health history and the two never get conflated.
 */
export interface ObservedState {
  health: Partial<Record<VpnType, Health>>;
  lastReconcileAt?: string;
  lastReconcileDetail?: string;
}

const DEFAULTS: VpnConfig = {
  endpointHost: '',
  wireguard: { port: 51820, subnet: '10.66.0.0/24' },
  openvpn: { port: 1194, proto: 'udp', subnet: '10.67.0.0/24' },
  l2tp: { subnet: '10.68.0.0/24' },
};

@Injectable()
export class VpnService {
  private readonly logger = new Logger(VpnService.name);

  /** Serialises all config/state writes in this process so two concurrent
   *  requests can't interleave a temp-file rename. */
  private writeChain: Promise<void> = Promise.resolve();

  private get configPath(): string {
    return process.env.JBX_VPN_CONFIG || path.join(process.cwd(), 'vpn-servers.json');
  }

  private get statePath(): string {
    return process.env.JBX_VPN_STATE || path.join(path.dirname(this.configPath), 'vpn-state.json');
  }

  /**
   * Validate+normalise a raw parsed object into a VpnConfig. Rejects nothing
   * silently that matters: a bad port or subnet falls back to the default for
   * that field rather than poisoning the running server, and the caller is
   * told via the returned `repaired` flag so it can rewrite a clean file.
   */
  private normalise(raw: any): { cfg: VpnConfig; repaired: boolean } {
    let repaired = false;
    const okPort = (v: unknown, d: number) => {
      const p = Number(v);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
      if (v !== undefined) repaired = true;
      return d;
    };
    const okCidr = (v: unknown, d: string) => {
      const s = String(v ?? '');
      const m = CIDR.exec(s);
      if (m && !m.slice(1, 5).some((o) => Number(o) > 255) && Number(m[5]) >= 16 && Number(m[5]) <= 30) return s;
      if (v !== undefined) repaired = true;
      return d;
    };
    const host =
      typeof raw?.endpointHost === 'string' && (raw.endpointHost === '' || HOST.test(raw.endpointHost))
        ? raw.endpointHost
        : (raw?.endpointHost !== undefined && ((repaired = true), ''), '');
    const cfg: VpnConfig = {
      endpointHost: host,
      wireguard: {
        port: okPort(raw?.wireguard?.port, DEFAULTS.wireguard.port),
        subnet: okCidr(raw?.wireguard?.subnet, DEFAULTS.wireguard.subnet),
      },
      openvpn: {
        port: okPort(raw?.openvpn?.port, DEFAULTS.openvpn.port),
        proto: raw?.openvpn?.proto === 'tcp' ? 'tcp' : 'udp',
        subnet: okCidr(raw?.openvpn?.subnet, DEFAULTS.openvpn.subnet),
      },
      l2tp: { subnet: okCidr(raw?.l2tp?.subnet, DEFAULTS.l2tp.subnet) },
    };
    return { cfg, repaired };
  }

  // ── stored, editable DESIRED config (no DB migration needed) ──────────
  getConfig(): VpnConfig {
    try {
      const { cfg } = this.normalise(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
      return cfg;
    } catch {
      // No file yet (or unreadable): seed the endpoint from the legacy env so
      // an existing WG_ENDPOINT_HOST keeps working. Deep-clone DEFAULTS — a
      // shallow spread would share the nested objects and let a later mutation
      // poison the module-level constant.
      return {
        endpointHost: process.env.WG_ENDPOINT_HOST || '',
        wireguard: { ...DEFAULTS.wireguard },
        openvpn: { ...DEFAULTS.openvpn },
        l2tp: { ...DEFAULTS.l2tp },
      };
    }
  }

  /** Atomic, backed-up, 0600 write of any JSON payload to `file`. */
  private writeJsonAtomic(file: string, data: unknown): void {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const body = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd); // survive a crash between write and rename
    } finally {
      fs.closeSync(fd);
    }
    // Keep a single rolling backup of the previous good file.
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* backup is best-effort */
    }
    fs.renameSync(tmp, file); // atomic on the same filesystem
  }

  /** Serialise a write behind any in-flight write; never reject the chain. */
  private enqueue(fn: () => void): Promise<void> {
    const next = this.writeChain.then(() => {
      fn();
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private save(cfg: VpnConfig): Promise<void> {
    return this.enqueue(() => this.writeJsonAtomic(this.configPath, cfg));
  }

  // ── OBSERVED state (health history / last reconcile), kept separate ───
  getState(): ObservedState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return { health: raw?.health && typeof raw.health === 'object' ? raw.health : {}, ...raw };
    } catch {
      return { health: {} };
    }
  }

  private saveState(patch: Partial<ObservedState>): Promise<void> {
    return this.enqueue(() => {
      const cur = this.getState();
      this.writeJsonAtomic(this.statePath, { ...cur, ...patch, health: { ...cur.health, ...(patch.health || {}) } });
    });
  }

  private port(n: unknown, what: string): number {
    const p = Number(n);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new BadRequestException(`${what} must be a port between 1 and 65535.`);
    }
    return p;
  }

  private cidr(v: unknown, what: string): string {
    const s = String(v || '');
    const m = CIDR.exec(s);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) < 16 || Number(m[5]) > 30) {
      throw new BadRequestException(`${what} must be a CIDR between /16 and /30, e.g. 10.66.0.0/24.`);
    }
    return s;
  }

  /** [networkStart, networkEnd] as unsigned 32-bit ints for a validated CIDR. */
  private cidrRange(cidr: string): [number, number] {
    const [ip, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const octets = ip.split('.').map(Number);
    const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = (addr & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    return [network, broadcast];
  }

  /** Two CIDRs overlap if their address ranges intersect at all. */
  private cidrsOverlap(a: string, b: string): boolean {
    const [as_, ae] = this.cidrRange(a);
    const [bs, be] = this.cidrRange(b);
    return as_ <= be && bs <= ae;
  }

  /**
   * The three overlays must be mutually disjoint — if WireGuard and OpenVPN
   * share addresses, a router's overlay IP is ambiguous and traffic/RADIUS
   * routing silently breaks. Reject a config that would overlap before it is
   * persisted. (Overlap with the host's LAN can't be known here; the runbook
   * warns the operator to keep these off their LAN ranges.)
   */
  private assertDisjoint(cfg: VpnConfig): void {
    const nets: Array<[string, string]> = [
      ['WireGuard', cfg.wireguard.subnet],
      ['OpenVPN', cfg.openvpn.subnet],
      ['L2TP', cfg.l2tp.subnet],
    ];
    for (let i = 0; i < nets.length; i++) {
      for (let j = i + 1; j < nets.length; j++) {
        if (this.cidrsOverlap(nets[i][1], nets[j][1])) {
          throw new BadRequestException(
            `${nets[i][0]} (${nets[i][1]}) and ${nets[j][0]} (${nets[j][1]}) overlay subnets overlap. Give each VPN a distinct, non-overlapping range.`,
          );
        }
      }
    }
  }

  /** Update endpoint host and per-type settings from the GUI. */
  async setConfig(body: Record<string, unknown>): Promise<VpnConfig> {
    const cfg = this.getConfig();
    if (body.endpointHost !== undefined) {
      const h = String(body.endpointHost || '').trim();
      if (h && !HOST.test(h)) {
        throw new BadRequestException('Endpoint host must be a hostname or IP, e.g. vpn.yourdomain.com.');
      }
      cfg.endpointHost = h;
    }
    const wg = body.wireguard as Record<string, unknown> | undefined;
    if (wg) {
      if (wg.port !== undefined) cfg.wireguard.port = this.port(wg.port, 'WireGuard port');
      if (wg.subnet !== undefined) cfg.wireguard.subnet = this.cidr(wg.subnet, 'WireGuard subnet');
    }
    const ov = body.openvpn as Record<string, unknown> | undefined;
    if (ov) {
      if (ov.port !== undefined) cfg.openvpn.port = this.port(ov.port, 'OpenVPN port');
      if (ov.proto !== undefined) cfg.openvpn.proto = ov.proto === 'tcp' ? 'tcp' : 'udp';
      if (ov.subnet !== undefined) cfg.openvpn.subnet = this.cidr(ov.subnet, 'OpenVPN subnet');
    }
    const l2 = body.l2tp as Record<string, unknown> | undefined;
    if (l2 && l2.subnet !== undefined) cfg.l2tp.subnet = this.cidr(l2.subnet, 'L2TP subnet');
    // Reject overlapping overlays before persisting — they silently break routing.
    this.assertDisjoint(cfg);
    await this.save(cfg);
    this.logger.log('VPN server config updated');
    return cfg;
  }

  // ── host probes (best effort; never throw) ────────────────────────────
  /** Run a command with a bounded timeout. Returns stdout on exit 0, else null. */
  private run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, out) =>
        resolve(err ? null : out || ''),
      );
    });
  }

  /** Richer run: exit code + stdout + stderr, never rejects. */
  private runFull(
    cmd: string,
    args: string[],
    timeoutMs = 5000,
  ): Promise<{ code: number | null; out: string; err: string; ran: boolean }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (e: any, out, errOut) => {
        // ENOENT = binary not present; distinguish "couldn't run" from "ran and failed".
        const ran = !(e && e.code === 'ENOENT');
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: out || '', err: errOut || '', ran });
      });
    });
  }

  /** Is a binary on PATH? null if we can't even tell. */
  private async which(cmd: string): Promise<boolean | null> {
    const r = await this.runFull('sh', ['-c', `command -v ${cmd.replace(/[^A-Za-z0-9_-]/g, '')} >/dev/null 2>&1`]);
    if (!r.ran) return null;
    return r.code === 0;
  }

  /** systemctl is-active <unit> → one of the systemd ActiveStates, or null. */
  private async unitState(unit: string): Promise<string | null> {
    const r = await this.runFull('systemctl', ['is-active', unit]);
    if (!r.ran) return null; // no systemd in this environment
    const s = (r.out || r.err).trim();
    return s || (r.code === 0 ? 'active' : 'unknown');
  }

  /** Does any local interface carry this overlay IP? null if `ip` is absent. */
  private async ifaceHasIp(ip: string): Promise<boolean | null> {
    const out = await this.run('ip', ['-o', '-4', 'addr', 'show']);
    if (out == null) return null;
    return new RegExp(`\\binet ${ip.replace(/\./g, '\\.')}/`).test(out);
  }

  private firstHostIp(subnet: string): string {
    // 10.66.0.0/24 → 10.66.0.1 (the panel's own overlay address).
    const [net] = subnet.split('/');
    const o = net.split('.');
    o[3] = '1';
    return o.join('.');
  }

  private get wgIface(): string {
    return process.env.WG_INTERFACE || 'wg0';
  }

  private async wgPublicKey(): Promise<string | null> {
    const out = await this.run('wg', ['show', this.wgIface, 'public-key']);
    const k = out?.trim();
    return k && WG_KEY.test(k) ? k : null;
  }

  private async portListening(port: number, proto: 'tcp' | 'udp'): Promise<boolean | null> {
    // `ss -H -lun`/`-ltn` lists listening sockets; grep the port. null = ss absent.
    const flag = proto === 'udp' ? '-lun' : '-ltn';
    const out = await this.run('ss', ['-H', flag]);
    if (out == null) return null;
    return new RegExp(`[:.]${port}\\b`).test(out);
  }

  /** Stale-handshake threshold: a WireGuard peer that hasn't completed a
   *  handshake within this many seconds is treated as not currently connected
   *  (WireGuard rehandshakes well inside 2 minutes when traffic flows). */
  private static readonly WG_STALE_SECS = 180;

  /**
   * Parse `wg show <iface> dump`. The first line is the interface; each later
   * line is a peer: pubkey, psk, endpoint, allowed-ips, last-handshake(epoch),
   * rx, tx, keepalive. Returns null when `wg` can't run or the iface is absent.
   * NEVER returns private keys or PSKs.
   */
  private async wgDump(): Promise<{ peers: number; connected: number; newestHandshakeSecs: number | null } | null> {
    const r = await this.runFull('wg', ['show', this.wgIface, 'dump']);
    if (!r.ran || r.code !== 0 || !r.out.trim()) return null;
    const lines = r.out.trim().split('\n');
    const now = Math.floor(Date.now() / 1000);
    let peers = 0;
    let connected = 0;
    let newest: number | null = null;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 5) continue;
      peers++;
      const hs = Number(cols[4]); // last handshake, epoch seconds (0 = never)
      if (hs > 0) {
        const age = now - hs;
        if (newest === null || age < newest) newest = age;
        if (age <= VpnService.WG_STALE_SECS) connected++;
      }
    }
    return { peers, connected, newestHandshakeSecs: newest };
  }

  /**
   * Count connected OpenVPN clients from the status file the installer writes
   * (`/run/openvpn-server/status-jointbox.log`). Returns null if the file is
   * absent/unreadable (don't treat that as zero). Never reads secrets.
   */
  private async ovpnSessions(): Promise<number | null> {
    const file = process.env.JBX_OVPN_STATUS || '/run/openvpn-server/status-jointbox.log';
    const r = await this.runFull('cat', [file]);
    if (!r.ran || r.code !== 0 || !r.out) return null;
    // Modern status format has a CLIENT_LIST line per client; legacy format has
    // a "OpenVPN CLIENT LIST" section. Count CLIENT_LIST rows, else fall back.
    const clientList = (r.out.match(/^CLIENT_LIST\b/gm) || []).length;
    if (clientList > 0) return clientList;
    const legacy = r.out.match(/Common Name,Real Address[\s\S]*?\n([\s\S]*?)\nROUTING TABLE/);
    if (legacy) return legacy[1].split('\n').filter((l) => l.trim()).length;
    return 0;
  }

  // ── truthful per-type health ──────────────────────────────────────────
  private stamp(state: HealthState, summary: string, checks: HealthCheck[], metrics: Record<string, any> = {}): Health {
    return { state, summary, checkedAt: new Date().toISOString(), metrics, checks };
  }

  async healthWireguard(cfg: VpnConfig): Promise<Health> {
    const checks: HealthCheck[] = [];
    const serverIp = this.firstHostIp(cfg.wireguard.subnet);

    const have = await this.which('wg');
    checks.push({ name: 'wireguard-tools installed', ok: have, detail: have === null ? 'could not check' : have ? 'wg present' : 'wg not found' });
    if (have === false) return this.stamp('install_required', 'WireGuard tools are not installed on the panel host.', checks);

    const key = await this.wgPublicKey();
    const ifaceUp = key != null;
    checks.push({ name: `interface ${this.wgIface} up`, ok: ifaceUp, detail: ifaceUp ? 'server public key present' : 'interface not found / not up' });

    const hasIp = await this.ifaceHasIp(serverIp);
    checks.push({ name: `overlay ip ${serverIp} assigned`, ok: hasIp, detail: hasIp === null ? '`ip` tool unavailable' : hasIp ? 'assigned' : 'not assigned' });

    const dump = await this.wgDump();
    const peers = dump?.peers ?? 0;
    const connected = dump?.connected ?? 0;
    checks.push({
      name: 'router peers connected',
      ok: dump ? connected > 0 : null,
      detail: dump
        ? `${connected} of ${peers} peer(s) with a handshake in the last ${VpnService.WG_STALE_SECS}s`
        : 'could not read peer table',
    });

    const metrics = {
      peers,
      connected,
      newestHandshakeSecs: dump?.newestHandshakeSecs ?? -1,
      publicKey: key || '',
    };

    if (!ifaceUp) return this.stamp('offline', 'Installed, but the WireGuard interface is not up. Run the installer, then Re-check.', checks, metrics);
    if (hasIp === false) return this.stamp('degraded', 'Interface up but its overlay IP is missing — routing to routers will fail.', checks, metrics);
    if (peers > 0 && connected === 0) return this.stamp('degraded', `${peers} router peer(s) configured but none are handshaking right now.`, checks, metrics);
    return this.stamp('online', peers === 0 ? 'Server up and listening. No routers connected yet.' : `Server up; ${connected} router(s) connected.`, checks, metrics);
  }

  async healthOpenvpn(cfg: VpnConfig): Promise<Health> {
    const checks: HealthCheck[] = [];
    const serverIp = this.firstHostIp(cfg.openvpn.subnet);
    const unit = 'openvpn-server@jointbox';

    const have = await this.which('openvpn');
    checks.push({ name: 'openvpn installed', ok: have, detail: have === null ? 'could not check' : have ? 'openvpn present' : 'openvpn not found' });

    const st = await this.unitState(unit);
    checks.push({ name: `service ${unit}`, ok: st == null ? null : st === 'active', detail: st == null ? 'systemd unavailable' : st });

    const listening = await this.portListening(cfg.openvpn.port, cfg.openvpn.proto);
    checks.push({ name: `listening on ${cfg.openvpn.port}/${cfg.openvpn.proto}`, ok: listening, detail: listening === null ? '`ss` unavailable' : listening ? 'listening' : 'not listening' });

    const hasIp = await this.ifaceHasIp(serverIp);
    checks.push({ name: `overlay ip ${serverIp} assigned`, ok: hasIp, detail: hasIp === null ? '`ip` unavailable' : hasIp ? 'assigned' : 'tun not up' });

    // Connected routers, from the OpenVPN status file the installer configures.
    const sessions = await this.ovpnSessions();
    if (sessions !== null) {
      checks.push({ name: 'connected clients', ok: null, detail: `${sessions} client(s) in the status file` });
    }

    const metrics = { listening: listening === true, unit: st || 'unknown', connected: sessions ?? -1 };

    if (have === false && st == null) return this.stamp('install_required', 'OpenVPN is not installed on the panel host.', checks, metrics);
    if (st === 'failed') return this.stamp('error', 'The OpenVPN service is in a failed state. Check `journalctl -u ' + unit + '`.', checks, metrics);
    if (st === 'activating') return this.stamp('starting', 'OpenVPN is starting up.', checks, metrics);
    if (st === 'inactive') return this.stamp('offline', 'OpenVPN is installed but not running. Run the installer or `systemctl start ' + unit + '`.', checks, metrics);
    if (st === 'active') {
      if (listening === false) return this.stamp('degraded', 'Service active but not listening on its port yet.', checks, metrics);
      if (hasIp === false) return this.stamp('degraded', 'Service active but the tun overlay IP is missing.', checks, metrics);
      return this.stamp('online', sessions && sessions > 0 ? `OpenVPN active; ${sessions} router(s) connected.` : 'OpenVPN server active and listening. No routers connected yet.', checks, metrics);
    }
    // No systemd to consult — fall back to the listening socket, honestly.
    if (listening === true) return this.stamp('online', 'Listening on its port (service state unknown).', checks, metrics);
    if (listening === false) return this.stamp('offline', 'Not listening on its port.', checks, metrics);
    return this.stamp('unknown', 'Could not determine OpenVPN status on this host.', checks, metrics);
  }

  async healthL2tp(cfg: VpnConfig): Promise<Health> {
    const checks: HealthCheck[] = [];
    const serverIp = this.firstHostIp(cfg.l2tp.subnet);

    const xl2tp = await this.unitState('xl2tpd');
    checks.push({ name: 'service xl2tpd', ok: xl2tp == null ? null : xl2tp === 'active', detail: xl2tp == null ? 'systemd unavailable' : xl2tp });

    // strongSwan ships as either strongswan-starter or strongswan unit.
    let ipsecUnit = await this.unitState('strongswan');
    if (ipsecUnit == null || ipsecUnit === 'unknown' || ipsecUnit === 'inactive') {
      const alt = await this.unitState('strongswan-starter');
      if (alt && alt !== 'unknown') ipsecUnit = alt;
    }
    checks.push({ name: 'service strongswan (IPsec)', ok: ipsecUnit == null ? null : ipsecUnit === 'active', detail: ipsecUnit == null ? 'systemd unavailable' : ipsecUnit });

    // Established IKE SAs — the real sign IPsec is carrying tunnels. Try the
    // modern swanctl first, then legacy `ipsec status`. We only COUNT SAs; we
    // never print secrets.
    let sas: number | null = null;
    const sw = await this.runFull('swanctl', ['--list-sas']);
    if (sw.ran && sw.code === 0) {
      sas = (sw.out.match(/ESTABLISHED/g) || []).length;
    } else {
      const ip = await this.runFull('ipsec', ['status']);
      if (ip.ran && ip.code === 0) sas = (ip.out.match(/ESTABLISHED|INSTALLED/g) || []).length;
    }
    checks.push({ name: 'IPsec security associations', ok: sas == null ? null : sas > 0, detail: sas == null ? 'swanctl/ipsec unavailable' : `${sas} established` });

    const psk500 = await this.portListening(500, 'udp');
    checks.push({ name: 'IKE listening on 500/udp', ok: psk500, detail: psk500 === null ? '`ss` unavailable' : psk500 ? 'listening' : 'not listening' });

    const hasIp = await this.ifaceHasIp(serverIp);
    checks.push({ name: `local ip ${serverIp} assigned`, ok: hasIp, detail: hasIp === null ? '`ip` unavailable' : hasIp ? 'assigned' : 'not assigned' });

    const metrics = { ipsecSas: sas ?? -1, xl2tpd: xl2tp || 'unknown', strongswan: ipsecUnit || 'unknown' };

    const both = xl2tp === 'active' && ipsecUnit === 'active';
    const neither = (xl2tp === 'inactive' || xl2tp == null) && (ipsecUnit === 'inactive' || ipsecUnit == null);
    if (xl2tp == null && ipsecUnit == null && psk500 == null) return this.stamp('unknown', 'Could not determine L2TP/IPsec status on this host.', checks, metrics);
    if (xl2tp === 'failed' || ipsecUnit === 'failed') return this.stamp('error', 'An L2TP/IPsec service is in a failed state.', checks, metrics);
    if (neither && psk500 !== true) return this.stamp('offline', 'L2TP/IPsec is not running. Run the installer.', checks, metrics);
    if (!both) return this.stamp('degraded', 'Only one of xl2tpd / strongSwan is running — both are required.', checks, metrics);
    if (sas === 0) return this.stamp('online', 'L2TP/IPsec up. No router tunnels established yet.', checks, metrics);
    return this.stamp('online', sas && sas > 0 ? `L2TP/IPsec up; ${sas} IPsec SA(s) established.` : 'L2TP/IPsec up.', checks, metrics);
  }

  async health(type: VpnType, cfg?: VpnConfig): Promise<Health> {
    const c = cfg || this.getConfig();
    if (!c.endpointHost && type === 'wireguard') {
      // Endpoint host is required for routers to dial in; flag it, but still
      // report the daemon's real state so the operator sees progress.
    }
    if (type === 'wireguard') return this.healthWireguard(c);
    if (type === 'openvpn') return this.healthOpenvpn(c);
    return this.healthL2tp(c);
  }

  /** Full status + ready-to-use scripts/configs for all three VPN types. */
  async overview() {
    const cfg = this.getConfig();
    const host = cfg.endpointHost;
    const [wg, ov, l2] = await Promise.all([
      this.healthWireguard(cfg),
      this.healthOpenvpn(cfg),
      this.healthL2tp(cfg),
    ]);

    // Persist the observed snapshot (desired vs observed kept separate).
    this.saveState({ health: { wireguard: wg, openvpn: ov, l2tp: l2 } }).catch(() => undefined);

    const state = this.getState();
    const wgKey = (wg.metrics.publicKey as string) || null;
    // "Ready" = the daemon is genuinely online AND the endpoint host is set so
    // routers can actually dial in. It is NOT "a port looks open".
    const ready = (h: Health) => (h.state === 'online' || h.state === 'degraded') && !!host;

    return {
      endpointHost: host,
      endpointSet: !!host,
      lastReconcileAt: state.lastReconcileAt || null,
      lastReconcileDetail: state.lastReconcileDetail || null,
      servers: [
        {
          type: 'wireguard' as VpnType,
          name: 'WireGuard',
          blurb: 'Fast, modern, lowest overhead. Best default for CGNAT routers.',
          health: wg,
          state: wg.state,
          running: wg.state === 'online' || wg.state === 'degraded',
          listenPort: cfg.wireguard.port,
          subnet: cfg.wireguard.subnet,
          serverIp: this.firstHostIp(cfg.wireguard.subnet),
          publicKey: wgKey,
          ready: ready(wg),
          install: this.wireguardInstall(cfg),
          mikrotik: this.wireguardMikrotik(cfg, wgKey),
        },
        {
          type: 'openvpn' as VpnType,
          name: 'OpenVPN',
          blurb: 'Widely compatible, works over TCP/UDP through most firewalls.',
          health: ov,
          state: ov.state,
          running: ov.state === 'online' || ov.state === 'degraded',
          listenPort: cfg.openvpn.port,
          proto: cfg.openvpn.proto,
          subnet: cfg.openvpn.subnet,
          serverIp: this.firstHostIp(cfg.openvpn.subnet),
          ready: ready(ov),
          install: this.openvpnInstall(cfg),
          mikrotik: this.openvpnMikrotik(cfg),
        },
        {
          type: 'l2tp' as VpnType,
          name: 'L2TP / IPsec',
          blurb: 'Native and easy on MikroTik. Uses a shared secret plus a login.',
          health: l2,
          state: l2.state,
          running: l2.state === 'online' || l2.state === 'degraded',
          subnet: cfg.l2tp.subnet,
          serverIp: this.firstHostIp(cfg.l2tp.subnet),
          ready: ready(l2),
          install: this.l2tpInstall(cfg),
          mikrotik: this.l2tpMikrotik(cfg),
        },
      ],
    };
  }

  /**
   * Honest end-to-end verification for one VPN type. It checks the things we
   * can prove from the panel host WITHOUT sending real credentials and WITHOUT
   * touching production subscriber sessions:
   *   • daemon active (reuses the health engine)
   *   • the server's own overlay IP is assigned and locally reachable
   *   • the RADIUS auth/acct path is reachable from this host
   * A failed ICMP is reported as "inconclusive", never as "broken".
   */
  async verify(type: VpnType): Promise<{ type: VpnType; ok: boolean; checks: HealthCheck[]; health: Health }> {
    const cfg = this.getConfig();
    const h = await this.health(type, cfg);
    const checks: HealthCheck[] = [...h.checks];

    const serverIp =
      type === 'wireguard'
        ? this.firstHostIp(cfg.wireguard.subnet)
        : type === 'openvpn'
          ? this.firstHostIp(cfg.openvpn.subnet)
          : this.firstHostIp(cfg.l2tp.subnet);

    // Bounded ping of our OWN overlay IP: proves the interface is routable.
    // ICMP may be filtered, so a failure is inconclusive, not a hard fail.
    const ping = await this.runFull('ping', ['-c', '1', '-W', '1', serverIp], 3000);
    checks.push({
      name: `overlay ${serverIp} reachable`,
      ok: !ping.ran ? null : ping.code === 0 ? true : null,
      detail: !ping.ran ? 'ping unavailable' : ping.code === 0 ? 'replies' : 'no ICMP reply (may be filtered — inconclusive)',
    });

    // RADIUS auth/acct path reachable locally (1812/1813 udp). We do NOT send
    // an Access-Request — that could disturb a live NAS. Presence of the
    // listener is enough to prove the path exists on this host.
    const radius = await this.portListening(1812, 'udp');
    checks.push({
      name: 'RADIUS auth path (1812/udp) present',
      ok: radius,
      detail: radius === null ? '`ss` unavailable' : radius ? 'RADIUS listening on this host' : 'no RADIUS listener found',
    });

    // "ok" requires the daemon genuinely online or degraded-but-up, and no
    // check that definitively failed. null (unknown) checks never fail verify.
    const hardFail = checks.some((c) => c.ok === false);
    const ok = (h.state === 'online' || h.state === 'degraded') && !hardFail;
    return { type, ok, checks, health: h };
  }

  // ── install scripts (run once on the panel host, with sudo) ───────────
  private header(title: string): string {
    return [
      '#!/usr/bin/env bash',
      `# Jointbox — ${title}. Run once on the PANEL host as root.`,
      '# Idempotent: safe to re-run. Config files are backed up before changes,',
      '# and a failure rolls those backups back automatically.',
      'set -euo pipefail',
      '[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }',
      '',
      'JBX_STAMP=$(date +%Y%m%d-%H%M%S)',
      'JBX_BACKUPS=()',
      '# backup_file <path>: snapshot an existing file before we modify it.',
      'backup_file() {',
      '  if [ -f "$1" ]; then cp -a "$1" "$1.jbx-bak-$JBX_STAMP"; JBX_BACKUPS+=("$1"); fi',
      '}',
      '# On any error, restore every file we backed up this run, then report.',
      'jbx_rollback() {',
      '  echo "ERROR — rolling back changed config files." >&2',
      '  for f in "${JBX_BACKUPS[@]:-}"; do',
      '    [ -n "$f" ] && [ -f "$f.jbx-bak-$JBX_STAMP" ] && cp -a "$f.jbx-bak-$JBX_STAMP" "$f" || true',
      '  done',
      '}',
      'trap jbx_rollback ERR',
      '# Overlay traffic must be forwarded for RADIUS/services to be reachable.',
      'enable_forwarding() {',
      '  sysctl -w net.ipv4.ip_forward=1 >/dev/null',
      "  grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.d/99-jointbox-vpn.conf 2>/dev/null || echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-jointbox-vpn.conf",
      '}',
      '# Clamp TCP MSS to path MTU so PPPoE-over-tunnel does not black-hole large',
      '# packets. Narrow and reversible (remove the rule to undo).',
      'clamp_mss() {',
      '  command -v iptables >/dev/null 2>&1 || return 0',
      "  iptables -t mangle -C FORWARD -o \"$1\" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \\",
      "    || iptables -t mangle -A FORWARD -o \"$1\" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu",
      '}',
      '',
    ].join('\n');
  }

  private wireguardInstall(cfg: VpnConfig): string {
    const iface = process.env.WG_INTERFACE || 'wg0';
    const ip = this.firstHostIp(cfg.wireguard.subnet);
    const mask = cfg.wireguard.subnet.split('/')[1];
    return (
      this.header('WireGuard panel server') +
      [
        'apt-get update -y && apt-get install -y wireguard-tools',
        'enable_forwarding',
        'install -d -m 0700 /etc/wireguard',
        `CONF=/etc/wireguard/${iface}.conf`,
        'backup_file "$CONF"',
        'if [ ! -f "$CONF" ]; then',
        '  umask 077',
        '  KEY=$(wg genkey)',
        '  cat > "$CONF" <<EOF',
        '[Interface]',
        'PrivateKey = ${KEY}',
        `Address = ${ip}/${mask}`,
        `ListenPort = ${cfg.wireguard.port}`,
        'EOF',
        'fi',
        `systemctl enable --now wg-quick@${iface}`,
        `clamp_mss ${iface}`,
        `ufw allow ${cfg.wireguard.port}/udp 2>/dev/null || true`,
        '# Post-install self-test — fail loudly rather than report false success.',
        `systemctl is-active --quiet wg-quick@${iface} || { echo "SELF-TEST FAILED: wg-quick@${iface} not active" >&2; exit 1; }`,
        `wg show ${iface} >/dev/null || { echo "SELF-TEST FAILED: ${iface} not present" >&2; exit 1; }`,
        `echo; echo "WireGuard up (self-test OK). Public key:"; wg show ${iface} public-key`,
        'echo "Now click Re-check in the panel, then Reconcile to push router peers."',
      ].join('\n') +
      '\n'
    );
  }

  private wireguardMikrotik(cfg: VpnConfig, serverKey: string | null): string {
    const host = cfg.endpointHost || '<panel-host>';
    const key = serverKey || '<panel-public-key>';
    return [
      '# On the router: Jointbox issues the client keys per NAS from the',
      '# router’s Tunnel tab. This is the server endpoint it will dial:',
      `#   endpoint ${host}:${cfg.wireguard.port}`,
      `#   panel public key ${key}`,
      '# Use the per-router config on each NAS’s "Tunnel" tab to paste the',
      '# full /interface/wireguard block (it contains that router’s own key).',
    ].join('\n');
  }

  private openvpnInstall(cfg: VpnConfig): string {
    const ip = this.firstHostIp(cfg.openvpn.subnet);
    const net = cfg.openvpn.subnet.split('/')[0];
    return (
      this.header('OpenVPN panel server') +
      [
        'apt-get update -y && apt-get install -y openvpn easy-rsa iptables',
        'enable_forwarding',
        'MK=/etc/openvpn/jointbox',
        'install -d -m 0700 "$MK"',
        'if [ ! -f "$MK/ca.crt" ]; then',
        '  make-cadir "$MK/easyrsa"; cd "$MK/easyrsa"',
        '  ./easyrsa init-pki',
        '  EASYRSA_BATCH=1 ./easyrsa build-ca nopass',
        '  EASYRSA_BATCH=1 ./easyrsa build-server-full server nopass',
        '  ./easyrsa gen-dh',
        '  cp pki/ca.crt pki/issued/server.crt pki/private/server.key pki/dh.pem "$MK/"',
        'fi',
        'install -d -m 0755 /etc/openvpn/server',
        'backup_file /etc/openvpn/server/jointbox.conf',
        'cat > /etc/openvpn/server/jointbox.conf <<EOF',
        `port ${cfg.openvpn.port}`,
        `proto ${cfg.openvpn.proto}`,
        'dev tun',
        'ca /etc/openvpn/jointbox/ca.crt',
        'cert /etc/openvpn/jointbox/server.crt',
        'key /etc/openvpn/jointbox/server.key',
        'dh /etc/openvpn/jointbox/dh.pem',
        `server ${net} ${this.maskFor(cfg.openvpn.subnet)}`,
        'topology subnet',
        'keepalive 10 60',
        'status /run/openvpn-server/status-jointbox.log 10',
        'persist-key',
        'persist-tun',
        'EOF',
        'systemctl enable --now openvpn-server@jointbox',
        'clamp_mss "tun+"',
        `ufw allow ${cfg.openvpn.port}/${cfg.openvpn.proto} 2>/dev/null || true`,
        '# Post-install self-test.',
        'systemctl is-active --quiet openvpn-server@jointbox || { echo "SELF-TEST FAILED: openvpn-server@jointbox not active" >&2; exit 1; }',
        `echo "OpenVPN up on ${ip} (self-test OK). Create a client cert per router:"`,
        'echo "  cd /etc/openvpn/jointbox/easyrsa && EASYRSA_BATCH=1 ./easyrsa build-client-full <routername> nopass"',
        'echo "Then export its .ovpn and paste into the router (see the panel)."',
      ].join('\n') +
      '\n'
    );
  }

  private openvpnMikrotik(cfg: VpnConfig): string {
    const host = cfg.endpointHost || '<panel-host>';
    return [
      '# RouterOS 7 — OpenVPN client to the panel.',
      '# First import the router’s client cert + key (from the panel host:',
      '#   /etc/openvpn/jointbox/easyrsa/pki/issued/<routername>.crt and the key)',
      '/certificate',
      '# import file-name=<routername>.crt ; import file-name=<routername>.key',
      '/interface/ovpn-client',
      `add name=jointbox-ovpn connect-to=${host} port=${cfg.openvpn.port} \\`,
      `    mode=ip protocol=${cfg.openvpn.proto} user=<routername> \\`,
      '    certificate=<routername>.crt_0 add-default-route=no \\',
      '    comment="Jointbox management tunnel"',
    ].join('\n');
  }

  private l2tpInstall(cfg: VpnConfig): string {
    const ip = this.firstHostIp(cfg.l2tp.subnet);
    const base = cfg.l2tp.subnet.split('/')[0].split('.').slice(0, 3).join('.');
    return (
      this.header('L2TP/IPsec panel server') +
      [
        'apt-get update -y && apt-get install -y strongswan xl2tpd iptables',
        'enable_forwarding',
        '# Reuse the existing PSK on a re-run so routers keep working; only mint a',
        '# new one on first install. Back up before touching either file.',
        'backup_file /etc/ipsec.secrets',
        'backup_file /etc/xl2tpd/xl2tpd.conf',
        'if grep -qE \'^\\s*: PSK\' /etc/ipsec.secrets 2>/dev/null; then',
        "  PSK=$(sed -nE 's/^\\s*: PSK \"(.*)\"\\s*$/\\1/p' /etc/ipsec.secrets | head -n1)",
        'else',
        '  PSK=$(head -c 18 /dev/urandom | base64)',
        'fi',
        'umask 077',
        'cat > /etc/ipsec.secrets <<EOF',
        ': PSK "${PSK}"',
        'EOF',
        'chmod 600 /etc/ipsec.secrets',
        'cat > /etc/xl2tpd/xl2tpd.conf <<EOF',
        '[global]',
        '[lns default]',
        `ip range = ${base}.10-${base}.240`,
        `local ip = ${ip}`,
        'require chap = yes',
        'refuse pap = yes',
        'ppp debug = no',
        'pppoptfile = /etc/ppp/options.xl2tpd',
        'length bit = yes',
        'EOF',
        'systemctl enable --now strongswan-starter xl2tpd',
        'clamp_mss "ppp+"',
        'ufw allow 500,4500/udp 2>/dev/null || true; ufw allow 1701/udp 2>/dev/null || true',
        '# Post-install self-test — both daemons must be up.',
        'systemctl is-active --quiet xl2tpd || { echo "SELF-TEST FAILED: xl2tpd not active" >&2; exit 1; }',
        'systemctl is-active --quiet strongswan-starter || systemctl is-active --quiet strongswan || { echo "SELF-TEST FAILED: strongSwan not active" >&2; exit 1; }',
        'echo; echo "L2TP/IPsec up (self-test OK). Shared secret (use on every router):"; echo "$PSK"',
        'echo "Add a login per router in /etc/ppp/chap-secrets:  <routername> * <password> *"',
      ].join('\n') +
      '\n'
    );
  }

  private l2tpMikrotik(cfg: VpnConfig): string {
    const host = cfg.endpointHost || '<panel-host>';
    return [
      '# RouterOS 7 — L2TP/IPsec client to the panel.',
      '/interface/l2tp-client',
      `add name=jointbox-l2tp connect-to=${host} user=<routername> password=<password> \\`,
      '    use-ipsec=yes ipsec-secret=<shared-secret> add-default-route=no \\',
      '    comment="Jointbox management tunnel"',
    ].join('\n');
  }

  private maskFor(cidr: string): string {
    const bits = Number(cidr.split('/')[1]);
    const m = [0, 0, 0, 0];
    for (let i = 0; i < 32; i++) if (i < bits) m[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
    return m.join('.');
  }

  // ── per-router client config, for any vendor ──────────────────────────
  /**
   * The config a SPECIFIC router pastes to join a VPN, rendered for its
   * vendor. "All vendors" means we emit the right syntax for each platform —
   * the operator still applies it on the device (we never push blindly to
   * third-party gear). WireGuard is the fast, low-overhead default.
   */
  clientConfig(type: VpnType, vendor: string, name: string, overlayIp: string): string {
    const nm = /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name : 'router';
    const ip = this.assertIpStr(overlayIp);
    const cfg = this.getConfig();
    const host = cfg.endpointHost || '<panel-host>';
    const v = (vendor || 'mikrotik').toLowerCase();

    if (type === 'wireguard') return this.wgClient(v, nm, ip, host, cfg);
    if (type === 'openvpn') return this.ovpnClient(v, nm, host, cfg);
    return this.l2tpClient(v, nm, host);
  }

  private assertIpStr(ip: string): string {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
    if (!m || m.slice(1).some((o) => Number(o) > 255)) {
      throw new BadRequestException(`"${ip}" is not a valid overlay IP.`);
    }
    return ip;
  }

  private wgClient(vendor: string, nm: string, ip: string, host: string, cfg: VpnConfig): string {
    const port = cfg.wireguard.port;
    const mask = cfg.wireguard.subnet.split('/')[1];
    const panelIp = this.firstHostIp(cfg.wireguard.subnet);
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco IOS-XE WireGuard — ${nm}`,
          'crypto wireguard',
          ` private-key generate`,
          `interface wireguard1`,
          ` ip address ${ip} 255.255.255.255`,
          ` peer panel`,
          `  public-key <panel-public-key>`,
          `  endpoint ${host} ${port}`,
          `  allowed-ips ${panelIp}/32`,
          `  persistent-keepalive 25`,
        ].join('\n');
      case 'juniper':
        return [
          `# Juniper (set syntax) — ${nm}`,
          `set interfaces wg0 unit 0 family inet address ${ip}/${mask}`,
          `set security wireguard interface wg0 peer panel endpoint ${host}:${port}`,
          `set security wireguard interface wg0 peer panel allowed-ips ${panelIp}/32`,
          `set security wireguard interface wg0 peer panel public-key <panel-public-key>`,
        ].join('\n');
      case 'linux':
        return [
          `# wg-quick — /etc/wireguard/jointbox.conf on ${nm}`,
          '[Interface]',
          'PrivateKey = <this-router-private-key>',
          `Address = ${ip}/${mask}`,
          '[Peer]',
          'PublicKey = <panel-public-key>',
          `Endpoint = ${host}:${port}`,
          `AllowedIPs = ${panelIp}/32`,
          'PersistentKeepalive = 25',
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — ${nm}. Keys are issued per-router on its Tunnel tab;`,
          `# this is the panel endpoint it dials:`,
          '/interface/wireguard add name=jointbox listen-port=13231',
          `/ip/address add address=${ip}/32 interface=jointbox`,
          '/interface/wireguard/peers add interface=jointbox \\',
          `    public-key="<panel-public-key>" endpoint-address=${host} endpoint-port=${port} \\`,
          `    allowed-address=${panelIp}/32 persistent-keepalive=25s`,
        ].join('\n');
    }
  }

  private ovpnClient(vendor: string, nm: string, host: string, cfg: VpnConfig): string {
    const port = cfg.openvpn.port;
    const proto = cfg.openvpn.proto;
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco OpenVPN is non-native; use a standard .ovpn on an attached host, or:`,
          `! crypto / AnyConnect is the Cisco path. Recommended: use WireGuard or L2TP on Cisco.`,
        ].join('\n');
      case 'linux':
      case 'generic':
        return [
          `# ${nm}.ovpn (OpenVPN client, any OS)`,
          'client',
          'dev tun',
          `proto ${proto}`,
          `remote ${host} ${port}`,
          'resolv-retry infinite',
          'nobind',
          'persist-key',
          'persist-tun',
          'remote-cert-tls server',
          '<ca>  # paste ca.crt from the panel host',
          '<cert># paste this router’s client cert',
          '<key> # paste this router’s client key',
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — OpenVPN client ${nm}. Import this router’s cert+key first.`,
          '/interface/ovpn-client',
          `add name=jointbox-ovpn connect-to=${host} port=${port} protocol=${proto} \\`,
          `    mode=ip user=${nm} certificate=${nm}.crt_0 add-default-route=no \\`,
          '    comment="Jointbox management tunnel"',
        ].join('\n');
    }
  }

  private l2tpClient(vendor: string, nm: string, host: string): string {
    switch (vendor) {
      case 'cisco':
        return [
          `! Cisco IOS — L2TP/IPsec to the panel (${nm})`,
          'crypto isakmp policy 10',
          ' encr aes',
          ' authentication pre-share',
          ' group 2',
          `crypto isakmp key <shared-secret> address ${host}`,
          '! then an l2tp pseudowire / virtual-ppp to ' + host,
        ].join('\n');
      case 'juniper':
        return [
          `# Juniper — L2TP/IPsec to ${host} (${nm})`,
          `set services l2tp ... remote ${host}  # with IKE pre-shared-key <shared-secret>`,
        ].join('\n');
      case 'linux':
        return [
          `# Linux (NetworkManager/xl2tpd) — ${nm}`,
          `# server = ${host}, IPsec PSK = <shared-secret>, user = ${nm}, CHAP password = <password>`,
        ].join('\n');
      default: // mikrotik
        return [
          `# RouterOS 7 — L2TP/IPsec client ${nm}`,
          '/interface/l2tp-client',
          `add name=jointbox-l2tp connect-to=${host} user=${nm} password=<password> \\`,
          '    use-ipsec=yes ipsec-secret=<shared-secret> add-default-route=no \\',
          '    comment="Jointbox management tunnel"',
        ].join('\n');
    }
  }

  /**
   * Recover an already-installed service via the root-owned privileged helper
   * (start/stop/restart/status). DISABLED unless `JBX_VPN_PRIVILEGED=1` and the
   * helper is installed — otherwise the operator-run model stands and this
   * returns `{ enabled: false }`. Inputs are strict enums, so nothing
   * user-supplied reaches a shell or a path; the helper re-validates too.
   */
  async serviceAction(
    type: VpnType,
    op: string,
  ): Promise<{ enabled: boolean; ran?: boolean; code?: number; output?: string; detail?: string }> {
    const VALID_OPS = ['start', 'stop', 'restart', 'status'];
    const VALID_TYPES: VpnType[] = ['wireguard', 'openvpn', 'l2tp'];
    if (!VALID_OPS.includes(op)) throw new BadRequestException(`Unknown service operation "${op}".`);
    if (!VALID_TYPES.includes(type)) throw new BadRequestException(`Unknown VPN type "${type}".`);

    if (process.env.JBX_VPN_PRIVILEGED !== '1') {
      return { enabled: false, detail: 'Privileged service control is not enabled on this host. Use the operator installer / systemctl.' };
    }
    const helper = process.env.JBX_VPN_HELPER || '/opt/jointbox/vpn/jointbox-vpn-helper.sh';
    // Fixed path + argv array + bounded time + clean env. `sudo -n` never prompts.
    const r = await this.runFull('sudo', ['-n', helper, op, type], 15000);
    // Audit WITHOUT secrets (there are none in op/type, and we don't echo output verbatim to logs).
    this.logger.log(`VPN privileged action ${op} ${type} → ran=${r.ran} code=${r.code}`);
    return { enabled: true, ran: r.ran, code: r.code ?? undefined, output: (r.out || r.err).slice(0, 2000) };
  }

  /** The script for one VPN type, for a Download/Copy button. */
  async install(type: VpnType): Promise<{ script: string; mikrotik: string }> {
    const cfg = this.getConfig();
    if (type === 'wireguard') return { script: this.wireguardInstall(cfg), mikrotik: this.wireguardMikrotik(cfg, await this.wgPublicKey()) };
    if (type === 'openvpn') return { script: this.openvpnInstall(cfg), mikrotik: this.openvpnMikrotik(cfg) };
    if (type === 'l2tp') return { script: this.l2tpInstall(cfg), mikrotik: this.l2tpMikrotik(cfg) };
    throw new BadRequestException('Unknown VPN type.');
  }
}
