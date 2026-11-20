import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import * as path from 'path';
import { HostInventory, parseInventory } from './l2tp-address-policy';

/**
 * L2tpClientDialer — the Uplinko host's OUTBOUND L2TP/IPsec client to a NAS.
 *
 *   Uplinko server (client: strongSwan + xl2tpd + pppd)  ──►  NAS public IP (MikroTik L2TP server)
 *
 * This is a NAS MANAGEMENT tunnel. It never authenticates subscribers and never
 * touches FreeRADIUS, WireGuard or SSTP.
 *
 * How each daemon is driven (no shell, argv arrays only, via execFile):
 *   • strongSwan — one file per NAS in the swanctl conf.d directory that the
 *     stock /etc/swanctl/swanctl.conf already includes. `swanctl --load-all`
 *     loads every file there, so loading NAS 7 never unloads NAS 3.
 *     The PSK is written base64-encoded (`0s…`) and bound to the NAS public IP
 *     (`id-1`) — never a wildcard secret that could be offered to another NAS.
 *   • xl2tpd — the LAC is added to the running daemon with
 *     `xl2tpd-control add-lac`, dialed with `connect-lac`, and removed with
 *     `disconnect-lac` + `remove-lac`.
 *   • pppd — per-NAS options file. `ifname` gives every NAS its own fixed
 *     interface name (ulnas<ID>), so status is read from THAT interface only.
 *     `nodefaultroute` + no `usepeerdns`: the host default route and resolver
 *     are never touched; pppd only adds the /32 host route to the NAS tunnel
 *     address.
 *
 * "connected" is reported ONLY when ALL of these hold, read live from the host:
 *   1. this NAS's IKE SA is ESTABLISHED (`swanctl --list-sas --ike <name>`),
 *   2. interface ulnas<ID> exists and is UP,
 *   3. its addresses equal the configured panel/NAS tunnel addresses,
 *   4. the route to the NAS tunnel address goes out of that interface, and
 *   5. the host default route is unchanged from before the dial.
 */

export type DialState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type DialErrorCode =
  | 'tooling_missing'
  | 'invalid_config'
  | 'ipsec_auth_failed'
  | 'ipsec_proposal_mismatch'
  | 'nas_unreachable'
  | 'ipsec_failed'
  | 'l2tp_failed'
  | 'ppp_auth_failed'
  | 'address_mismatch'
  | 'route_violation'
  | 'timeout'
  | 'encryption_unverified'
  | 'cancelled'
  | 'host_error';

export interface DialParams {
  nasId: number;
  /** NAS public IPv4 address the host dials. */
  server: string;
  ipsecPsk: string;
  pppUsername: string;
  pppPassword: string;
  /** Panel (host) address inside the tunnel, e.g. 10.255.10.2 */
  localAddress: string;
  /** NAS address inside the tunnel, e.g. 10.255.10.1 */
  remoteAddress: string;
  timeoutSec?: number;
  retryCount?: number;
  retryDelaySec?: number;
}

export interface DialExpectation {
  localAddress?: string | null;
  remoteAddress?: string | null;
  /** NAS public IPv4 the ESP SA must be bound to. Without it encryption cannot be verified. */
  server?: string | null;
}

export interface DialOptions {
  /** Polled between steps; true aborts the dial and tears the tunnel down. */
  shouldCancel?: () => boolean;
}

export interface DialStatus {
  state: DialState;
  interface?: string | null;
  localAddress?: string | null;
  remoteAddress?: string | null;
  ipsec?: 'established' | 'connecting' | 'down' | null;
  l2tp?: 'up' | 'down' | null;
  detail?: string | null;
  error?: string | null;
  errorCode?: DialErrorCode | null;
  attempts?: number;
}

export interface ToolingStatus {
  ok: boolean;
  swanctl: boolean;
  xl2tpdControl: boolean;
  pppd: boolean;
  ip: boolean;
  xl2tpdControlSocket: boolean;
  detail: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DialerFs {
  writeSecret(file: string, data: string): Promise<void>;
  read(file: string): Promise<string | null>;
  remove(file: string): Promise<void>;
  /** Atomically create `dir` (fails with 'exists' if present) and write `owner` into it. */
  lockCreate(dir: string, owner: string): Promise<'ok' | 'exists'>;
  /** Remove a lock directory and its owner file. */
  lockRemove(dir: string): Promise<void>;
}

export interface HostLockOwner {
  token: string;
  pid: number;
}

export const L2TP_LIMITS = {
  MAX_RETRIES: 5,
  MAX_RETRY_DELAY_SEC: 60,
  MIN_TIMEOUT_SEC: 10,
  MAX_TIMEOUT_SEC: 120,
} as const;

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** True for a syntactically valid dotted IPv4 address. */
export function isIpv4(v: unknown): v is string {
  return typeof v === 'string' && IPV4.test(v);
}

/** Address the host may DIAL: valid IPv4, not unspecified/loopback/link-local/multicast/broadcast. */
export function isDialableIpv4(v: unknown): v is string {
  if (!isIpv4(v)) return false;
  const [a, b] = v.split('.').map(Number);
  if (a === 0 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** Usable tunnel address: valid IPv4, unicast, not loopback. */
export function isTunnelIpv4(v: unknown): v is string {
  return isDialableIpv4(v);
}

/** Printable secret without characters that could break a config line. */
export function isSafeSecret(v: unknown, max = 128): v is string {
  return (
    typeof v === 'string' &&
    v.length >= 8 &&
    v.length <= max &&
    /^[\x21-\x7e]+$/.test(v) &&
    !/["\\]/.test(v)
  );
}

export function isSafePppUser(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._@-]{3,64}$/.test(v);
}

@Injectable()
export class L2tpClientDialer {
  private readonly logger = new Logger('L2tpClientDialer');

  /** strongSwan conf.d included by the stock swanctl.conf. */
  readonly swanDir = process.env.L2TP_SWANCTL_CONF_DIR || '/etc/swanctl/conf.d';
  /** Uplinko-owned dir for pppd options and pppd logs (0700). */
  readonly pppDir = process.env.L2TP_CLIENT_DIR || '/etc/uplinko/l2tp';
  readonly controlSocket =
    process.env.XL2TPD_CONTROL_SOCKET || '/var/run/xl2tpd/l2tp-control';

  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  run: CommandRunner = (cmd, args, timeoutMs = 30_000) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err
            ? typeof (err as any).code === 'number'
              ? (err as any).code
              : 1
            : 0;
          resolve({
            code,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
          });
        },
      );
    });

  files: DialerFs = {
    writeSecret: async (file, data) => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, data, { mode: 0o600 });
      await fs.chmod(file, 0o600); // writeFile's mode only applies when the file is created
    },
    read: async (file) => fs.readFile(file, 'utf8').catch(() => null),
    remove: async (file) => fs.rm(file, { force: true }),
    lockCreate: async (dir, owner) => {
      await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      try {
        await fs.mkdir(dir, { mode: 0o700 }); // atomic on one host
      } catch (e: any) {
        if (e?.code === 'EEXIST') return 'exists';
        throw e;
      }
      await fs.writeFile(path.join(dir, 'owner.json'), owner, { mode: 0o600 });
      return 'ok';
    },
    lockRemove: async (dir) => fs.rm(dir, { recursive: true, force: true }),
  };

  /** Overridable for tests: is this process id alive on this host? */
  isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === 'EPERM';
    }
  };

  private lockDir(nasId: number) {
    return path.join(
      this.pppDir,
      'locks',
      `nas-${this.connName(nasId).slice('uplinko-nas-'.length)}`,
    );
  }

  /**
   * HOST-LEVEL per-NAS lock (all PM2 workers run on this host). Held for the
   * whole operation; a second worker cannot touch this NAS's strongSwan /
   * xl2tpd / pppd files or commands while the holder process is alive — even
   * if the holder's database lease has expired. A lock whose holder process
   * is dead is stale and is taken over.
   */
  async acquireHostLock(nasId: number, owner: HostLockOwner): Promise<boolean> {
    const dir = this.lockDir(nasId);
    for (let i = 0; i < 2; i++) {
      if (
        (await this.files.lockCreate(
          dir,
          JSON.stringify({ ...owner, at: new Date().toISOString() }),
        )) === 'ok'
      )
        return true;
      const raw = await this.files.read(path.join(dir, 'owner.json'));
      let cur: HostLockOwner | null = null;
      try {
        cur = raw ? JSON.parse(raw) : null;
      } catch {
        cur = null;
      }
      if (cur && cur.token === owner.token && cur.pid === owner.pid)
        return true;
      // Unreadable owner: only treat as stale if it is not freshly being written.
      if (cur && Number.isInteger(cur.pid) && this.isAlive(cur.pid))
        return false;
      if (!cur && i === 0) {
        await this.sleep(200);
        continue;
      }
      await this.files.lockRemove(dir); // holder is gone → stale
    }
    return false;
  }

  /** Release only a lock we own. */
  async releaseHostLock(nasId: number, owner: HostLockOwner): Promise<void> {
    const dir = this.lockDir(nasId);
    const raw = await this.files.read(path.join(dir, 'owner.json'));
    try {
      const cur = raw ? JSON.parse(raw) : null;
      if (cur?.token === owner.token && cur?.pid === owner.pid)
        await this.files.lockRemove(dir);
    } catch {
      /* not ours / unreadable: leave it */
    }
  }

  // ── naming ───────────────────────────────────────────────────────────────
  private assertNasId(nasId: number) {
    if (!Number.isInteger(nasId) || nasId <= 0 || nasId > 9_999_999_999)
      throw new Error('Invalid NAS id');
  }
  connName(nasId: number): string {
    this.assertNasId(nasId);
    return `uplinko-nas-${nasId}`;
  }
  /** Linux interface names are at most 15 characters. */
  ifName(nasId: number): string {
    this.assertNasId(nasId);
    return `ulnas${nasId}`;
  }
  private swanFile(nasId: number) {
    return path.join(this.swanDir, `${this.connName(nasId)}.conf`);
  }
  private pppFile(nasId: number) {
    return path.join(this.pppDir, `${this.connName(nasId)}.ppp`);
  }
  private pppLog(nasId: number) {
    return path.join(this.pppDir, `${this.connName(nasId)}.log`);
  }

  // ── validation ───────────────────────────────────────────────────────────
  validate(p: DialParams): string | null {
    try {
      this.assertNasId(p.nasId);
    } catch {
      return 'Invalid NAS id.';
    }
    if (!isDialableIpv4(p.server))
      return 'NAS public address must be a routable IPv4 address.';
    if (!isSafePppUser(p.pppUsername))
      return 'PPP username must be 3–64 characters: letters, digits, . _ @ -';
    if (!isSafeSecret(p.pppPassword))
      return 'PPP password must be 8–128 printable characters without quotes or backslashes.';
    if (!isSafeSecret(p.ipsecPsk))
      return 'IPsec pre-shared key must be 8–128 printable characters without quotes or backslashes.';
    if (!isTunnelIpv4(p.localAddress))
      return 'Panel tunnel address must be a valid IPv4 address.';
    if (!isTunnelIpv4(p.remoteAddress))
      return 'NAS tunnel address must be a valid IPv4 address.';
    if (p.localAddress === p.remoteAddress)
      return 'Panel and NAS tunnel addresses must differ.';
    if (p.remoteAddress === p.server || p.localAddress === p.server)
      return 'Tunnel addresses must differ from the NAS public address.';
    return null;
  }

  // ── host tooling ─────────────────────────────────────────────────────────
  async tooling(): Promise<ToolingStatus> {
    const has = async (bin: string) =>
      (await this.run('which', [bin], 5000)).code === 0;
    const [swanctl, xl2tpdControl, pppd, ip] = await Promise.all([
      has('swanctl'),
      has('xl2tpd-control'),
      has('pppd'),
      has('ip'),
    ]);
    const xl2tpdControlSocket =
      (await this.run('test', ['-S', this.controlSocket], 5000)).code === 0;
    const ok = swanctl && xl2tpdControl && pppd && ip && xl2tpdControlSocket;
    const missing = [
      !swanctl && 'strongSwan (swanctl)',
      !xl2tpdControl && 'xl2tpd (xl2tpd-control)',
      !pppd && 'pppd',
      !ip && 'iproute2 (ip)',
      !xl2tpdControlSocket &&
        `xl2tpd control socket ${this.controlSocket} (is xl2tpd running?)`,
    ].filter(Boolean);
    return {
      ok,
      swanctl,
      xl2tpdControl,
      pppd,
      ip,
      xl2tpdControlSocket,
      detail: ok
        ? 'Host L2TP/IPsec client tooling present.'
        : `Missing on this server: ${missing.join(', ')}.`,
    };
  }

  // ── config rendering (pure; exported for tests) ──────────────────────────
  renderSwan(p: DialParams): string {
    const name = this.connName(p.nasId);
    const psk = Buffer.from(p.ipsecPsk, 'utf8').toString('base64');
    // IKEv1 main mode + PSK, transport mode for L2TP (udp/1701) — the profile a
    // MikroTik `l2tp-server use-ipsec` peer accepts. No PFS on ESP (RouterOS
    // default). The secret is bound to this NAS's address only.
    return [
      `# Managed by Uplinko — NAS ${p.nasId} management VPN. Do not edit.`,
      'connections {',
      `  ${name} {`,
      '    version = 1',
      '    proposals = aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024',
      `    remote_addrs = ${p.server}`,
      '    dpd_delay = 30s',
      '    local { auth = psk }',
      `    remote { auth = psk id = ${p.server} }`,
      '    children {',
      `      ${name} {`,
      '        mode = transport',
      '        local_ts = dynamic[udp/1701]',
      '        remote_ts = dynamic[udp/1701]',
      '        esp_proposals = aes256-sha1,aes128-sha1,3des-sha1',
      '        start_action = none',
      '        dpd_action = clear',
      '      }',
      '    }',
      '  }',
      '}',
      'secrets {',
      `  ike-${name} {`,
      `    id-1 = ${p.server}`,
      `    secret = 0s${psk}`,
      '  }',
      '}',
      '',
    ].join('\n');
  }

  renderPpp(p: DialParams): string {
    const name = this.connName(p.nasId);
    return [
      `# Managed by Uplinko — NAS ${p.nasId} management VPN. Do not edit.`,
      `ifname ${this.ifName(p.nasId)}`,
      `linkname ${name}`,
      `ipparam ${name}`,
      `name "${p.pppUsername}"`,
      `password "${p.pppPassword}"`,
      `user "${p.pppUsername}"`,
      // We authenticate TO the NAS; we do not require the NAS to authenticate to us.
      'noauth',
      'refuse-pap',
      'refuse-chap',
      'refuse-eap',
      'refuse-mschap',
      // Static, verified addressing: both ends are fixed by the NAS PPP secret.
      `${p.localAddress}:${p.remoteAddress}`,
      // Routing isolation — never the default route, never the host resolver.
      'nodefaultroute',
      'noproxyarp',
      'nobsdcomp',
      'nodeflate',
      'noccp',
      'mtu 1400',
      'mru 1400',
      'lcp-echo-interval 20',
      'lcp-echo-failure 3',
      'maxfail 1',
      'nopersist',
      `logfile ${this.pppLog(p.nasId)}`,
      '',
    ].join('\n');
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async dial(p: DialParams, opts: DialOptions = {}): Promise<DialStatus> {
    const cancelled = () => !!opts.shouldCancel?.();
    const tooling = await this.tooling();
    if (!tooling.ok)
      return {
        state: 'error',
        errorCode: 'tooling_missing',
        error: tooling.detail,
      };
    const invalid = this.validate(p);
    if (invalid)
      return { state: 'error', errorCode: 'invalid_config', error: invalid };

    const retries = clamp(p.retryCount ?? 0, 0, L2TP_LIMITS.MAX_RETRIES);
    const delayMs =
      clamp(p.retryDelaySec ?? 5, 1, L2TP_LIMITS.MAX_RETRY_DELAY_SEC) * 1000;
    const timeoutSec = clamp(
      p.timeoutSec ?? 30,
      L2TP_LIMITS.MIN_TIMEOUT_SEC,
      L2TP_LIMITS.MAX_TIMEOUT_SEC,
    );

    const defaultBefore = await this.defaultRoutes();
    let last: DialStatus = {
      state: 'error',
      errorCode: 'host_error',
      error: 'Dial not attempted.',
    };
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (cancelled()) {
        await this.teardown(p.nasId);
        return {
          state: 'disconnected',
          errorCode: 'cancelled',
          error: 'The connect operation was cancelled.',
          attempts: attempt - 1,
        };
      }
      last = await this.attempt(p, timeoutSec, defaultBefore, cancelled);
      last.attempts = attempt;
      if (last.state === 'connected') return last;
      await this.teardown(p.nasId); // never leave a half-built tunnel behind
      // Wrong credentials will not fix themselves — do not hammer the NAS.
      if (
        last.errorCode === 'ipsec_auth_failed' ||
        last.errorCode === 'ppp_auth_failed' ||
        last.errorCode === 'ipsec_proposal_mismatch' ||
        last.errorCode === 'route_violation' ||
        last.errorCode === 'address_mismatch' ||
        last.errorCode === 'encryption_unverified' ||
        last.errorCode === 'cancelled'
      )
        break;
      if (attempt <= retries) await this.sleep(delayMs);
    }
    if (last.state !== 'error' && last.errorCode !== 'cancelled') {
      last = {
        ...last,
        state: 'error',
        errorCode: last.errorCode ?? 'timeout',
        error: last.error ?? 'Tunnel was not established.',
      };
    }
    return last;
  }

  private async attempt(
    p: DialParams,
    timeoutSec: number,
    defaultBefore: string,
    cancelled: () => boolean = () => false,
  ): Promise<DialStatus> {
    const name = this.connName(p.nasId);
    try {
      const stop = () => ({
        state: 'disconnected' as const,
        errorCode: 'cancelled' as const,
        error: 'The connect operation was cancelled or lost its lock.',
      });
      if (cancelled()) return stop();
      await this.files.writeSecret(this.swanFile(p.nasId), this.renderSwan(p));
      await this.files.writeSecret(this.pppFile(p.nasId), this.renderPpp(p));
      await this.files.remove(this.pppLog(p.nasId));

      if (cancelled()) return stop();
      const load = await this.run(
        'swanctl',
        ['--load-all', '--noprompt'],
        20_000,
      );
      if (load.code !== 0) {
        return {
          state: 'error',
          errorCode: 'host_error',
          ipsec: 'down',
          error: 'strongSwan rejected the generated connection config.',
        };
      }
      if (cancelled()) return stop();
      const init = await this.run(
        'swanctl',
        ['--initiate', '--child', name, '--timeout', String(timeoutSec)],
        (timeoutSec + 5) * 1000,
      );
      if (init.code !== 0) {
        const c = classifyIpsec(`${init.stdout}\n${init.stderr}`);
        return {
          state: 'error',
          ipsec: 'down',
          errorCode: c.code,
          error: c.message,
        };
      }

      // Stale LAC from an earlier run is harmless to remove; ignore the result.
      await this.run(
        'xl2tpd-control',
        ['-c', this.controlSocket, 'remove-lac', name],
        5000,
      );
      if (cancelled()) return stop();
      const add = await this.run(
        'xl2tpd-control',
        [
          '-c',
          this.controlSocket,
          'add-lac',
          name,
          `lns=${p.server}`,
          `pppoptfile=${this.pppFile(p.nasId)}`,
          'autodial=no',
          'redial=no',
        ],
        10_000,
      );
      if (add.code !== 0 || /error|fail/i.test(add.stdout + add.stderr)) {
        return {
          state: 'error',
          ipsec: 'established',
          l2tp: 'down',
          errorCode: 'l2tp_failed',
          error: 'xl2tpd refused to add the L2TP client for this NAS.',
        };
      }
      if (cancelled()) return stop();
      const con = await this.run(
        'xl2tpd-control',
        ['-c', this.controlSocket, 'connect-lac', name],
        10_000,
      );
      if (con.code !== 0 || /error|fail/i.test(con.stdout + con.stderr)) {
        return {
          state: 'error',
          ipsec: 'established',
          l2tp: 'down',
          errorCode: 'l2tp_failed',
          error: 'xl2tpd could not start the L2TP session.',
        };
      }

      const deadline = Date.now() + timeoutSec * 1000;
      let st: DialStatus = { state: 'connecting' };
      while (Date.now() < deadline) {
        if (cancelled()) {
          return {
            state: 'disconnected',
            errorCode: 'cancelled',
            error: 'The connect operation was cancelled.',
          };
        }
        st = await this.status(
          p.nasId,
          {
            localAddress: p.localAddress,
            remoteAddress: p.remoteAddress,
            server: p.server,
          },
          defaultBefore,
        );
        if (
          st.state === 'connected' ||
          st.errorCode === 'address_mismatch' ||
          st.errorCode === 'route_violation' ||
          st.errorCode === 'encryption_unverified'
        )
          return st;
        const ppp = classifyPppLog(await this.files.read(this.pppLog(p.nasId)));
        if (ppp)
          return {
            ...st,
            state: 'error',
            l2tp: 'down',
            errorCode: ppp.code,
            error: ppp.message,
          };
        await this.sleep(1000);
      }
      return {
        ...st,
        state: 'error',
        errorCode: 'timeout',
        error: `Tunnel not established within ${timeoutSec}s.`,
      };
    } catch (e: any) {
      this.logger.warn(
        `NAS ${p.nasId}: dialer failure (${String(e?.message || e).slice(0, 160)})`,
      );
      return {
        state: 'error',
        errorCode: 'host_error',
        error: 'The server could not run the VPN client tooling.',
      };
    }
  }

  /** Tear down this NAS's tunnel only. Config files are kept for the next dial. */
  async hangup(nasId: number): Promise<DialStatus> {
    await this.teardown(nasId);
    return {
      state: 'disconnected',
      ipsec: 'down',
      l2tp: 'down',
      interface: null,
    };
  }

  /** Tear down and delete this NAS's host files (used when the config is removed). */
  async purge(nasId: number): Promise<{ clean: boolean; remaining: string[] }> {
    await this.teardown(nasId);
    await this.files.remove(this.swanFile(nasId));
    await this.files.remove(this.pppFile(nasId));
    await this.files.remove(this.pppLog(nasId));
    await this.run('swanctl', ['--load-all', '--noprompt'], 20_000); // drop the unloaded connection
    // Verify — only THIS NAS's resources are inspected.
    const name = this.connName(nasId);
    const iface = this.ifName(nasId);
    const remaining: string[] = [];
    const sa = await this.run('swanctl', ['--list-sas', '--ike', name], 10_000);
    if (sa.code !== 0) remaining.push('IPsec state unknown (swanctl failed)');
    else if (sa.stdout.includes(`${name}:`)) remaining.push(`IPsec SA ${name}`);
    const link = await this.run(
      'ip',
      ['-o', 'link', 'show', 'dev', iface],
      5000,
    );
    if (link.code === 0 && link.stdout.includes(iface))
      remaining.push(`interface ${iface}`);
    for (const f of [this.swanFile(nasId), this.pppFile(nasId)]) {
      if ((await this.files.read(f)) !== null) remaining.push(`file ${f}`);
    }
    return { clean: remaining.length === 0, remaining };
  }

  /**
   * Host network inventory for the address policy: `ip -j -4 addr show` and
   * `ip -j -4 route show table main` (iproute2 JSON). Null when either cannot
   * be read or parsed — callers must then refuse (fail closed).
   */
  async inventory(): Promise<HostInventory | null> {
    const a = await this.run('ip', ['-j', '-4', 'addr', 'show'], 5000);
    const r = await this.run(
      'ip',
      ['-j', '-4', 'route', 'show', 'table', 'main'],
      5000,
    );
    if (a.code !== 0 || r.code !== 0) return null;
    return parseInventory(a.stdout, r.stdout);
  }

  private async teardown(nasId: number): Promise<void> {
    const name = this.connName(nasId);
    await this.run(
      'xl2tpd-control',
      ['-c', this.controlSocket, 'disconnect-lac', name],
      5000,
    );
    await this.run(
      'xl2tpd-control',
      ['-c', this.controlSocket, 'remove-lac', name],
      5000,
    );
    await this.run(
      'swanctl',
      ['--terminate', '--ike', name, '--timeout', '10'],
      15_000,
    );
  }

  /** `ip -4 route show default`, normalised — used to prove the dial left it alone. */
  async defaultRoutes(): Promise<string> {
    const r = await this.run('ip', ['-4', 'route', 'show', 'default'], 5000);
    return r.code === 0
      ? r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .sort()
          .join('\n')
      : '';
  }

  /**
   * Live, NAS-specific status. Never derived from saved configuration.
   * With `expect`, addresses must match; with `defaultBefore`, the host default
   * route must be unchanged.
   */
  async status(
    nasId: number,
    expect: DialExpectation = {},
    defaultBefore?: string,
  ): Promise<DialStatus> {
    const tooling = await this.tooling();
    if (!tooling.ok)
      return {
        state: 'error',
        errorCode: 'tooling_missing',
        error: tooling.detail,
      };
    const name = this.connName(nasId);
    const iface = this.ifName(nasId);

    const sa = await this.run('swanctl', ['--list-sas', '--ike', name], 10_000);
    const ipsecUp =
      sa.code === 0 &&
      sa.stdout.includes(name) &&
      /\bESTABLISHED\b/.test(sa.stdout);
    const ipsecConnecting =
      sa.code === 0 &&
      sa.stdout.includes(name) &&
      /\bCONNECTING\b/.test(sa.stdout);

    const link = await this.run(
      'ip',
      ['-o', 'link', 'show', 'dev', iface],
      5000,
    );
    const linkPresent = link.code === 0 && link.stdout.includes(iface);
    const linkUp = linkPresent && /<[^>]*\bUP\b[^>]*>/.test(link.stdout);

    if (!ipsecUp) {
      return {
        state: ipsecConnecting ? 'connecting' : 'disconnected',
        ipsec: ipsecConnecting ? 'connecting' : 'down',
        l2tp: linkUp ? 'up' : 'down',
        interface: linkPresent ? iface : null,
      };
    }
    if (!linkUp) {
      return {
        state: 'connecting',
        ipsec: 'established',
        l2tp: 'down',
        interface: linkPresent ? iface : null,
        detail: 'IPsec established; L2TP/PPP not up yet.',
      };
    }

    const addr = await this.run(
      'ip',
      ['-o', '-4', 'addr', 'show', 'dev', iface],
      5000,
    );
    const local = addr.stdout.match(/\binet\s+([0-9.]+)/)?.[1] ?? null;
    const peer = addr.stdout.match(/\bpeer\s+([0-9.]+)/)?.[1] ?? null;
    const base = {
      interface: iface,
      localAddress: local,
      remoteAddress: peer,
      ipsec: 'established' as const,
      l2tp: 'up' as const,
    };
    if (!local || !peer)
      return {
        ...base,
        state: 'connecting',
        detail: 'PPP up; waiting for IP addresses.',
      };
    if (
      (expect.localAddress && local !== expect.localAddress) ||
      (expect.remoteAddress && peer !== expect.remoteAddress)
    ) {
      return {
        ...base,
        state: 'error',
        errorCode: 'address_mismatch',
        error: `Tunnel came up with ${local} → ${peer}, but ${expect.localAddress} → ${expect.remoteAddress} is configured. Check the NAS PPP secret addresses.`,
      };
    }

    const route = await this.run('ip', ['-4', 'route', 'get', peer], 5000);
    if (
      route.code !== 0 ||
      !new RegExp(`\\bdev ${iface}\\b`).test(route.stdout)
    ) {
      return {
        ...base,
        state: 'error',
        errorCode: 'route_violation',
        error: `Traffic to ${peer} does not use ${iface}; another route overrides it.`,
      };
    }
    if (defaultBefore !== undefined) {
      const after = await this.defaultRoutes();
      if (
        after !== defaultBefore ||
        new RegExp(`\\bdev ${iface}\\b`).test(after)
      ) {
        return {
          ...base,
          state: 'error',
          errorCode: 'route_violation',
          error:
            'The host default route changed during the dial; the tunnel was refused.',
        };
      }
    }
    // Encryption proof: the ESP CHILD_SA protecting L2TP to THIS NAS must be
    // installed, and the kernel must hold the matching ESP transport state.
    // A PPP link without it means L2TP is running in clear — never "connected".
    const enc = await this.verifyEncryption(
      name,
      expect.server ?? null,
      sa.stdout,
    );
    if (!enc.ok) {
      return {
        ...base,
        state: 'error',
        errorCode: 'encryption_unverified',
        error: enc.reason,
      };
    }
    return {
      ...base,
      state: 'connected',
      detail: `ESP ${enc.cipher} transport SA to ${expect.server} installed; ${iface} up; ${local} → ${peer} routed via ${iface}.`,
    };
  }

  private async verifyEncryption(
    name: string,
    server: string | null,
    listSas: string,
  ): Promise<{ ok: true; cipher: string } | { ok: false; reason: string }> {
    if (!server || !isIpv4(server)) {
      return {
        ok: false,
        reason:
          'The NAS public address is not known, so the encryption of this tunnel cannot be verified.',
      };
    }
    const sa = parseSwanctlSas(listSas, name);
    if (!sa.ike || sa.ike.state !== 'ESTABLISHED')
      return { ok: false, reason: 'No established IKE SA for this NAS.' };
    if (sa.ike.remoteHost !== server)
      return {
        ok: false,
        reason: `The IKE SA peer (${sa.ike.remoteHost ?? 'unknown'}) is not this NAS (${server}).`,
      };
    const child = sa.children.find((c) => c.name === name);
    if (!child)
      return {
        ok: false,
        reason:
          'IPsec is negotiated but no ESP SA protects the L2TP traffic (it would be unencrypted).',
      };
    if (child.state !== 'INSTALLED')
      return {
        ok: false,
        reason: `The ESP SA is ${child.state}, not INSTALLED.`,
      };
    if (!/^TRANSPORT/.test(child.mode))
      return {
        ok: false,
        reason: `The ESP SA is in ${child.mode} mode, not transport.`,
      };
    if (child.protocol !== 'ESP')
      return {
        ok: false,
        reason: `The SA uses ${child.protocol}, not ESP encryption.`,
      };
    if (!child.cipher || /^NULL/i.test(child.cipher))
      return { ok: false, reason: 'The ESP SA has no encryption algorithm.' };
    const l2tpTs = (ts: string[], ip?: string) =>
      ts.some((x) => {
        const m = x.match(/^([0-9.]+)\/32\[udp\/(1701|l2f|l2tp)\]$/);
        return !!m && (!ip || m[1] === ip);
      });
    if (!l2tpTs(child.remoteTs, server) || !l2tpTs(child.localTs)) {
      return {
        ok: false,
        reason:
          'The ESP SA traffic selectors do not cover L2TP (UDP 1701) to this NAS.',
      };
    }
    const x = await this.run(
      'ip',
      ['xfrm', 'state', 'list', 'dst', server, 'proto', 'esp'],
      5000,
    );
    if (
      x.code !== 0 ||
      !/\bproto esp\b/.test(x.stdout) ||
      !/\bmode transport\b/.test(x.stdout)
    ) {
      return {
        ok: false,
        reason: 'The kernel holds no ESP transport state towards this NAS.',
      };
    }
    return { ok: true, cipher: child.cipher };
  }
}

export interface ParsedSas {
  ike: { state: string; remoteHost: string | null } | null;
  children: {
    name: string;
    state: string;
    mode: string;
    protocol: string;
    cipher: string | null;
    localTs: string[];
    remoteTs: string[];
  }[];
}

/**
 * Parse `swanctl --list-sas --ike <name>` (strongSwan 5.x, src/swanctl/
 * commands/list_sas.c). Layout relied on:
 *   <ike>: #<id>, <STATE>, IKEv1, <spi>_i <spi>_r
 *     local  '<id>' @ <host>[<port>]
 *     remote '<id>' @ <host>[<port>]
 *     <proposal>
 *     ...
 *     <child>: #<id>, reqid <n>, <STATE>, <MODE>[-in-UDP], <PROTO>:<ENC>[-<bits>]/<INTEG>...
 *       installed ..., in/out ...,
 *       local  <net>/<bits>[<proto>/<port>]
 *       remote <net>/<bits>[<proto>/<port>]
 * Anything that does not match is treated as absent (fail closed).
 */
export function parseSwanctlSas(out: string, name: string): ParsedSas {
  const res: ParsedSas = { ike: null, children: [] };
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ikeRe = new RegExp(`^${esc}: #\\d+, ([A-Z_]+), IKEv[12],`);
  const childRe = new RegExp(
    `^  (\\S+): #\\d+, reqid \\d+, ([A-Z_]+), ([A-Za-z_-]+), ([A-Z]+):(\\S+)?`,
  );
  let child: ParsedSas['children'][number] | null = null;
  let inIke = false;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const ike = line.match(ikeRe);
    if (ike) {
      res.ike = { state: ike[1], remoteHost: null };
      inIke = true;
      child = null;
      continue;
    }
    if (/^\S/.test(line)) {
      inIke = false;
      child = null;
      continue;
    } // another IKE SA
    if (!inIke) continue;
    const rem = line.match(/^ {2}remote '[^']*' @ ([0-9.]+)\[\d+\]/);
    if (rem && res.ike && !child) {
      res.ike.remoteHost = rem[1];
      continue;
    }
    const c = line.match(childRe);
    if (c) {
      child = {
        name: c[1],
        state: c[2],
        mode: c[3],
        protocol: c[4],
        cipher: c[5] ? c[5].split('/')[0] : null,
        localTs: [],
        remoteTs: [],
      };
      res.children.push(child);
      continue;
    }
    if (child) {
      const ts = line.match(/^ {4}(local|remote)\s+(.+)$/);
      if (ts)
        (ts[1] === 'local' ? child.localTs : child.remoteTs).push(
          ...ts[2].trim().split(/\s+/),
        );
    }
  }
  return res;
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : lo;
  return Math.min(hi, Math.max(lo, v));
}

export function classifyIpsec(out: string): {
  code: DialErrorCode;
  message: string;
} {
  if (
    /AUTHENTICATION_FAILED|INVALID_HASH|integrity check failed|no shared key found|invalid HASH_V1/i.test(
      out,
    )
  ) {
    return {
      code: 'ipsec_auth_failed',
      message:
        'IPsec authentication failed — the pre-shared key does not match the NAS.',
    };
  }
  if (
    /NO_PROPOSAL_CHOSEN|no acceptable proposal|no matching proposal/i.test(out)
  ) {
    return {
      code: 'ipsec_proposal_mismatch',
      message:
        'IPsec proposal mismatch — the NAS rejected every offered cipher set.',
    };
  }
  if (
    /retransmit|giving up|timed? ?out|unreachable|no route|peer not responding/i.test(
      out,
    )
  ) {
    return {
      code: 'nas_unreachable',
      message:
        'NAS did not answer IPsec (UDP 500/4500). Check its public address and firewall.',
    };
  }
  return { code: 'ipsec_failed', message: 'IPsec negotiation failed.' };
}

export function classifyPppLog(
  log: string | null,
): { code: DialErrorCode; message: string } | null {
  if (!log) return null;
  if (
    /authentication failed|auth(entication)? .*rejected|CHAP authentication failed|MS-CHAP authentication failed|PAP authentication failed/i.test(
      log,
    )
  ) {
    return {
      code: 'ppp_auth_failed',
      message:
        'PPP authentication failed — the NAS rejected the panel PPP username or password.',
    };
  }
  if (
    /LCP: timeout|No response to \d+ echo-requests|Connection terminated|Modem hangup|peer refused to agree to our IP address/i.test(
      log,
    )
  ) {
    return {
      code: 'l2tp_failed',
      message: 'The L2TP/PPP session was closed by the NAS before it came up.',
    };
  }
  return null;
}
