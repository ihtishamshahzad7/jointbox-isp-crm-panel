/**
 * "Add router via VPN" over L2TP/IPsec — UNIT test with mocks (no database,
 * no xl2tpd). A remote router dials INTO Uplinko; it is registered with its
 * TUNNEL address as its NAS IP and gets one paste-able MikroTik script.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NasService } from './nas.service';
import { L2tpHubService } from './l2tp-hub.service';

const secrets: any = { encryptValue: (v: string) => `enc:${v}`, decryptValue: (v: string) => v.replace(/^enc:/, '') };

function makeHub(opts: { nasIps?: string[]; hubRows?: any[]; running?: boolean; endpoint?: string; createErr?: any } = {}) {
  const rows: any[] = [...(opts.hubRows ?? [])];
  let settings: any = null;
  const prisma: any = {
    nas: { findMany: jest.fn(async () => (opts.nasIps ?? []).map((nasIp) => ({ nasIp }))) },
    nasL2tpHub: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.nasId === where.nasId) ?? null),
      create: jest.fn(async ({ data }: any) => { if (opts.createErr) throw opts.createErr; rows.push({ id: rows.length + 1, ...data }); return data; }),
      delete: jest.fn(async ({ where }: any) => { rows.splice(rows.findIndex((r) => r.nasId === where.nasId), 1); }),
      count: jest.fn(async () => rows.length),
    },
    l2tpHubSettings: {
      findUnique: jest.fn(async () => settings),
      upsert: jest.fn(async ({ create, update }: any) => (settings = { ...(settings ?? create), ...update })),
    },
  };
  const vpn: any = { getConfig: () => ({ endpointHost: opts.endpoint ?? '45.67.89.10' }) };
  const hub = new L2tpHubService(prisma, secrets, vpn);
  const files: Record<string, string> = { '/etc/ppp/chap-secrets': '# existing line\nalice * pw *\n' };
  hub.readFile = async (f: string) => files[f] ?? null;
  hub.writeFileAtomic = async (f: string, d: string) => { files[f] = d; };
  // running:false = xl2tpd/strongSwan not installed on the server
  hub.run = jest.fn(async (cmd: string) => ({ code: cmd === 'which' && opts.running === false ? 1 : 0, stdout: '[]', stderr: '' }));
  return { hub, prisma, files, rows };
}

function makeNas(hub: any, allowed = true) {
  const prisma: any = { nas: { delete: jest.fn().mockResolvedValue({}) } };
  const vault: any = { apply: jest.fn().mockResolvedValue({ ok: true }) };
  const entitlements: any = {
    assertEnabled: jest.fn(async () => { if (!allowed) throw new ForbiddenException('The router-vpn product is not enabled for this company.'); }),
    companyState: jest.fn(async () => ({ enabled: allowed })),
  };
  const svc = new NasService(prisma, {} as any, {} as any, { actorId: () => 5 } as any, {} as any, {} as any, vault, undefined, undefined, hub, entitlements);
  const create = jest
    .spyOn(svc, 'create')
    .mockImplementation(async (d: any) => ({ id: 9, shortname: d.nasName, nasIp: d.nasIp, apiPort: 8728, incomingPort: 3799 }) as any);
  return { svc, prisma, create, vault };
}

describe('Add router via VPN (L2TP/IPsec into Uplinko)', () => {
  it('registers the router on its tunnel address and returns one L2TP setup script', async () => {
    const { hub, files } = makeHub();
    const { svc, create } = makeNas(hub);
    const r: any = await svc.createViaVpn({ nasName: 'Eht-M' }, { sub: 5 });

    expect(create.mock.calls[0][0]).toMatchObject({ nasIp: '10.68.0.2', nasName: 'Eht-M', apiUsername: 'uplinko' });
    const secret = (create.mock.calls[0][0] as any).secret;
    expect(r.tunnel).toMatchObject({ type: 'l2tp', overlayIp: '10.68.0.2', serverIp: '10.68.0.1' });
    expect(r.script).toContain('/interface l2tp-client add name=l2tp-uplinko connect-to=45.67.89.10 user="uplinko-nas9"');
    expect(r.script).toContain('use-ipsec=yes ipsec-secret="');
    expect(r.script).toContain(`/radius add address=10.68.0.1 secret="${secret}"`);
    expect(r.script).toContain('src-address=10.68.0.2');
    expect(r.script).not.toMatch(/wireguard|<panel/);
    // SNMP prepared (read-only, only from Uplinko) so it can be turned on later in Edit
    const community = (create.mock.calls[0][0] as any).snmpCommunity;
    expect(community).toMatch(/^uplinko-/);
    expect(r.script).toContain(`/snmp community add name="${community}" addresses=10.68.0.1/32 read-access=yes write-access=no`);
    // the router's login with its fixed address, other lines kept
    expect(files['/etc/ppp/chap-secrets']).toContain('alice * pw *');
    expect(files['/etc/ppp/chap-secrets']).toMatch(/"uplinko-nas9" \* "[A-Za-z0-9_-]+" 10\.68\.0\.2/);
  });

  it('only for companies the platform allowed Router VPN (Plans & Pricing)', async () => {
    const n = makeNas(makeHub().hub, false);
    await expect(n.svc.createViaVpn({ nasName: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(n.create).not.toHaveBeenCalled();
    expect(await n.svc.vpnAvailability({})).toMatchObject({ enabled: false });
  });

  it('refuses — and gives no script — while the server software is missing', async () => {
    const n = makeNas(makeHub({ running: false }).hub);
    await expect(n.svc.createViaVpn({ nasName: 'x' })).rejects.toThrow(/update-jointbox\.sh/);
    expect(n.create).not.toHaveBeenCalled();
  });

  it('the router dials what the company typed, else the address it opened Uplinko on', async () => {
    const { hub } = makeHub({ endpoint: '' });
    const n = makeNas(hub);
    await expect(n.svc.createViaVpn({ nasName: 'x' })).rejects.toThrow(/public IP or hostname/);
    const r: any = await n.svc.createViaVpn({ nasName: 'x' }, {}, '192.168.1.167');
    expect(r.script).toContain('connect-to=192.168.1.167 ');
    const { hub: h2 } = makeHub({ endpoint: '' });
    const r2: any = await makeNas(h2).svc.createViaVpn({ nasName: 'y', endpointHost: 'vpn.isp.pk' }, {}, '192.168.1.167');
    expect(r2.script).toContain('connect-to=vpn.isp.pk ');
  });

  it('the panel configures the L2TP/IPsec server itself (no platform setup step)', async () => {
    const { hub, files } = makeHub();
    await hub.ensureServer();
    const psk = (await hub.psk()) as string;
    expect(files[hub.swanConfPath]).toContain(`secret = 0s${Buffer.from(psk).toString('base64')}`);
    expect(files[hub.xl2tpdConfPath]).toContain('local ip = 10.68.0.1');
    expect(files[hub.pppOptionsPath]).toContain('require-mschap-v2');
    expect(hub.run).toHaveBeenCalledWith('swanctl', ['--load-all'], 15000);
    (hub.run as jest.Mock).mockClear();
    expect(await hub.ensureServer()).toEqual({ changed: false }); // idempotent: no reload
    expect(hub.run).not.toHaveBeenCalled();
  });

  it('removes the router again when its login cannot be created', async () => {
    const e: any = new Error('dup'); e.code = 'P2002';
    const { hub } = makeHub({ createErr: e });
    const { svc, prisma, vault } = makeNas(hub);
    await expect(svc.createViaVpn({ nasName: 'x' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.nas.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(vault.apply).toHaveBeenCalled();
  });

  it('refuses unsafe API credentials and a missing name', async () => {
    const { svc } = makeNas(makeHub().hub);
    await expect(svc.createViaVpn({ nasName: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createViaVpn({ nasName: 'a', apiUsername: 'bad name' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createViaVpn({ nasName: 'a', apiPassword: 'pa"ss' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never hands out an address another router already uses', async () => {
    const { hub } = makeHub({ nasIps: ['10.68.0.2'], hubRows: [{ nasId: 1, tunnelIp: '10.68.0.3', username: 'u', passwordEnc: 'enc:p' }] });
    expect(await hub.nextTunnelIp()).toBe('10.68.0.4');
  });

  it('deleting the router removes its login from chap-secrets', async () => {
    const { hub, files } = makeHub();
    await hub.provision(9, '10.68.0.2');
    await hub.revoke(9);
    expect(files['/etc/ppp/chap-secrets']).not.toContain('uplinko-nas9');
    expect(files['/etc/ppp/chap-secrets']).toContain('alice * pw *');
  });

  it('connected = a ppp link whose peer is the router tunnel address', async () => {
    const { hub } = makeHub();
    await hub.provision(9, '10.68.0.2');
    hub.run = jest.fn(async () => ({ code: 0, stderr: '', stdout: JSON.stringify([{ ifname: 'ppp0', addr_info: [{ local: '10.68.0.1', address: '10.68.0.2' }] }]) }));
    expect(await hub.status(9)).toMatchObject({ online: true, tunnelIp: '10.68.0.2' });
  });

  it('escapes values that would break the RouterOS command line', () => {
    const { hub } = makeHub();
    const s = hub.routerScript({ name: 'r', username: 'u', password: 'p', tunnelIp: '10.68.0.2', serverIp: '10.68.0.1', endpoint: 'h', psk: 'k',
      radiusSecret: 'a"b$c?d', apiUsername: 'u', apiPassword: 'p', apiPort: 8728, coaPort: 3799 });
    expect(s).toContain('secret="a\\"b\\$c\\?d"');
  });
});
