import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { NasMonitorService } from './nas-monitor.service';
import { LiveTrafficService } from './live-traffic.service';
import { ScopeService } from '../common/scope.service';

/**
 * TELEMETRY TENANCY — the dashboard aggregates.
 *
 * GET /telemetry/{feed,nas-health,network-traffic,top-subscribers,live-traffic}
 * summed or listed EVERY company's routers and subscribers for whoever asked:
 * one ISP could read another's router names and IPs, its throughput, and the
 * names of its heaviest customers. Each now narrows to the caller's routers
 * (nasWhere) or subscribers (their subtree); the platform owner keeps the
 * whole-installation view.
 *
 * Real services, hand-rolled prisma and scope.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_C = { sub: 30, role: 'ADMIN' }; // has no routers at all

const NAS = [
  { id: 100, ownerId: 10, nasname: 'a-core', shortname: 'a-core', nasIp: '10.0.0.1', apiPort: 8728, apiUsername: 'u', apiPassword: 'p', isActive: true },
  { id: 200, ownerId: 20, nasname: 'b-core', shortname: 'b-core', nasIp: '10.0.0.2', apiPort: 8728, apiUsername: 'u', apiPassword: 'p', isActive: true },
];

function make() {
  const idFilter = (where: any): number[] | null => {
    for (const w of where?.AND ?? []) if (w?.id?.in) return w.id.in;
    return null;
  };
  const prisma: any = {
    nas: {
      findMany: jest.fn(async ({ where }: any = {}) => {
        let rows = NAS;
        if (where?.ownerId !== undefined) rows = rows.filter((n) => n.ownerId === where.ownerId);
        const ids = idFilter(where);
        if (ids) rows = rows.filter((n) => ids.includes(n.id));
        return rows;
      }),
    },
    nasTrafficSample: { findMany: jest.fn().mockResolvedValue([]) },
    networkLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  const real = new ScopeService({} as any);
  const scope: any = {
    isAdmin: (r?: string) => r === 'SUPER_ADMIN',
    isPlatformOwner: (a: any) => real.isPlatformOwner(a),
    nasWhere: jest.fn(async (a: any) => (a?.role === 'SUPER_ADMIN' ? {} : { ownerId: a.sub })),
    visibleUserIds: jest.fn(async (a: any) => (a?.role === 'SUPER_ADMIN' ? null : [a.sub])),
  };
  // Router counters: each poll of a router adds a fixed amount of traffic.
  const step: Record<string, [number, number]> = { '10.0.0.1': [2000, 4000], '10.0.0.2': [20000, 40000] };
  const polls: Record<string, number> = {};
  const mikrotik: any = {
    getActivePppoeUsers: jest.fn(async (ip: string) => {
      const n = (polls[ip] = (polls[ip] ?? -1) + 1);
      return [{ uploadBytes: step[ip][0] * n, downloadBytes: step[ip][1] * n }];
    }),
  };

  const aggregator = new LinkAggregatorService(prisma);
  const telemetry = new TelemetryService(prisma, aggregator, scope);
  const monitor = new NasMonitorService(prisma, {} as any, {} as any);
  const live = new LiveTrafficService(prisma, mikrotik);
  const ctl = new TelemetryController(telemetry, monitor, {} as any, scope, live);
  return { prisma, scope, aggregator, live, ctl };
}

describe('Telemetry tenancy', () => {
  afterEach(() => jest.restoreAllMocks());

  it('feed: a company sees only events from its own routers; the platform owner sees all', async () => {
    const { aggregator, ctl } = make();
    await aggregator.onSyslog(NAS[0], { level: 'info', kind: 'PPPOE', message: 'a event' });
    await aggregator.onSyslog(NAS[1], { level: 'down', kind: 'PPPOE', message: 'b event' });

    const mine = await ctl.feed({ user: ISP_A });
    expect(mine.map((f) => f.nasId)).toEqual([100]);
    expect((await ctl.feed({ user: OWNER })).map((f) => f.nasId)).toEqual([200, 100]);
    expect(await ctl.feed({ user: ISP_C })).toEqual([]);
  });

  it('nas-health: lists the caller\'s routers through a scoped where', async () => {
    const { prisma, scope, ctl } = make();
    const out = await ctl.nasHealth({ user: ISP_A });
    expect(scope.nasWhere).toHaveBeenCalledWith(ISP_A);
    expect(out.nas.map((n) => n.id)).toEqual([100]);
    const boardWhere = prisma.nas.findMany.mock.calls[1][0].where;
    expect(boardWhere.AND).toContainEqual({ id: { in: [100] } });
    expect(prisma.nasTrafficSample.findMany.mock.calls[0][0].where.nasId).toEqual({ in: [100] });
  });

  it('nas-health: the platform owner keeps every router; a company with none gets an empty board', async () => {
    const { prisma, ctl } = make();
    expect((await ctl.nasHealth({ user: OWNER })).nas.map((n) => n.id).sort()).toEqual([100, 200]);
    expect(prisma.nasTrafficSample.findMany.mock.calls[0][0].where.nasId).toBeUndefined();
    expect(await ctl.nasHealth({ user: ISP_C })).toEqual({ nas: [] });
    expect(prisma.nasTrafficSample.findMany).toHaveBeenCalledTimes(1); // not again for ISP_C
  });

  it('network-traffic: the sum is limited to the caller\'s routers by a bound parameter', async () => {
    const { prisma, ctl } = make();
    await ctl.networkTraffic({ user: ISP_A }, '1h');
    const [sql, ...args] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('"nasId" = ANY($2::int[])');
    expect(args[1]).toEqual([100]);

    prisma.$queryRawUnsafe.mockClear();
    await ctl.networkTraffic({ user: OWNER }, '1h');
    const [ownerSql, ...ownerArgs] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(ownerSql).not.toContain('ANY(');
    expect(ownerArgs).toHaveLength(1);
  });

  it('top-subscribers: ranks only subscribers owned in the caller\'s subtree', async () => {
    const { prisma, scope, ctl } = make();
    await ctl.topSubscribers({ user: ISP_A }, '5');
    expect(scope.visibleUserIds).toHaveBeenCalledWith(ISP_A);
    const [sql, ...args] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('"userId" = ANY($1::int[])');
    expect(args).toEqual([[10]]);

    prisma.$queryRawUnsafe.mockClear();
    await ctl.topSubscribers({ user: OWNER }, '5');
    const [ownerSql, ...ownerArgs] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(ownerSql).not.toContain('"userId" = ANY');
    expect(ownerArgs).toEqual([]);
  });

  it('live-traffic: a company\'s meter is summed from its own routers only', async () => {
    const { ctl } = make();
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await ctl.liveTraffic({ user: OWNER }); // baseline poll
    now += 2000;
    const whole = await ctl.liveTraffic({ user: OWNER }); // first rate point

    // Whole installation: both routers, 1000+10000 up / 2000+20000 down per second.
    expect(whole.points.at(-1)).toMatchObject({ upBps: 11000, downBps: 22000 });
    expect(whole.devices.map((d) => d.nasId).sort()).toEqual([100, 200]);

    const mine = await ctl.liveTraffic({ user: ISP_A });
    expect(mine.points.at(-1)).toMatchObject({ upBps: 1000, downBps: 2000 });
    expect(mine.devices.map((d) => d.nasId)).toEqual([100]);
    expect(mine.deviceSummary).toBe('1/1 routers reporting');

    const none = await ctl.liveTraffic({ user: ISP_C });
    expect(none.points).toEqual([]);
    expect(none.devices).toEqual([]);
  });
});
