import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { VpnService } from '../vpn/vpn.service';
import { L2tpHubService } from './l2tp-hub.service';
import { PrismaService } from '../prisma/prisma.service';
import { checkAddressing, isIpv4, loadPolicy } from './l2tp-address-policy';
import { L2tpClientDialer } from './l2tp-client-dialer.service';

/**
 * Installation-wide NAS management-VPN settings, edited in the web panel by the
 * platform owner (Settings → NAS management VPN). Stored in one database row;
 * when the row exists it overrides the environment, so nobody needs a shell to
 * turn the feature on or set the server's public IP.
 */
export interface VpnSettingsInput {
  mgmtEnabled?: boolean;
  publicIp?: string | null;
  mgmtPool?: string | null;
  protectedCidrs?: string | null;
  allowPrivateEndpoints?: boolean;
}

@Injectable()
export class PlatformVpnSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dialer: L2tpClientDialer,
    @Optional() private readonly vpn?: VpnService,
    @Optional() private readonly hub?: L2tpHubService,
  ) {}

  // ── Router VPN (L2TP/IPsec server that remote routers dial into) ───────
  async getRouterVpn(actor: any) {
    this.platformOnly(actor);
    if (!this.hub) throw new BadRequestException('Router VPN is not available on this server.');
    const [ready, subnet, serverIp, install, routers] = await Promise.all([
      this.hub.readiness(),
      this.hub.subnet(),
      this.hub.serverIp(),
      this.hub.installScript(),
      (this.prisma as any).nasL2tpHub.count().catch(() => 0),
    ]);
    return {
      type: 'l2tp',
      endpointHost: this.hub.endpointHost(),
      subnet,
      serverIp,
      running: ready.running,
      ready: ready.ok,
      reasons: ready.reasons,
      routers,
      install,
    };
  }

  async updateRouterVpn(actor: any, body: { endpointHost?: string; subnet?: string }) {
    this.platformOnly(actor);
    if (!this.hub || !this.vpn) throw new BadRequestException('Router VPN is not available on this server.');
    const b = body && typeof body === 'object' ? body : {};
    if (b.subnet !== undefined) await this.hub.setSubnet(String(b.subnet));
    if (b.endpointHost !== undefined) this.vpn.setConfig({ endpointHost: b.endpointHost });
    return this.getRouterVpn(actor);
  }

  private platformOnly(actor: any) {
    if (actor?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('NAS management VPN settings are managed by the platform account.');
    }
  }

  private async row() {
    return ((this.prisma as any).platformVpnSettings?.findUnique({ where: { id: 1 } }) ?? null) as Promise<any>;
  }

  /**
   * The effective configuration as environment-style keys. The database row
   * (web settings) wins over the process environment when it exists.
   */
  async effectiveEnv(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    let r: any = null;
    try {
      r = await this.row();
    } catch {
      r = null; // table not migrated yet → environment only
    }
    if (!r) return base;
    return {
      ...base,
      L2TP_MGMT_VPN_ENABLED: r.mgmtEnabled ? 'true' : 'false',
      UPLINKO_PUBLIC_IP: r.publicIp ?? '',
      L2TP_MGMT_POOL: r.mgmtPool || base.L2TP_MGMT_POOL || '',
      L2TP_PROTECTED_CIDRS: r.protectedCidrs ?? '',
      L2TP_ALLOW_PRIVATE_ENDPOINTS: r.allowPrivateEndpoints ? 'true' : 'false',
    };
  }

  /** Settings + what the server can tell about itself (tooling, addresses). */
  async get(actor: any) {
    this.platformOnly(actor);
    const env = await this.effectiveEnv();
    const [tooling, inventory] = await Promise.all([
      this.dialer.tooling().catch(() => null),
      this.dialer.inventory().catch(() => null),
    ]);
    return {
      mgmtEnabled: env.L2TP_MGMT_VPN_ENABLED === 'true',
      publicIp: env.UPLINKO_PUBLIC_IP || null,
      mgmtPool: env.L2TP_MGMT_POOL || '10.255.0.0/16',
      protectedCidrs: env.L2TP_PROTECTED_CIDRS || '',
      allowPrivateEndpoints: env.L2TP_ALLOW_PRIVATE_ENDPOINTS === 'true',
      source: (await this.row().catch(() => null)) ? 'panel' : 'environment',
      server: {
        tooling: tooling ? { ok: tooling.ok, detail: tooling.detail } : { ok: false, detail: 'Could not check the VPN client tools on this server.' },
        addresses: inventory?.addresses.filter((a) => a !== '127.0.0.1') ?? [],
      },
      hardwareVerified: false,
    };
  }

  async update(actor: any, body: VpnSettingsInput) {
    this.platformOnly(actor);
    const b = (body && typeof body === 'object' ? body : {}) as VpnSettingsInput;
    const current = await this.effectiveEnv();
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? null : null);

    const next = {
      mgmtEnabled: b.mgmtEnabled !== undefined ? b.mgmtEnabled === true : current.L2TP_MGMT_VPN_ENABLED === 'true',
      publicIp: b.publicIp !== undefined ? str(b.publicIp) || null : current.UPLINKO_PUBLIC_IP || null,
      mgmtPool: b.mgmtPool !== undefined ? str(b.mgmtPool) || null : current.L2TP_MGMT_POOL || null,
      protectedCidrs: b.protectedCidrs !== undefined ? str(b.protectedCidrs) || null : current.L2TP_PROTECTED_CIDRS || null,
      allowPrivateEndpoints: b.allowPrivateEndpoints !== undefined ? b.allowPrivateEndpoints === true : current.L2TP_ALLOW_PRIVATE_ENDPOINTS === 'true',
    };

    // Same validation the VPN itself applies — a bad value is refused here, not later.
    const policy = loadPolicy({
      L2TP_MGMT_POOL: next.mgmtPool || '',
      L2TP_PROTECTED_CIDRS: next.protectedCidrs || '',
      L2TP_ALLOW_PRIVATE_ENDPOINTS: next.allowPrivateEndpoints ? 'true' : 'false',
    } as any);
    if ('error' in policy) throw new BadRequestException(policy.error);
    if (next.publicIp) {
      if (!isIpv4(next.publicIp)) throw new BadRequestException('Public IP must be an IPv4 address.');
      const errs = checkAddressing({ endpoint: next.publicIp }, policy, { addresses: [], networks: [], gateways: [] },
        { tunnelAddresses: [], endpoints: [], nasIps: [] });
      if (errs.length) throw new BadRequestException(`Public IP: ${errs.join(' ').replace(/NAS public address/g, 'this address')}`);
    }
    if (next.mgmtEnabled && !next.publicIp) {
      throw new BadRequestException('Set this server\'s public IP before enabling the NAS management VPN.');
    }
    if (next.mgmtEnabled) {
      const inventory = await this.dialer.inventory().catch(() => null);
      if (!inventory)
        throw new BadRequestException('The server network could not be read, so the management pool cannot be checked. Not enabled.');
      // The pool must not collide with any network already on this server.
      const errs = checkAddressing({}, policy, inventory, { tunnelAddresses: [], endpoints: [], nasIps: [] });
      if (errs.length) throw new BadRequestException(errs.join(' '));
    }

    await (this.prisma as any).platformVpnSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...next, updatedById: Number(actor?.sub ?? actor?.id) || null },
      update: { ...next, updatedById: Number(actor?.sub ?? actor?.id) || null },
    });
    return this.get(actor);
  }
}
