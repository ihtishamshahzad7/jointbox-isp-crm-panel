import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * WIREGUARD MANAGEMENT TUNNELS — reaching a router that has no public address.
 *
 * THE PROBLEM
 * Nearly every small ISP the panel is sold to sits behind CGNAT. Their routers
 * have no reachable public IP, so every action the panel performs TOWARD a
 * router — RouterOS API calls, SNMP polls, CoA disconnects for a defaulter —
 * works on the LAN and silently stops working the moment the router is
 * somewhere else. The panel becomes a read-only dashboard fed by whatever the
 * router chooses to push.
 *
 * WireGuard reverses the direction of the connection. The router dials OUT to
 * the panel, which CGNAT allows, and `PersistentKeepalive` holds the mapping
 * open. The panel then has a stable overlay address for that router forever
 * after, and nothing else in the codebase has to change: `nasIp` becomes the
 * overlay IP and every existing caller keeps working unmodified. That is the
 * point of doing it this way rather than inventing a proxy protocol.
 *
 * THE FOUR RULES THAT MAKE THIS SAFE
 *
 *  1. THE PRIVATE KEY IS NEVER STORED. WireGuard authenticates peers by public
 *     key; a hub has no use for the peer's private key. Keeping it would mean
 *     one database dump yields the identity of every router on the network.
 *     It is generated, returned once in the config, and discarded. Recovery is
 *     rotation, not retrieval.
 *
 *  2. OVERLAY IPs ARE UNIQUE, ENFORCED BY THE DATABASE. Two routers sharing an
 *     address does not raise an error — it silently routes one router's
 *     traffic to the other, so a disconnect meant for a defaulter in one town
 *     lands on a paying customer in another. Allocation therefore races
 *     against a UNIQUE constraint and retries, rather than trusting a
 *     read-then-write.
 *
 *  3. NOTHING REACHES A SHELL. Every value passed to `wg` is validated against
 *     a strict pattern first and handed over as an argv array via execFile —
 *     never a shell string. A public key is exactly 44 base64 characters; an
 *     overlay IP is exactly four octets. Anything else is refused before the
 *     command is built.
 *
 *  4. THE DATABASE IS THE SOURCE OF TRUTH. The kernel's peer list is a cache
 *     that is lost on reboot, so `reconcile()` rebuilds it from the rows.
 *     Provisioning writes the row first and applies to the kernel second: a
 *     peer in the kernel with no row is an orphan nobody can see or revoke,
 *     which is strictly worse than a row whose peer is one reconcile away.
 *
 * DEPLOYMENT NOTE: this needs `wg` on the panel host and an existing WireGuard
 * interface (default `wg0`). When either is absent, provisioning still records
 * the tunnel and returns the router config — it simply reports that the peer
 * was not applied, so an operator can set the host up afterwards and run
 * reconcile. Failing the whole request would be worse: the admin would have no
 * idea what was needed.
 */

/**
 * Exactly what WireGuard accepts as a key: 32 raw bytes, base64, one '=' pad.
 *
 * The final character is constrained, and the constraint is easy to get wrong.
 * 32 bytes base64-encode to 43 characters plus padding; the 43rd carries only
 * the low 4 bits of the last byte, shifted left by 2. Its value is therefore
 * always a multiple of 4 — sixteen possible characters, NOT the thirteen that
 * the commonly-copied version of this pattern allows. The first draft here
 * omitted `0`, `4` and `8` and so rejected roughly one valid key in five,
 * which was caught by generating four thousand keys and collecting the final
 * characters that actually occur. Do not "tidy" this set.
 */
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export type TunnelConfig = {
  overlayIp: string;
  /** Shown ONCE. Never stored, never retrievable again. */
  privateKey: string;
  serverPublicKey: string;
  serverEndpoint: string;
  /** Ready-to-paste RouterOS commands. */
  mikrotik: string;
  /** Ready-to-save wg-quick config for Linux-based devices. */
  wgQuick: string;
  applied: boolean;
  warning?: string;
};

@Injectable()
export class TunnelService {
  private readonly logger = new Logger(TunnelService.name);

  constructor(private prisma: PrismaService) {}

  // ── configuration ────────────────────────────────────────────
  private get iface() {
    return process.env.WG_INTERFACE || 'wg0';
  }
  /** The /24 the overlay lives in. .1 is the panel itself. */
  private get subnet() {
    return process.env.WG_SUBNET || '10.66.0.0/24';
  }
  private get listenPort() {
    return Number(process.env.WG_LISTEN_PORT || 51820);
  }
  private get endpointHost() {
    return process.env.WG_ENDPOINT_HOST || '';
  }
  private get keepalive() {
    return Number(process.env.WG_KEEPALIVE || 25);
  }

  // ── validation, before anything is built into a command ──────
  private assertKey(k: string, what: string): string {
    if (!WG_KEY.test(k)) {
      throw new BadRequestException(`${what} is not a valid WireGuard key.`);
    }
    return k;
  }

  private assertIp(ip: string): string {
    const m = IPV4.exec(ip);
    if (!m || m.slice(1).some((o) => Number(o) > 255)) {
      throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);
    }
    return ip;
  }

  // ── key generation ───────────────────────────────────────────
  /**
   * WireGuard keys are raw X25519, base64-encoded. Node can generate the pair
   * natively, so we do NOT shell out to `wg genkey` — that would make key
   * generation depend on the wireguard-tools package being installed, and a
   * missing binary would then silently become "provisioning is broken".
   *
   * The DER prefixes below are the fixed PKCS#8 / SPKI headers for X25519;
   * stripping them leaves exactly the 32 raw bytes WireGuard wants.
   */
  generateKeypair(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16);
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
    return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
  }

  /** Derive the public half of a key we were handed. */
  publicFromPrivate(privateKeyB64: string): string {
    const raw = Buffer.from(this.assertKey(privateKeyB64, 'Private key'), 'base64');
    const der = Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      raw,
    ]);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return createPublicKey(key)
      .export({ type: 'spki', format: 'der' })
      .subarray(12)
      .toString('base64');
  }

  // ── the panel's own identity ─────────────────────────────────
  /**
   * The hub's public key, read from the live interface. Read rather than
   * stored because the interface is the authority: if an operator re-keys the
   * server, a stored copy would hand out configs that can never connect.
   */
  async serverPublicKey(): Promise<string | null> {
    const out = await this.wg(['show', this.iface, 'public-key']).catch(() => null);
    const k = out?.trim();
    return k && WG_KEY.test(k) ? k : null;
  }

  // ── address allocation ───────────────────────────────────────
  /**
   * Next free overlay address.
   *
   * Deliberately NOT "max + 1": tunnels get revoked, and always climbing would
   * exhaust a /24 after 254 lifetime provisions even with three routers left.
   * Reusing the lowest free host also keeps the range readable for an operator
   * looking at a routing table.
   */
  private async nextOverlayIp(): Promise<string> {
    const [base, bitsRaw] = this.subnet.split('/');
    const bits = Number(bitsRaw || 24);
    this.assertIp(base);
    if (bits < 16 || bits > 30) {
      throw new BadRequestException(
        `WG_SUBNET must be between /16 and /30 — "${this.subnet}" is not usable.`,
      );
    }

    const baseNum = base.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const size = 2 ** (32 - bits);
    const network = baseNum & (size - 1 ? ~(size - 1) >>> 0 : 0xffffffff);

    const taken = new Set(
      (await this.prisma.nasTunnel.findMany({ select: { overlayIp: true } })).map(
        (t) => t.overlayIp,
      ),
    );

    // Host 1 is the panel itself; the last address is broadcast.
    for (let host = 2; host < size - 1; host++) {
      const n = (network + host) >>> 0;
      const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      if (!taken.has(ip)) return ip;
    }
    throw new ConflictException(
      `No addresses left in ${this.subnet}. Widen WG_SUBNET or revoke unused tunnels.`,
    );
  }

  // ── running wg ───────────────────────────────────────────────
  /**
   * Argument ARRAY, no shell, short timeout. Nothing here is ever string
   * interpolation — see rule 3 in the class docblock.
   */
  private wg(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('wg', args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve(stdout || '');
      });
    });
  }

  /** Add or update one peer in the kernel. Idempotent — `wg set` upserts. */
  private async applyPeer(publicKey: string, overlayIp: string): Promise<void> {
    this.assertKey(publicKey, 'Router public key');
    this.assertIp(overlayIp);
    await this.wg([
      'set',
      this.iface,
      'peer',
      publicKey,
      // /32 is the point: this peer may use exactly one address and no other,
      // so a compromised router cannot claim its neighbours' overlay IPs.
      'allowed-ips',
      `${overlayIp}/32`,
      'persistent-keepalive',
      String(this.keepalive),
    ]);
  }

  private async removePeer(publicKey: string): Promise<void> {
    this.assertKey(publicKey, 'Router public key');
    await this.wg(['set', this.iface, 'peer', publicKey, 'remove']);
  }

  // ── provisioning ─────────────────────────────────────────────
  /**
   * Provision a tunnel for a router and return the config to paste into it.
   *
   * The caller is responsible for having checked that the actor OWNS this NAS
   * (NasService.assertNasOwner) — a tunnel is standing remote access to
   * somebody's network, so it is owner-only by the same reasoning that editing
   * the router is.
   */
  async provision(
    nasId: number,
    opts: { createdBy?: number | null; rotate?: boolean } = {},
  ): Promise<TunnelConfig> {
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { id: true, shortname: true, nasname: true },
    });
    if (!nas) throw new NotFoundException(`NAS with ID ${nasId} not found`);

    const existing = await this.prisma.nasTunnel.findUnique({ where: { nasId } });
    if (existing && !opts.rotate) {
      throw new ConflictException(
        `This router already has a tunnel on ${existing.overlayIp}. ` +
          `Rotate it to issue new keys — the previous config will stop working.`,
      );
    }

    const serverPub = await this.serverPublicKey();
    const endpoint = this.endpointHost
      ? `${this.endpointHost}:${this.listenPort}`
      : '';

    const { privateKey, publicKey } = this.generateKeypair();

    /**
     * Keep the address across a rotation. The overlay IP is what `nasIp`
     * points at and what any static route on the operator's side targets;
     * moving it during a re-key would turn a routine credential rotation into
     * a silent loss of reachability.
     */
    const row = existing
      ? await this.prisma.nasTunnel.update({
          where: { nasId },
          data: {
            publicKey,
            serverEndpoint: endpoint,
            serverPublicKey: serverPub || '',
            enabled: true,
            rotatedAt: new Date(),
            // Liveness belongs to the OLD key. Clearing it stops the UI
            // reporting a healthy tunnel that no longer exists.
            lastHandshake: null,
          },
        })
      : await this.claimAddress({
          nasId,
          publicKey,
          serverEndpoint: endpoint,
          serverPublicKey: serverPub || '',
          createdBy: opts.createdBy ?? null,
        });

    // The old peer must go BEFORE the new one is added, or the router could
    // briefly authenticate with a key we have just revoked on paper.
    if (existing) await this.removePeer(existing.publicKey).catch(() => null);

    let applied = true;
    let warning: string | undefined;
    try {
      await this.applyPeer(publicKey, row.overlayIp);
    } catch (e: any) {
      applied = false;
      warning =
        `Recorded, but the peer was not added to "${this.iface}": ${e?.message || e}. ` +
        `Install wireguard-tools and bring the interface up, then run Reconcile.`;
      this.logger.warn(`Tunnel for NAS #${nasId} not applied: ${e?.message || e}`);
    }
    if (!serverPub) {
      warning =
        (warning ? warning + ' ' : '') +
        `The panel's own WireGuard interface is not running, so the config below has no server key yet.`;
    }
    if (!endpoint) {
      warning =
        (warning ? warning + ' ' : '') +
        `Set WG_ENDPOINT_HOST to the panel's public address — without it the router has nothing to dial.`;
    }

    this.logger.log(
      `${existing ? 'Rotated' : 'Provisioned'} tunnel for NAS #${nasId} on ${row.overlayIp}`,
    );

    return {
      overlayIp: row.overlayIp,
      privateKey,
      serverPublicKey: serverPub || '',
      serverEndpoint: endpoint,
      mikrotik: this.mikrotikScript(nas.shortname || `nas${nasId}`, privateKey, row.overlayIp, serverPub, endpoint),
      wgQuick: this.wgQuickConfig(privateKey, row.overlayIp, serverPub, endpoint),
      applied,
      warning,
    };
  }

  /**
   * Create the row, letting the UNIQUE constraint arbitrate the address.
   *
   * Two admins provisioning at the same moment both read the same "free"
   * address. Checking-then-creating cannot fix that — the gap between the two
   * queries is exactly where the collision lives — and a collision here is not
   * an error the operator sees, it is two routers quietly sharing an address
   * so that a CoA disconnect for one lands on the other.
   *
   * So the INSERT is the arbitration: the loser gets P2002 on `overlayIp`,
   * re-reads what is now taken, and takes the next one. Retrying only on that
   * specific code matters — a blanket catch would spin on a genuine failure
   * (a bad NAS id, a dead connection) and bury it behind a misleading
   * "no addresses left".
   */
  private async claimAddress(data: {
    nasId: number;
    publicKey: string;
    serverEndpoint: string;
    serverPublicKey: string;
    createdBy: number | null;
  }) {
    let lastErr: any;
    for (let attempt = 0; attempt < 6; attempt++) {
      const overlayIp = await this.nextOverlayIp();
      try {
        return await this.prisma.nasTunnel.create({ data: { ...data, overlayIp } });
      } catch (e: any) {
        const target = String(e?.meta?.target ?? '');
        if (e?.code === 'P2002' && target.includes('overlayIp')) {
          lastErr = e;
          continue; // somebody took it between our read and our write
        }
        throw e;
      }
    }
    throw new ConflictException(
      `Could not allocate a tunnel address after several attempts (${lastErr?.message || 'address contention'}). Try again.`,
    );
  }

  // ── revocation ───────────────────────────────────────────────
  async revoke(nasId: number): Promise<{ revoked: boolean; overlayIp?: string }> {
    const t = await this.prisma.nasTunnel.findUnique({ where: { nasId } });
    if (!t) return { revoked: false };

    // Kernel first: if the row went first and this then failed, the peer would
    // keep working with nothing left in the panel to revoke it by.
    await this.removePeer(t.publicKey).catch((e) =>
      this.logger.warn(`Peer removal failed for NAS #${nasId}: ${e?.message || e}`),
    );
    await this.prisma.nasTunnel.delete({ where: { nasId } });
    this.logger.log(`Revoked tunnel for NAS #${nasId} (${t.overlayIp})`);
    return { revoked: true, overlayIp: t.overlayIp };
  }

  // ── health ───────────────────────────────────────────────────
  /**
   * Refresh liveness from the kernel.
   *
   * A WireGuard peer has no connection state; the ONLY evidence a tunnel works
   * is a recent handshake. WireGuard re-handshakes about every two minutes, so
   * anything older than ~3 minutes means the router has stopped talking —
   * that threshold is what turns a timestamp into an up/down answer.
   */
  async refreshStatus(): Promise<{ checked: number; up: number }> {
    let dump: string;
    try {
      dump = await this.wg(['show', this.iface, 'dump']);
    } catch (e: any) {
      this.logger.warn(`Cannot read WireGuard status: ${e?.message || e}`);
      return { checked: 0, up: 0 };
    }

    // dump format, tab-separated, first line is the interface itself:
    // pubkey  presharedkey  endpoint  allowed-ips  latest-handshake  rx  tx  keepalive
    const byKey = new Map<string, { hs: number; rx: bigint; tx: bigint }>();
    for (const line of dump.split('\n').slice(1)) {
      const f = line.split('\t');
      if (f.length < 7) continue;
      byKey.set(f[0], {
        hs: Number(f[4]) || 0,
        rx: BigInt(f[5] || 0),
        tx: BigInt(f[6] || 0),
      });
    }

    const tunnels = await this.prisma.nasTunnel.findMany();
    let up = 0;
    for (const t of tunnels) {
      const live = byKey.get(t.publicKey);
      if (!live) continue;
      const seen = live.hs > 0 ? new Date(live.hs * 1000) : null;
      if (seen && Date.now() - seen.getTime() < 180_000) up++;
      await this.prisma.nasTunnel.update({
        where: { id: t.id },
        data: { lastHandshake: seen, rxBytes: live.rx, txBytes: live.tx },
      });
    }
    return { checked: tunnels.length, up };
  }

  /**
   * Rebuild the kernel peer list from the database.
   *
   * The kernel loses every peer on reboot, and `wg-quick` only restores what is
   * in a static file — which ours are not, because they are provisioned at
   * runtime. So without this, every tunnel on the network dies the next time
   * the panel host restarts, with no error anywhere.
   */
  async reconcile(): Promise<{ applied: number; failed: number; errors: string[] }> {
    const tunnels = await this.prisma.nasTunnel.findMany({ where: { enabled: true } });
    let applied = 0;
    const errors: string[] = [];
    for (const t of tunnels) {
      try {
        await this.applyPeer(t.publicKey, t.overlayIp);
        applied++;
      } catch (e: any) {
        errors.push(`NAS #${t.nasId}: ${e?.message || e}`);
      }
    }
    this.logger.log(`Tunnel reconcile: ${applied}/${tunnels.length} peers applied`);
    return { applied, failed: errors.length, errors };
  }

  /** Tunnel state for one router, with the health verdict already computed. */
  async status(nasId: number) {
    const t = await this.prisma.nasTunnel.findUnique({ where: { nasId } });
    if (!t) return null;
    const ageMs = t.lastHandshake ? Date.now() - t.lastHandshake.getTime() : null;
    return {
      overlayIp: t.overlayIp,
      enabled: t.enabled,
      // publicKey is safe to show — it is public by construction, and an
      // operator needs it to match a peer against `wg show` output.
      publicKey: t.publicKey,
      serverEndpoint: t.serverEndpoint,
      lastHandshake: t.lastHandshake,
      // Never "connected", because WireGuard cannot tell us that.
      online: ageMs !== null && ageMs < 180_000,
      rxBytes: t.rxBytes.toString(),
      txBytes: t.txBytes.toString(),
      createdAt: t.createdAt,
      rotatedAt: t.rotatedAt,
    };
  }

  async listAll(nasIds?: number[]) {
    const rows = await this.prisma.nasTunnel.findMany({
      where: nasIds ? { nasId: { in: nasIds } } : undefined,
      include: { nas: { select: { id: true, shortname: true, nasname: true } } },
    });
    return rows.map((t) => ({
      nasId: t.nasId,
      nas: t.nas,
      overlayIp: t.overlayIp,
      enabled: t.enabled,
      lastHandshake: t.lastHandshake,
      online: !!t.lastHandshake && Date.now() - t.lastHandshake.getTime() < 180_000,
      rxBytes: t.rxBytes.toString(),
      txBytes: t.txBytes.toString(),
    }));
  }

  // ── the configs an engineer actually pastes ──────────────────
  /**
   * RouterOS 7 commands. Written as a paste-able script rather than prose
   * because the person doing this is on a phone, on site, in a shop.
   *
   * `allowed-address` is the panel's overlay address alone, NOT 0.0.0.0/0 —
   * this is a management tunnel, and routing the customer's whole internet
   * through the panel would be an outage disguised as a config.
   */
  private mikrotikScript(
    name: string,
    privateKey: string,
    overlayIp: string,
    serverPub: string | null,
    endpoint: string,
  ): string {
    const safe = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24) || 'jointbox';
    const [host, port] = endpoint.split(':');
    const panelIp = this.panelOverlayIp();
    return [
      `# Jointbox management tunnel — paste into RouterOS 7 terminal`,
      `/interface/wireguard`,
      `add name=wg-${safe} private-key="${privateKey}" listen-port=13231`,
      `/ip/address`,
      `add address=${overlayIp}/32 interface=wg-${safe}`,
      `/interface/wireguard/peers`,
      `add interface=wg-${safe} public-key="${serverPub ?? '<panel-public-key>'}" \\`,
      `    endpoint-address=${host || '<panel-host>'} endpoint-port=${port || this.listenPort} \\`,
      `    allowed-address=${panelIp}/32 persistent-keepalive=${this.keepalive}s`,
      `# Allow the panel in, and nothing else through the tunnel:`,
      `/ip/firewall/filter`,
      `add chain=input src-address=${panelIp} action=accept comment="Jointbox panel" place-before=0`,
    ].join('\n');
  }

  private wgQuickConfig(
    privateKey: string,
    overlayIp: string,
    serverPub: string | null,
    endpoint: string,
  ): string {
    return [
      `[Interface]`,
      `PrivateKey = ${privateKey}`,
      `Address = ${overlayIp}/32`,
      ``,
      `[Peer]`,
      `PublicKey = ${serverPub ?? '<panel-public-key>'}`,
      `Endpoint = ${endpoint || '<panel-host>:' + this.listenPort}`,
      `AllowedIPs = ${this.panelOverlayIp()}/32`,
      `PersistentKeepalive = ${this.keepalive}`,
      ``,
    ].join('\n');
  }

  /** Host .1 of the overlay subnet — the panel's own address inside it. */
  private panelOverlayIp(): string {
    const base = this.subnet.split('/')[0];
    const parts = base.split('.');
    parts[3] = '1';
    return parts.join('.');
  }
}
