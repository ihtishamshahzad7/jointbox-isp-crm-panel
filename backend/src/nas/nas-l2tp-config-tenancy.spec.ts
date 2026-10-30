import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NasL2tpConfigService } from './nas-l2tp-config.service';

describe('NasL2tpConfigService tenancy', () => {
  const ownerA = { sub: 10, role: 'ADMIN' };
  const ownerB = { sub: 20, role: 'ADMIN' };

  function makeService(state = 'draft') {
    const configRow: any = {
      nasId: 100,
      state,
      revision: 1,
      configurationName: 'uplinko-branch-01',
      publicHost: 'vpn.example.com',
      routerManagementIp: '10.0.0.42',
      l2tpEnabled: true,
      ipsecEnabled: true,
      ipsecPskEnc: 'enc:psk',
      pppProfile: 'uplinko-vpn',
      clientPool: 'uplinko-pool',
      dnsServers: [],
      mtu: 1450,
      mru: 1450,
      maxSessions: 50,
      idleTimeout: 600,
      sessionTimeout: 1800,
      radiusServer: 'radius.example.com',
      radiusAuthPort: 1812,
      radiusAcctPort: 1813,
      nasIdentifier: 'nas-100',
      radiusSourceIp: '203.0.113.10',
      radiusSharedSecretEnc: 'enc:secret',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lastAppliedAt: null,
      lastVerifiedAt: null,
      lastError: null,
    };
    const prisma: any = {
      activityLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      nas: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 100
            ? {
                id: 100,
                ownerId: 10,
                nasname: '10.0.0.42',
                nasIp: '10.0.0.42',
                nasIdentifier: 'nas-100',
                secret: null,
                radiusSecretEnc: 'enc:central-radius-secret',
              }
            : null,
        ),
      },
      nasL2tpConfig: {
        findUnique: jest.fn(async () => configRow),
        upsert: jest.fn(async (args: any) => ({
          ...args.create,
          ...args.update,
        })),
        update: jest.fn(async (args: any) =>
          Object.assign(configRow, args.data),
        ),
      },
    };

    const scope: any = {
      assertNas: jest.fn(async (actor: any, nasId: number) => {
        if (![10, 30].includes(actor?.sub) || nasId !== 100) {
          throw new NotFoundException(`NAS ${nasId} not found`);
        }
      }),
      isPlatformOwner: jest.fn((actor: any) => actor?.role === 'SUPER_ADMIN'),
      actorId: jest.fn((actor: any) => Number(actor?.sub)),
    };

    const secrets: any = {
      encryptValue: jest.fn((value: string) => `enc:${value}`),
      decryptValue: jest.fn((value: string) => value.replace(/^enc:/, '')),
    };

    const vpn: any = {
      validateL2tpConfig: jest.fn(() => ({
        valid: true,
        warnings: [],
        errors: [],
        masked: { publicHost: 'vpn.example.com' },
        preview: '# ok',
      })),
    };

    return {
      service: new NasL2tpConfigService(prisma, scope, secrets, vpn),
      prisma,
      scope,
      vpn,
      configRow,
    };
  }

  it.each([
    ['getForNas', (service: any, actor: any) => service.getForNas(100, actor)],
    [
      'saveDraft',
      (service: any, actor: any) =>
        service.saveDraft(100, { publicHost: 'vpn.example.com' }, actor),
    ],
    [
      'validateForNas',
      (service: any, actor: any) =>
        service.validateForNas(100, { publicHost: 'vpn.example.com' }, actor),
    ],
    [
      'previewChanges',
      (service: any, actor: any) =>
        service.previewChanges(100, { publicHost: 'vpn.example.com' }, actor),
    ],
    [
      'approveForNas',
      (service: any, actor: any) => service.approveForNas(100, actor),
    ],
    [
      'applyApproved',
      (service: any, actor: any) => service.applyApproved(100, actor),
    ],
    ['rollback', (service: any, actor: any) => service.rollback(100, actor)],
  ])(
    "%s rejects another dealer's NAS and never touches the config row",
    async (_name, call) => {
      const { service, prisma, scope } = makeService();
      await expect(call(service, ownerB)).rejects.toThrow(NotFoundException);
      expect(scope.assertNas).toHaveBeenCalledWith(ownerB, 100);
      expect(prisma.nasL2tpConfig.findUnique).not.toHaveBeenCalled();
    },
  );

  it('allows the owning dealer to read and modify the same NAS', async () => {
    const { service, prisma, scope } = makeService();
    await expect(service.getForNas(100, ownerA)).resolves.toMatchObject({
      nasId: 100,
      publicHost: 'vpn.example.com',
    });
    await expect(
      service.saveDraft(100, { publicHost: 'vpn2.example.com' }, ownerA),
    ).resolves.toMatchObject({ nasId: 100 });
    expect(scope.assertNas).toHaveBeenCalledWith(ownerA, 100);
    expect(prisma.nasL2tpConfig.upsert).toHaveBeenCalled();
  });

  it('returns only public central FreeRADIUS settings for the NAS owner', async () => {
    const { service, scope } = makeService();
    await expect(service.getRadiusForNas(100, ownerA)).resolves.toEqual({
      provider: 'FreeRADIUS',
      server: process.env.RADIUS_SERVER_IP || '127.0.0.1',
      authPort: Number(process.env.RADIUS_AUTH_PORT) || 1812,
      acctPort: Number(process.env.RADIUS_ACCT_PORT) || 1813,
      nasIdentifier: 'nas-100',
      sharedSecretConfigured: true,
      subscriberStore: 'central',
    });
    expect(scope.assertNas).toHaveBeenCalledWith(ownerA, 100);
  });

  it('refuses VPN configuration access to a dealer who can only use a shared NAS', async () => {
    const { service, prisma, vpn } = makeService();
    const sharedDealer = { sub: 30, role: 'RESELLER' };

    await expect(service.getForNas(100, sharedDealer)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.saveDraft(100, { publicHost: 'vpn.example.com' }, sharedDealer),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.nasL2tpConfig.findUnique).not.toHaveBeenCalled();
    expect(vpn.validateL2tpConfig).not.toHaveBeenCalled();
  });

  it('uses the central FreeRADIUS endpoint and existing NAS secret without storing a VPN-specific copy', async () => {
    const { service, prisma, vpn } = makeService();
    await service.validateForNas(
      100,
      {
        radiusServer: 'attacker.example',
        radiusAuthPort: 9,
        radiusSharedSecret: 'client-supplied-secret',
      },
      ownerA,
    );
    expect(vpn.validateL2tpConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        radiusServer: process.env.RADIUS_SERVER_IP || '127.0.0.1',
        radiusAuthPort: Number(process.env.RADIUS_AUTH_PORT) || 1812,
        radiusAcctPort: Number(process.env.RADIUS_ACCT_PORT) || 1813,
        nasIdentifier: 'nas-100',
        radiusSharedSecret: 'central-radius-secret',
      }),
    );

    await service.saveDraft(
      100,
      { publicHost: 'vpn.example.com', ipsecPsk: 'per-nas-psk' },
      ownerA,
    );
    const create = prisma.nasL2tpConfig.upsert.mock.calls[0][0].create;
    expect(create.radiusServer).toBe(process.env.RADIUS_SERVER_IP || '127.0.0.1');
    expect(create).not.toHaveProperty('radiusSharedSecretEnc');
    expect(create).not.toHaveProperty('radiusSharedSecret');
  });

  it('forces draft state regardless of a client-supplied state and only persists schema fields', async () => {
    const { service, prisma } = makeService();
    await service.saveDraft(
      100,
      {
        publicHost: 'vpn.example.com',
        state: 'approved',
        nasName: 'forged',
      } as any,
      ownerA,
    );
    const args = prisma.nasL2tpConfig.upsert.mock.calls[0][0];
    expect(args.create.state).toBe('draft');
    expect(args.create).not.toHaveProperty('nasName');
  });

  it('does not stamp validation as device verification', async () => {
    const { service, prisma } = makeService();
    await service.validateForNas(100, undefined, ownerA);
    const update = prisma.nasL2tpConfig.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('lastVerifiedAt');
  });

  it('requires approval before simulated apply and does not update live state', async () => {
    const { service, prisma } = makeService('draft');
    await expect(service.applyApproved(100, ownerA)).rejects.toThrow(
      /approved/,
    );
    expect(prisma.nasL2tpConfig.update).not.toHaveBeenCalled();
  });

  it('reports an approved apply as not configured without claiming application or verification', async () => {
    const { service, prisma, configRow } = makeService('approved');
    const result = await service.applyApproved(100, ownerA);
    expect(result).toMatchObject({
      applied: false,
      simulated: true,
      deviceVerified: false,
      applyStatus: 'not_configured',
      state: 'approved',
    });
    expect(result.lastAppliedAt).toBeNull();
    expect(result.lastVerifiedAt).toBeNull();
    expect(prisma.nasL2tpConfig.update).not.toHaveBeenCalled();
    expect(configRow.state).toBe('approved');
  });

  it('does not claim or record a rollback without a live device', async () => {
    const { service, prisma, configRow } = makeService('approved');
    const result = await service.rollback(100, ownerA);
    expect(result).toMatchObject({
      rolledBack: false,
      rollbackStatus: 'not_configured',
      state: 'approved',
    });
    expect(prisma.nasL2tpConfig.update).not.toHaveBeenCalled();
    expect(configRow.state).toBe('approved');
  });
});
