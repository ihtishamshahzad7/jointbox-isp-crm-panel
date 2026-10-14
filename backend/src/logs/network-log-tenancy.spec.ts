import { LogsService } from './logs.service';
import { RouterLogsService } from './router-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

type Where = Record<string, unknown>;
const whereOf = (fn: jest.Mock): Where =>
  (fn.mock.calls[0] as [{ where: Where }])[0].where;

/**
 * Network logs are scoped by router ownership. A router can carry a row about
 * another company's subscriber (a cross-company session recorded before the
 * RADIUS tenancy policy was enforced); that row must not reach the router's
 * owner.
 */
describe("network logs — another company's subscriber on our router", () => {
  function make(admin: boolean) {
    const prisma = {
      networkLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const scope = {
      isAdmin: () => admin,
      rootId: jest.fn().mockResolvedValue(10),
      descendantIds: jest.fn().mockResolvedValue([10, 11]),
    };
    const svc = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );
    return { svc, prisma };
  }

  it('a company sees router events and its own subscribers only', async () => {
    const { svc, prisma } = make(false);
    await svc.getNetworkLogs({ sub: 11, role: 'ADMIN' });
    const where = whereOf(prisma.networkLog.findMany);
    expect(where.nas).toEqual({ ownerId: { in: [10, 11] } });
    expect(where.OR).toEqual([
      { subscriberId: null },
      { subscriber: { userId: { in: [10, 11] } } },
    ]);
    expect(whereOf(prisma.networkLog.count)).toBe(where);
  });

  it('the platform account is not narrowed', async () => {
    const { svc, prisma } = make(true);
    await svc.getNetworkLogs({ sub: 1, role: 'SUPER_ADMIN' });
    expect(whereOf(prisma.networkLog.findMany)).toEqual({});
  });
});

describe("router logs — another company's router or customers", () => {
  const tenancy = (decision: string) =>
    jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('jointbox_radius_tenancy')
          ? [{ r: decision }]
          : [],
      ),
    );

  it("a subscriber's router log is not read from a router the policy refuses them on", async () => {
    const mikrotik = { getRouterLogs: jest.fn().mockResolvedValue([]) };
    const prisma = {
      $queryRaw: tenancy('reject:cross-company'),
      subscriber: {
        findFirst: jest.fn().mockResolvedValue({
          id: 7,
          username: 'alice',
          nas: {
            id: 24,
            nasname: 'b-core',
            nasIp: '192.0.2.3',
            apiPort: 8728,
            apiUsername: 'api',
            apiPassword: 'x',
          },
        }),
      },
    };
    const scope = {
      isAdmin: () => false,
      rootId: jest.fn().mockResolvedValue(10),
      descendantIds: jest.fn().mockResolvedValue([10]),
    };
    const svc = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      mikrotik as unknown as MikrotikSyncService,
    );
    const r = await svc.getRouterLogsForSubscriber(
      { sub: 10, role: 'ADMIN' },
      7,
    );
    expect(r.lines).toEqual([]);
    expect(mikrotik.getRouterLogs).not.toHaveBeenCalled();
  });

  function routerLogs(opts: { sharedOnly: number; decision?: string }) {
    const prisma = {
      $queryRaw: tenancy(opts.decision ?? 'allow'),
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          username: 'alice',
          nas: {
            id: 24,
            nasIp: '192.0.2.3',
            apiPort: 8728,
            apiUsername: 'api',
            apiPassword: 'x',
          },
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ username: 'alice' }, { username: 'bob' }]),
      },
      nas: { count: jest.fn().mockResolvedValue(opts.sharedOnly) },
      routerLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const scope = {
      isAdmin: () => false,
      rootId: jest.fn().mockResolvedValue(10),
      descendantIds: jest.fn().mockResolvedValue([10, 11]),
      assertSubscriber: jest.fn().mockResolvedValue(undefined),
    };
    const mikrotik = { getRouterLogs: jest.fn().mockResolvedValue([]) };
    const svc = new RouterLogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      mikrotik as unknown as MikrotikSyncService,
    );
    return { svc, prisma, mikrotik };
  }

  it("a router only SHARED with a company shows that company its own subscribers' lines, never the owner's customers", async () => {
    const { svc, prisma } = routerLogs({ sharedOnly: 1 });
    await svc.list({ sub: 11, role: 'ADMIN' });
    const where = whereOf(prisma.routerLog.findMany);
    expect(where.AND).toEqual([
      {
        OR: [
          { nas: { ownerId: { in: [10, 11] } } },
          {
            AND: [
              { nas: { assignments: { some: { userId: { in: [10, 11] } } } } },
              { username: { in: ['alice', 'bob'] } },
            ],
          },
        ],
      },
    ]);
    expect(whereOf(prisma.routerLog.count)).toBe(where);
  });

  it('with no shared routers, only routers the company owns', async () => {
    const { svc, prisma } = routerLogs({ sharedOnly: 0 });
    await svc.list({ sub: 11, role: 'ADMIN' });
    expect(whereOf(prisma.routerLog.findMany).AND).toEqual([
      { OR: [{ nas: { ownerId: { in: [10, 11] } } }] },
    ]);
    expect(prisma.subscriber.findMany).not.toHaveBeenCalled();
  });

  it("a subscriber's on-demand log refresh never uses a refused router's API login", async () => {
    const { svc, mikrotik } = routerLogs({
      sharedOnly: 0,
      decision: 'reject:cross-company',
    });
    await svc.forSubscriber(7, { sub: 10, role: 'ADMIN' });
    expect(mikrotik.getRouterLogs).not.toHaveBeenCalled();
  });

  it('…and does refresh from an allowed router', async () => {
    const { svc, mikrotik } = routerLogs({ sharedOnly: 0, decision: 'allow' });
    await svc.forSubscriber(7, { sub: 10, role: 'ADMIN' });
    expect(mikrotik.getRouterLogs).toHaveBeenCalledTimes(1);
  });
});
