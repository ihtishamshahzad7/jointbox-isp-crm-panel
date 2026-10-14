import { IntegrityService } from './integrity.service';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

/**
 * "Sync sessions" run by a company closes the ghost sessions on its routers —
 * but only its OWN subscribers' rows. A row on its router that belongs to
 * another company's subscriber (a cross-company session recorded before the
 * RADIUS tenancy policy was enforced, or one filed under its address by a
 * router that claimed it) is left for the platform run: a company never
 * closes another company's sessions.
 */
describe("session sync — another company's sessions on our router", () => {
  function make() {
    const prisma = {
      nas: {
        findMany: jest.fn().mockResolvedValue([
          {
            nasname: 'a-core',
            nasIp: '192.0.2.2',
            apiPort: 8728,
            apiUsername: 'api',
            apiPassword: 'x',
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { username: 'alice', acctsessionid: 'S-alice' }, // company A, not on the router any more
        { username: 'bob', acctsessionid: 'S-bob' }, //     company B, not on the router any more
        { username: 'carol', acctsessionid: 'S-carol' }, // company A, live
      ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      subscriber: {
        findMany: jest.fn(
          ({ where }: { where: { userId?: { in: number[] } } }) =>
            Promise.resolve(where.userId ? [{ username: 'alice' }] : []),
        ),
      },
    };
    const mikrotik = {
      getPppoeActiveConnections: jest
        .fn()
        .mockResolvedValue([{ name: 'carol' }]),
    };
    const svc = new IntegrityService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      mikrotik as unknown as MikrotikSyncService,
      {} as never,
    );
    const closedIds = () =>
      prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[1] as string);
    return { svc, prisma, closedIds };
  }

  it("a company run closes only its own subscribers' ghost sessions", async () => {
    const { svc, prisma, closedIds } = make();
    const r = await svc.reconcileSessionsWithRouter(
      true,
      { ownerId: { in: [1, 5] } },
      [1, 5],
    );
    expect(closedIds()).toEqual(['S-alice']);
    expect(r).toMatchObject({ closed: 1, leftForPlatform: 1 });
    expect(prisma.subscriber.findMany).toHaveBeenCalledWith({
      where: { username: { in: ['alice', 'bob'] }, userId: { in: [1, 5] } },
      select: { username: true },
    });
  });

  it('the platform run closes every ghost session', async () => {
    const { svc, closedIds } = make();
    const r = await svc.reconcileSessionsWithRouter(true);
    expect(closedIds().sort()).toEqual(['S-alice', 'S-bob']);
    expect(r.closed).toBe(2);
    expect(r).not.toHaveProperty('leftForPlatform');
  });
});
