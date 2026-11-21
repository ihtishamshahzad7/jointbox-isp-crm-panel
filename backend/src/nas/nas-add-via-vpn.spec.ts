/**
 * "Add router via VPN" — UNIT test with mocks (no database, no wg binary).
 * A router on a private/remote network is registered with its TUNNEL address
 * as its NAS IP, gets WireGuard keys, and one paste-able setup script.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { NasService } from './nas.service';
import { TunnelService } from './tunnel.service';

const SERVER_PUB = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=';

function makeTunnels(prismaExtra: any = {}) {
  const prisma: any = {
    nas: {
      findUnique: jest.fn().mockResolvedValue({ id: 9, shortname: 'remote-site', nasname: '10.66.0.2' }),
      findMany: jest.fn().mockResolvedValue([]),
      ...prismaExtra.nas,
    },
    nasTunnel: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      ...prismaExtra.nasTunnel,
    },
  };
  const vpn: any = { getConfig: () => ({ endpointHost: 'vpn.example.net', wireguard: { port: 51820, subnet: '10.66.0.0/24' } }) };
  const t = new TunnelService(prisma, vpn);
  (t as any).wg = jest.fn(async (args: string[]) => (args.includes('public-key') ? SERVER_PUB + '\n' : ''));
  return { t, prisma };
}

function makeNas(tunnels: any) {
  const prisma: any = { nas: { delete: jest.fn().mockResolvedValue({}) } };
  const scope: any = { actorId: () => 5 };
  const vault: any = { apply: jest.fn().mockResolvedValue({ ok: true }) };
  const svc = new NasService(prisma, {} as any, {} as any, scope, {} as any, {} as any, vault, undefined, tunnels);
  const create = jest
    .spyOn(svc, 'create')
    .mockImplementation(async (d: any) => ({ id: 9, shortname: d.nasName, nasIp: d.nasIp, apiPort: 8728, incomingPort: 3799 }) as any);
  return { svc, prisma, create, vault };
}

describe('Add router via VPN', () => {
  it('registers the router on its tunnel address and returns one setup script', async () => {
    const { t } = makeTunnels();
    const { svc, create } = makeNas(t);
    const r: any = await svc.createViaVpn({ nasName: 'remote-site' }, { sub: 5 });

    expect(create.mock.calls[0][0]).toMatchObject({ nasIp: '10.66.0.2', nasName: 'remote-site', apiUsername: 'uplinko' });
    const secret = (create.mock.calls[0][0] as any).secret;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/); // generated when left blank
    expect(r.connection).toBe('vpn');
    expect(r.tunnel.overlayIp).toBe('10.66.0.2');
    expect(r.tunnel.serverEndpoint).toBe('vpn.example.net:51820');
    // VPN, RADIUS over the tunnel, CoA and the API user — all in one script
    expect(r.script).toContain('/interface wireguard add name=wg-uplinko');
    expect(r.script).toContain(`public-key="${SERVER_PUB}" endpoint-address=vpn.example.net endpoint-port=51820`);
    expect(r.script).toContain(`/radius add address=10.66.0.1 secret="${secret}"`);
    expect(r.script).toContain('src-address=10.66.0.2');
    expect(r.script).toContain('/radius incoming set accept=yes port=3799');
    expect(r.script).toContain('/user add name="uplinko"');
    expect(r.script).toContain('address=10.66.0.1/32');
  });

  it('removes the router again when the tunnel cannot be issued', async () => {
    const { t } = makeTunnels();
    jest.spyOn(t, 'provision').mockRejectedValue(new ConflictException('taken'));
    const { svc, prisma, vault } = makeNas(t);
    await expect(svc.createViaVpn({ nasName: 'x' }, { sub: 5 })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.nas.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(vault.apply).toHaveBeenCalled();
  });

  it('refuses unsafe API credentials and a missing name', async () => {
    const { t } = makeTunnels();
    const { svc } = makeNas(t);
    await expect(svc.createViaVpn({ nasName: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createViaVpn({ nasName: 'a', apiUsername: 'bad name' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createViaVpn({ nasName: 'a', apiPassword: 'pa"ss' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never hands out an address another router already uses as its NAS IP', async () => {
    const { t } = makeTunnels({ nas: { findMany: jest.fn().mockResolvedValue([{ nasIp: '10.66.0.2' }]) } });
    expect(await t.nextOverlayIp()).toBe('10.66.0.3');
  });

  it('the tunnel gets exactly the reserved address, or fails — no silent fallback', async () => {
    const e: any = new Error('dup'); e.code = 'P2002'; e.meta = { target: ['overlayIp'] };
    const { t } = makeTunnels({ nasTunnel: { create: jest.fn().mockRejectedValue(e) } });
    await expect(t.provision(9, { overlayIp: '10.66.0.2' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('web settings decide where routers dial (no .env needed)', async () => {
    const { t } = makeTunnels();
    const cfg = await t.provision(9, { overlayIp: '10.66.0.2' });
    expect(cfg.serverEndpoint).toBe('vpn.example.net:51820');
  });

  it('escapes values that would break the RouterOS command line', () => {
    const { t } = makeTunnels();
    const s = t.routerSetupScript({
      name: 'r', privateKey: 'k', overlayIp: '10.66.0.2', serverPub: SERVER_PUB, endpoint: 'h:1',
      radiusSecret: 'a"b$c?d', apiUsername: 'u', apiPassword: 'p', apiPort: 8728, coaPort: 3799,
    });
    expect(s).toContain('secret="a\\"b\\$c\\?d"');
  });
});
