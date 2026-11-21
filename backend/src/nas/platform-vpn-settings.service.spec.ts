import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PlatformVpnSettingsService } from './platform-vpn-settings.service';
import { isPlatformRoute, routeTemplate } from '../common/platform-boundary.interceptor';

const SA = { role: 'SUPER_ADMIN', sub: 1 };
function make(row: any = null, inv: any = { addresses: ['45.67.89.10', '192.168.1.5'], networks: [], gateways: [] }) {
  let stored = row;
  const prisma: any = {
    platformVpnSettings: {
      findUnique: jest.fn(async () => stored),
      upsert: jest.fn(async ({ create }) => (stored = { ...create })),
    },
  };
  const dialer: any = {
    tooling: jest.fn(async () => ({ ok: true, detail: 'ok' })),
    inventory: jest.fn(async () => inv),
  };
  return { svc: new PlatformVpnSettingsService(prisma, dialer), prisma, get: () => stored };
}

describe('PlatformVpnSettingsService (web settings for the NAS management VPN)', () => {
  it('only the platform account can read or change it', async () => {
    const { svc } = make();
    await expect(svc.get({ role: 'ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update({ role: 'ADMIN' }, { mgmtEnabled: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('falls back to the environment until saved in the panel', async () => {
    const { svc } = make();
    const env = await svc.effectiveEnv({ L2TP_MGMT_VPN_ENABLED: 'false' } as any);
    expect(env.L2TP_MGMT_VPN_ENABLED).toBe('false');
    expect((await svc.get(SA)).source).toBe('environment');
  });

  it('the saved row overrides the environment', async () => {
    const { svc } = make({ id: 1, mgmtEnabled: true, publicIp: '45.67.89.10', mgmtPool: null, protectedCidrs: null, allowPrivateEndpoints: false });
    const env = await svc.effectiveEnv({ L2TP_MGMT_VPN_ENABLED: 'false', UPLINKO_PUBLIC_IP: '1.1.1.1' } as any);
    expect(env.L2TP_MGMT_VPN_ENABLED).toBe('true');
    expect(env.UPLINKO_PUBLIC_IP).toBe('45.67.89.10');
  });

  it('a missing table (not migrated) means environment only', async () => {
    const { svc, prisma } = make();
    prisma.platformVpnSettings.findUnique.mockRejectedValue(new Error('relation does not exist'));
    const base = { L2TP_MGMT_VPN_ENABLED: 'true' } as any;
    expect(await svc.effectiveEnv(base)).toBe(base);
  });

  it('refuses to enable without a public IP', async () => {
    const { svc } = make();
    await expect(svc.update(SA, { mgmtEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a bad or private public IP and a bad pool', async () => {
    const { svc } = make();
    await expect(svc.update(SA, { publicIp: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(SA, { publicIp: '192.168.1.5' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(SA, { mgmtPool: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a pool that overlaps a server network', async () => {
    const { svc } = make(null, { addresses: ['10.255.0.1'], networks: [], gateways: [] });
    await expect(svc.update(SA, { mgmtEnabled: true, publicIp: '45.67.89.10' })).rejects.toThrow(/overlaps/);
  });

  it('refuses to enable when the server network cannot be read', async () => {
    const { svc } = make(null, null);
    await expect(svc.update(SA, { mgmtEnabled: true, publicIp: '45.67.89.10' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves valid settings and turns the VPN on', async () => {
    const { svc, get } = make();
    const r = await svc.update(SA, { mgmtEnabled: true, publicIp: '45.67.89.10' });
    expect(get()).toMatchObject({ id: 1, mgmtEnabled: true, publicIp: '45.67.89.10', updatedById: 1 });
    expect(r).toMatchObject({ mgmtEnabled: true, publicIp: '45.67.89.10', source: 'panel', hardwareVerified: false });
    expect(r.server.addresses).toContain('45.67.89.10');
  });

  it('the route passes the platform-account boundary', () => {
    expect(isPlatformRoute('GET', routeTemplate('platform', 'vpn-settings'))).toBe(true);
    expect(isPlatformRoute('PUT', 'platform/vpn-settings')).toBe(true);
  });
});

describe('Router VPN settings (L2TP/IPsec server remote routers dial into)', () => {
  function mk(routers: number) {
    let endpoint = '';
    let subnet = '10.68.0.0/24';
    const prisma: any = { nasL2tpHub: { count: jest.fn(async () => routers) } };
    const vpn: any = { getConfig: () => ({ endpointHost: endpoint }), setConfig: jest.fn((b: any) => { endpoint = b.endpointHost; }) };
    const hub: any = {
      readiness: async () => ({ ok: !!endpoint, running: true, reasons: endpoint ? [] : ['set address'] }),
      subnet: async () => subnet,
      serverIp: async () => '10.68.0.1',
      installScript: async () => 'script',
      endpointHost: () => endpoint,
      setSubnet: jest.fn(async (v: string) => {
        if (routers > 0 && v !== subnet) throw new BadRequestException('locked while routers use it');
        subnet = v;
      }),
    };
    return { svc: new PlatformVpnSettingsService(prisma, {} as any, vpn, hub) };
  }
  it('platform account only', async () => {
    await expect(mk(0).svc.getRouterVpn({ role: 'ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('saves the dial-in address from the web panel', async () => {
    const r = await mk(0).svc.updateRouterVpn(SA, { endpointHost: 'vpn.example.net' });
    expect(r).toMatchObject({ type: 'l2tp', endpointHost: 'vpn.example.net', ready: true, serverIp: '10.68.0.1' });
  });
  it('locks the tunnel network while routers use it', async () => {
    await expect(mk(2).svc.updateRouterVpn(SA, { subnet: '10.77.0.0/24' })).rejects.toThrow(/locked/);
  });
  it('the route passes the platform-account boundary', () => {
    expect(isPlatformRoute('PUT', routeTemplate('platform', 'router-vpn'))).toBe(true);
  });
});
