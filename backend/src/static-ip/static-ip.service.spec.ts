import { BadRequestException, ConflictException } from '@nestjs/common';
import { StaticIpService } from './static-ip.service';

/**
 * STATIC IP LIFE-CYCLE (spec tests 3–5: assign / change / remove / online-assign).
 *
 * The contract pinned here:
 *   • An address that cannot be routed on the subscriber's NAS is rejected
 *     BEFORE any row is written (no register entry, no radreply, no disconnect).
 *   • assignment writes DB + ServiceSettings + RADIUS, THEN tears down the
 *     pool session — in that order. If RADIUS did not write, the customer is
 *     NEVER kicked (they would have no way back in).
 *   • Success is only claimed after the router itself confirms the new address
 *     (reconnect + verify). A mismatch is written to the error log and surfaced
 *     as a warning — never silently believed.
 *   • removal flips DB + RADIUS to DYNAMIC and un-pins the router secret so
 *     the released address can never be handed out again.
 */
describe('StaticIpService', () => {
  const NAS: any = {
    nasname: 'core-mikrotik',
    nasIp: '192.168.88.17',
    apiPort: 8728,
    apiUsername: 'admin',
    apiPassword: 'secret',
    ipPools: [{ network: '10.10.10.0', subnet: '24' }],
  };
  const IP = {
    id: 5, ipAddress: '192.168.88.151', status: 'AVAILABLE', subscriberId: null,
    monthlyPrice: 20, nextBillingDate: null, gateway: null, subnetMask: '255.255.255.255',
    expiresAt: null, assignedAt: null, notes: null,
  };
  const ACTOR = { id: 9, role: 'ADMIN' as const };

  function makeService(overrides: any = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      staticIp: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      staticIpAssignment: {
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      serviceSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subscriber: { findUnique: jest.fn() },
      systemLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      ...(overrides.prisma || {}),
    };
    const scope: any = {
      assertSubscriber: jest.fn().mockResolvedValue(null),
      actorId: jest.fn().mockReturnValue(9),
      isAdmin: jest.fn().mockReturnValue(true),
    };
    const subscribers: any = { syncToRadius: jest.fn().mockResolvedValue({ synced: true }) };
    const network: any = { disconnect: jest.fn() };
    const notifications: any = {};
    const mikrotik: any = {
      setSecretRemoteAddress: jest.fn().mockResolvedValue(true),
      clearSecretRemoteAddress: jest.fn().mockResolvedValue(true),
      getActiveAddress: jest.fn().mockResolvedValue(null),
    };
    const service = new StaticIpService(
      prisma, scope, subscribers, network, notifications, mikrotik,
    );
    return { prisma, scope, subscribers, network, mikrotik, service };
  }

  /** Offline subscriber — the common assign path (applies on next connect). */
  function seedOfflineAssign(prisma: any, update: any = {}) {
    prisma.staticIp.findUnique.mockResolvedValue(IP);
    prisma.subscriber.findUnique.mockResolvedValue({ id: 2, nas: NAS });
    prisma.staticIp.update.mockResolvedValue({
      ...IP, subscriberId: 2, status: 'ASSIGNED',
      subscriber: { id: 2, fullName: 'Jane', username: 'jane' },
      ...update,
    });
    prisma.network?.disconnect?.(); // no-op guard
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('TEST 3a — rejects an address the NAS cannot route, BEFORE writing anything', async () => {
    const { prisma, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue({ ...IP, ipAddress: '10.0.0.5' }); // not in pool, not NAS /24
    prisma.subscriber.findUnique.mockResolvedValue({ id: 2, nas: NAS });

    await expect(service.assign(5, { subscriberId: 2 }, ACTOR)).rejects.toThrow(/not valid for this NAS\/network/);
    expect(prisma.staticIp.update).not.toHaveBeenCalled();
    expect(prisma.serviceSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it('TEST 3b — rejects the NAS’s own address and a gateway on a different subnet', async () => {
    const { prisma, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue({ ...IP, ipAddress: '192.168.88.17' });
    prisma.subscriber.findUnique.mockResolvedValue({ id: 2, nas: NAS });
    await expect(service.assign(5, { subscriberId: 2 })).rejects.toThrow(/NAS's own address/);

    prisma.staticIp.findUnique.mockResolvedValue({ ...IP, gateway: '10.0.0.1' });
    await expect(service.assign(5, { subscriberId: 2 })).rejects.toThrow(/not on the same subnet/);
  });

  it('TEST 3 — assign: DB + ServiceSettings + RADIUS first, disconnect only AFTER the RADIUS profile wrote', async () => {
    const { prisma, subscribers, network, service } = makeService();
    seedOfflineAssign(prisma);
    network.disconnect.mockRejectedValue(new BadRequestException('no active session')); // customer offline

    const result: any = await service.assign(5, { subscriberId: 2, monthlyPrice: 25 }, ACTOR);

    // DB register + mirror settings + RADIUS profile all written:
    expect(prisma.staticIp.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriberId: 2, status: 'ASSIGNED' }),
    }));
    expect(prisma.serviceSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ ipType: 'STATIC', ipAddress: '192.168.88.151' }),
    }));
    expect(subscribers.syncToRadius).toHaveBeenCalledWith(2);
    // The disconnect happens only after the RADIUS sync succeeded:
    expect(network.disconnect).toHaveBeenCalledWith('jane');
    expect(
      subscribers.syncToRadius.mock.invocationCallOrder[0],
    ).toBeLessThan(network.disconnect.mock.invocationCallOrder[0]);
    // Router secret pinned to the static address:
    expect((service as any).mikrotik.setSecretRemoteAddress).toHaveBeenCalledWith(
      '192.168.88.17', 8728, 'admin', 'secret', 'jane', '192.168.88.151',
    );
    // Audit entry with actor / old / new / NAS / result:
    expect(prisma.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'STATIC_IP_ASSIGNED', entity: 'StaticIp' }),
    }));
    expect(prisma.systemLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: 'static-ip', message: expect.stringContaining('192.168.88.151') }),
    }));
    expect(result.ipAddress).toBe('192.168.88.151');
    expect(result.reconnected).toBe(false); // offline — applies on next connect
    expect(result.applied).toBe(null);       // honest: not verified live
  });

  it('TEST 3c — RADIUS sync FAILURE: address recorded but customer NEVER kicked', async () => {
    const { prisma, subscribers, network, service } = makeService();
    seedOfflineAssign(prisma);
    subscribers.syncToRadius.mockRejectedValue(new Error('RADIUS DB down'));

    const result: any = await service.assign(5, { subscriberId: 2 });

    expect(result.method).toBe('skipped');
    expect(result.warning).toContain('left connected');
    expect(network.disconnect).not.toHaveBeenCalled(); // no kick without a written profile
  });

  it('TEST 4 — the same address on ANOTHER subscriber is rejected before any write', async () => {
    const { prisma, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue(IP);
    prisma.subscriber.findUnique.mockResolvedValue({ id: 2, nas: NAS });
    prisma.serviceSettings.findFirst.mockResolvedValue({ subscriberId: 7 }); // held elsewhere

    await expect(service.assign(5, { subscriberId: 2 })).rejects.toThrow(ConflictException);
    expect(prisma.staticIp.update).not.toHaveBeenCalled();
  });

  it('TEST 4b — setForSubscriber refuses an address already held by someone else', async () => {
    const { prisma, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue({
      id: 9, ipAddress: '192.168.88.151', subscriberId: 7, status: 'ASSIGNED',
      subscriber: { id: 7, username: 'other' },
    });

    await expect(service.setForSubscriber(2, { ipAddress: '192.168.88.151' })).rejects.toThrow(/already on other/);
  });

  it('TEST 3d — ONLINE assign: session cut, customer redials, router confirms the NEW address (applied:true)', async () => {
    jest.useFakeTimers();
    const { prisma, network, mikrotik, service } = makeService();
    seedOfflineAssign(prisma);
    prisma.$queryRaw.mockResolvedValue([{ acctsessionid: 'S1', nasipaddress: '192.168.88.17', framedipaddress: '10.10.10.209' }]);
    network.disconnect.mockResolvedValue({ disconnected: true, method: 'radius-coa', verified: 'confirmed offline on the router' });
    mikrotik.getActiveAddress.mockResolvedValue('192.168.88.151'); // router agrees

    const p = service.assign(5, { subscriberId: 2 }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(6000); // past the redial wait
    const result: any = await p;

    expect(result.reconnected).toBe(true);
    expect(result.applied).toBe(true); // verified live — not assumed
    expect(result.releasedAddress).toBe('10.10.10.209');
    expect(mikrotik.getActiveAddress).toHaveBeenCalledWith('192.168.88.17', 8728, 'admin', 'secret', 'jane');
    expect(prisma.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'POOL_IP_RELEASED' }),
    }));
  });

  it('TEST 3e — ONLINE assign MISMATCH: customer redials on the OLD address → ERROR log + applied:false, never a silent success', async () => {
    jest.useFakeTimers();
    const { prisma, network, mikrotik, service } = makeService();
    seedOfflineAssign(prisma);
    prisma.$queryRaw.mockResolvedValue([{ acctsessionid: 'S1', nasipaddress: '192.168.88.17', framedipaddress: '10.10.10.209' }]);
    network.disconnect.mockResolvedValue({ disconnected: true, method: 'radius-coa', verified: 'confirmed offline on the router' });
    mikrotik.getActiveAddress.mockResolvedValue('10.10.10.209'); // still on the pool!

    const p = service.assign(5, { subscriberId: 2 }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(6000);
    const result: any = await p;

    expect(result.applied).toBe(false);
    expect(result.warning).toContain('instead of');
    expect(prisma.systemLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ level: 'ERROR', message: expect.stringContaining('IP MISMATCH') }),
    }));
  });

  it('TEST 5 — remove: DB → DYNAMIC, RADIUS resynced, router secret un-pinned, session cut, audited', async () => {
    const { prisma, subscribers, network, mikrotik, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue({ ...IP, subscriberId: 2, status: 'ASSIGNED', assignedAt: new Date() });
    prisma.staticIp.update.mockResolvedValue({ ...IP, subscriberId: null, status: 'AVAILABLE' });
    prisma.subscriber.findUnique.mockResolvedValue({
      id: 2, username: 'jane',
      nas: { nasname: 'core', nasIp: '192.168.88.17', apiPort: 8728, apiUsername: 'admin', apiPassword: 'secret' },
    });
    network.disconnect.mockResolvedValue({ disconnected: true, method: 'radius-coa', verified: 'confirmed offline on the router' });

    await service.release(5, 'Customer moved house', ACTOR);

    expect(prisma.staticIp.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriberId: null, status: 'AVAILABLE' }),
    }));
    expect(prisma.serviceSettings.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ipType: 'DYNAMIC' }),
    }));
    expect(subscribers.syncToRadius).toHaveBeenCalledWith(2);
    // The released IP must never be handed out again by a stale router secret:
    expect(mikrotik.clearSecretRemoteAddress).toHaveBeenCalledWith('192.168.88.17', 8728, 'admin', 'secret', 'jane');
    expect(network.disconnect).toHaveBeenCalledWith('jane');
    expect(prisma.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'STATIC_IP_REMOVED', details: expect.stringContaining('192.168.88.151') }),
    }));
  });

  it('remove of an address that is not allocated is a no-op (no RADIUS or router calls)', async () => {
    const { prisma, subscribers, mikrotik, service } = makeService();
    prisma.staticIp.findUnique.mockResolvedValue({ ...IP, subscriberId: null, status: 'AVAILABLE' });

    const r = await service.release(5);

    expect(r.subscriberId).toBeNull();
    expect(subscribers.syncToRadius).not.toHaveBeenCalled();
    expect(mikrotik.clearSecretRemoteAddress).not.toHaveBeenCalled();
  });
});
