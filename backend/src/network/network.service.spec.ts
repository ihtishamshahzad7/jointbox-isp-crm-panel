import { BadRequestException } from '@nestjs/common';
import { NetworkService } from './network.service';

/**
 * DISCONNECT SEMANTICS (spec: "Disconnect from panel MUST disconnect from
 * MikroTik", tests 1 & 6).
 *
 * The contract being pinned here:
 *   • A disconnect only succeeds when something actually cut the session —
 *     a CoA ACK is not enough on its own; the router must agree afterwards
 *     (verify, don't assume).
 *   • The radacct row is closed ONLY when the session was really terminated.
 *     Closing it after a failed disconnect is what made the old panel show
 *     "Offline" while the customer stayed online on the router.
 *   • On failure the caller gets the real error and the subscriber remains
 *     Online in every source of truth.
 */
describe('NetworkService.disconnect', () => {
  function makeService(overrides: any = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          nas: {
            nasname: 'core-mikrotik',
            nasIp: '192.168.88.17',
            apiPort: 8728,
            apiUsername: 'admin',
            apiPassword: 'secret',
          },
        }),
      },
      systemLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      ...(overrides.prisma || {}),
    };
    const coa: any = { disconnectByUsername: jest.fn() };
    const mikrotik: any = {
      disconnectPppoeUser: jest.fn(),
      isSessionActive: jest.fn(),
    };
    const service = new NetworkService(prisma, {} as any, coa, {} as any, mikrotik);
    return { prisma, coa, mikrotik, service };
  }

  /** One live radacct row: user z online with session ABC123 on the NAS. */
  function seedLiveSession(prisma: any, row: any = {}) {
    prisma.$queryRaw.mockResolvedValue([{
      acctsessionid: 'ABC123',
      nasipaddress: '192.168.88.17',
      framedipaddress: '10.10.10.209',
      ...row,
    }]);
  }

  /** Run disconnect() while advancing fake timers (it sleeps while verifying). */
  async function run(service: NetworkService, username: string) {
    const p = service.disconnect(username).catch((e) => e);
    await jest.advanceTimersByTimeAsync(10_000);
    return p;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('TEST 1 — CoA ACK + router verification → success, radacct row closed', async () => {
    const { prisma, coa, mikrotik, service } = makeService();
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: true, method: 'radius-coa', message: 'Router accepted the request' });
    mikrotik.isSessionActive.mockResolvedValue(false); // router confirms: gone

    const result = await run(service, 'z');

    expect(result).toMatchObject({ disconnected: true, method: 'radius-coa' });
    expect(result.verified).toBe('confirmed offline on the router');
    // The accounting row is closed only for the cut session.
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DISCONNECT' }) }),
    );
    expect(prisma.systemLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'disconnect' }) }),
    );
  });

  it('TEST 1b — CoA not acknowledged → MikroTik API fallback removes session → verified success', async () => {
    const { prisma, coa, mikrotik, service } = makeService();
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: false, method: 'none', message: 'timeout' });
    mikrotik.disconnectPppoeUser.mockResolvedValue({ found: true, removed: true, sessionIds: ['*1A'] });
    mikrotik.isSessionActive.mockResolvedValue(false);

    const result = await run(service, 'z');

    expect(result).toMatchObject({ disconnected: true, method: 'mikrotik-api' });
    expect(mikrotik.disconnectPppoeUser).toHaveBeenCalledWith(
      '192.168.88.17', 8728, 'admin', 'secret', 'z',
    );
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('TEST 1c — router says ALREADY offline (no session found) is a legitimate success', async () => {
    const { prisma, coa, mikrotik, service } = makeService();
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: false, method: 'none', message: 'timeout' });
    mikrotik.disconnectPppoeUser.mockResolvedValue({ found: false, removed: false, sessionIds: [] });

    const result = await run(service, 'z');

    expect(result).toMatchObject({ disconnected: true, method: 'already-offline' });
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('TEST 6 — disconnect FAILURE: session verifiably still active → throws, radacct row stays OPEN', async () => {
    const { prisma, coa, mikrotik, service } = makeService();
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: false, method: 'none', message: 'NAK — no such session' });
    // The API finds the session but the remove does not land, and the router
    // still shows the user active — this is the "panel lied" scenario.
    mikrotik.disconnectPppoeUser.mockResolvedValue({ found: true, removed: false, sessionIds: [] });
    mikrotik.isSessionActive.mockResolvedValue(true);

    const err: any = await run(service, 'z');

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('still active on the router');
    expect(err.message).toContain('Check CoA port 3799');
    // The critical assertion: the database row was NOT closed — the panel
    // keeps showing the customer online because the router still has them.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    // Both failure logs are written — never hidden.
    expect(prisma.systemLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: 'ERROR', source: 'disconnect' }),
      }),
    );
    expect(prisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DISCONNECT_FAILED' }) }),
    );
  });

  it('TEST 6b — CoA ACK is NOT trusted blindly: router still active after ACK → failure, row stays open', async () => {
    const { prisma, coa, mikrotik, service } = makeService();
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: true, method: 'radius-coa', message: 'ACK' });
    // Verification catches the lie: ACK'd but still online.
    mikrotik.isSessionActive.mockResolvedValueOnce(true);
    mikrotik.disconnectPppoeUser.mockResolvedValue({ found: true, removed: false, sessionIds: [] });
    mikrotik.isSessionActive.mockResolvedValue(true); // retry did not land either

    const err: any = await run(service, 'z');

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DISCONNECT_FAILED' }) }),
    );
  });

  it('no radacct row AND no NAS API credentials → honest error, nothing written', async () => {
    const { prisma, coa, service } = makeService({
      prisma: {
        subscriber: {
          findUnique: jest.fn().mockResolvedValue({ id: 7, nas: null }),
        },
      },
    });
    coa.disconnectByUsername.mockResolvedValue({ ok: false, method: 'none', message: 'No active session' });

    const err: any = await run(service, 'z');

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('no API credentials');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('success with a NAS that has NO API credentials reports unverified rather than lying', async () => {
    const { prisma, coa, mikrotik, service } = makeService({
      prisma: {
        subscriber: {
          findUnique: jest.fn().mockResolvedValue({ id: 7, nas: { nasIp: '192.168.88.17', apiUsername: null, apiPassword: null } }),
        },
      },
    });
    seedLiveSession(prisma);
    coa.disconnectByUsername.mockResolvedValue({ ok: true, method: 'radius-coa', message: 'ACK' });
    // No API creds → isSessionActive never called; the router cannot be asked.
    const result = await run(service, 'z');

    expect(result).toMatchObject({ disconnected: true });
    expect(result.verified).toContain('unverified');
    expect(mikrotik.isSessionActive).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled(); // CoA ACK'd — closing the row is legitimate
  });
});

// ── Live sessions (server-mode DataTable paging) ────────────────────────────
describe('NetworkService.liveSessions', () => {
  function makeNetwork(overrides: any = {}) {
    const radiusSync: any = {
      getActiveSessions: jest.fn(),
      countActiveSessions: jest.fn(),
    };
    const prisma: any = {
      subscriber: { findMany: jest.fn() },
      ...(overrides.prisma || {}),
    };
    const scope: any = {
      subscriberWhere: jest.fn().mockResolvedValue({}),
      isAdmin: jest.fn(() => true),
      ...(overrides.scope || {}),
    };
    const service = new NetworkService(prisma, radiusSync, {} as any, scope, {} as any);
    return { radiusSync, prisma, scope, service };
  }

  const radacctRow = (username: string, extra: any = {}) => ({
    username,
    nasipaddress: '10.0.0.1',
    framedipaddress: '10.1.1.1',
    callingstationid: 'AA:BB:CC:DD:EE:FF',
    acctstarttime: '2026-09-14T10:00:00Z',
    duration_seconds: 3600,
    upload_bytes: 1000,
    download_bytes: 2000,
    rate_bps: 6,
    ...extra,
  });

  it('page+limit → {items,total,page,pageSize}; SQL page built from the same WHERE (LIMIT/OFFSET + COUNT)', async () => {
    const { radiusSync, prisma, service } = makeNetwork();
    radiusSync.getActiveSessions.mockResolvedValue([radacctRow('a'), radacctRow('b')]);
    radiusSync.countActiveSessions.mockResolvedValue(137);
    prisma.subscriber.findMany.mockResolvedValue([
      { id: 1, username: 'a', fullName: 'Alice', phone: null, package: { name: '5MB' } },
      { id: 2, username: 'b', fullName: 'Bob', phone: null, package: { name: '10MB' } },
    ]);

    const res: any = await service.liveSessions('10.0.0.1', { role: 'admin' }, {
      page: 2, limit: 50, q: 'alice', sortBy: 'downloadBytes', sortOrder: 'desc',
    });

    expect(res).toEqual(expect.objectContaining({ total: 137, page: 2, pageSize: 50 }));
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({ username: 'a', fullName: 'Alice', package: '5MB' });
    // The page request carries the search + sort + offset — the browser never
    // receives more than one page's rows.
    expect(radiusSync.getActiveSessions).toHaveBeenCalledWith('10.0.0.1', {
      limit: 50, offset: 50, q: 'alice', sortBy: 'downloadBytes', sortOrder: 'desc',
    });
    expect(radiusSync.countActiveSessions).toHaveBeenCalledWith('10.0.0.1', 'alice');
  });

  it('clamps limit to 1..200 and page to ≥ 1 (offset = (page-1)*take)', async () => {
    const { radiusSync, prisma, service } = makeNetwork();
    radiusSync.getActiveSessions.mockResolvedValue([]);
    radiusSync.countActiveSessions.mockResolvedValue(0);
    prisma.subscriber.findMany.mockResolvedValue([]);

    await service.liveSessions(undefined, { role: 'admin' }, { page: 0, limit: 999 });
    expect(radiusSync.getActiveSessions).toHaveBeenCalledWith(undefined, {
      limit: 200, offset: 0, q: undefined, sortBy: undefined, sortOrder: undefined,
    });

    await service.liveSessions(undefined, { role: 'admin' }, { page: 3, limit: 25 });
    expect(radiusSync.getActiveSessions).toHaveBeenCalledWith(undefined, {
      limit: 25, offset: 50, q: undefined, sortBy: undefined, sortOrder: undefined,
    });
  });

  it('legacy call (no page/limit) still returns the plain enriched array, never a page object', async () => {
    const { radiusSync, prisma, service } = makeNetwork();
    radiusSync.getActiveSessions.mockResolvedValue([radacctRow('a')]);
    prisma.subscriber.findMany.mockResolvedValue([
      { id: 1, username: 'a', fullName: 'Alice', phone: null, package: { name: '5MB' } },
    ]);

    const res: any = await service.liveSessions();

    expect(Array.isArray(res)).toBe(true);
    expect(res).not.toHaveProperty('items');
    expect(res[0]).toMatchObject({ username: 'a', fullName: 'Alice' });
    // Legacy path never asks for a COUNT.
    expect(radiusSync.countActiveSessions).not.toHaveBeenCalled();
    expect(radiusSync.getActiveSessions).toHaveBeenCalledWith(undefined);
  });

  it('non-admin sees ONLY sessions in their own subtree (scope filter drops the rest)', async () => {
    const { radiusSync, prisma, scope, service } = makeNetwork({
      scope: { isAdmin: jest.fn(() => false) },
    });
    radiusSync.getActiveSessions.mockResolvedValue([radacctRow('mine'), radacctRow('theirs')]);
    prisma.subscriber.findMany.mockResolvedValue([
      { id: 1, username: 'mine', fullName: 'Mine', phone: null, package: null },
    ]);

    const res: any = await service.liveSessions(undefined, { role: 'reseller' }, { page: 1, limit: 50 });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].username).toBe('mine');
    // Scoping query still ran against the paged rows only.
    expect(prisma.subscriber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: expect.any(Array) }) }),
    );
  });
});
