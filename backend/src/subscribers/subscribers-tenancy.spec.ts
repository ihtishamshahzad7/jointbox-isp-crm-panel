import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';

/**
 * SUBSCRIBER ROUTE TENANCY — the by-id / by-username / maintenance routes.
 *
 * ISP A (user 10) owns subscriber 100 "alice"; ISP B (user 20) owns 200
 * "bob". "ghost" is an orphan RADIUS username with no subscriber row, which
 * only the platform owner may reach.
 */
const OWNER = { sub: 1, role: 'SUPER_ADMIN' };
const ISP_A = { sub: 10, role: 'ADMIN' };
const ISP_B = { sub: 20, role: 'ADMIN' };
const SUB_OWNER: Record<number, number> = { 100: 10, 200: 20 };
const BY_USERNAME: Record<string, number> = { alice: 100, bob: 200 };

function makeScope() {
  const isPlatformOwner = (a: any) => a?.role === 'SUPER_ADMIN';
  const assertViaSubscriber = async (a: any, id: any, what = 'Record') => {
    if (isPlatformOwner(a)) return;
    if (id == null || SUB_OWNER[Number(id)] !== a.sub) throw new NotFoundException(`${what} not found`);
  };
  return {
    isPlatformOwner,
    assertPlatformOwner: jest.fn((a: any) => {
      if (!isPlatformOwner(a)) throw new ForbiddenException('installation-wide');
    }),
    assertSubscriberVisible: jest.fn((a: any, id: number) => assertViaSubscriber(a, id, 'Subscriber')),
    assertSubscriberUsername: jest.fn(async (a: any, u: string) => {
      if (isPlatformOwner(a)) return;
      return assertViaSubscriber(a, BY_USERNAME[u], 'Subscriber');
    }),
  };
}

function make() {
  const svc: any = {
    radiusSync: { removeSubscriberFromRadius: jest.fn().mockResolvedValue(undefined) },
    findOne: jest.fn(async (id: number) => ({ id, username: id === 100 ? 'alice' : 'bob', password: 'x', package: null })),
    findAll: jest.fn().mockResolvedValue([{ id: 100, username: 'alice', fullName: 'Alice', status: 'ACTIVE' }]),
    findByUsername: jest.fn().mockResolvedValue({ id: 100 }),
    getProfileBundle: jest.fn().mockResolvedValue({}),
    syncToRadius: jest.fn().mockResolvedValue({ synced: true }),
    repairMissingLinks: jest.fn().mockResolvedValue({}),
    testRadiusConnection: jest.fn().mockResolvedValue({ connected: true }),
    checkRadiusStatus: jest.fn().mockResolvedValue({ existsInRadius: false }),
    getRadiusSession: jest.fn().mockResolvedValue({}),
    getLiveTraffic: jest.fn().mockResolvedValue({}),
    getBandwidthHistory: jest.fn().mockResolvedValue({}),
    getDailyUsage: jest.fn().mockResolvedValue({}),
    getRadiusAuthLog: jest.fn().mockResolvedValue({}),
    getRadiusChecks: jest.fn().mockResolvedValue({}),
  };
  const scope = makeScope();
  const ctl = new SubscribersController(svc, {} as any, {} as any, {} as any, {} as any, scope as any);
  return { svc, scope, ctl };
}

const req = (user: any) => ({ user });

describe('Subscriber route tenancy', () => {
  it("another company's ADMIN gets not-found on every by-id route, and nothing runs", async () => {
    const { ctl, svc } = make();
    const calls = [
      () => ctl.findOne('100', req(ISP_B)),
      () => ctl.profileBundle('100', req(ISP_B)),
      () => ctl.syncProfile('100', req(ISP_B)),
      () => ctl.syncOneToRadius('100', req(ISP_B)),
      () => ctl.fixRadiusPassword('100', req(ISP_B)),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.findOne).not.toHaveBeenCalled();
    expect(svc.getProfileBundle).not.toHaveBeenCalled();
    expect(svc.syncToRadius).not.toHaveBeenCalled();
    expect(svc.radiusSync.removeSubscriberFromRadius).not.toHaveBeenCalled();
  });

  it("another company's ADMIN gets not-found on every by-username route", async () => {
    const { ctl, svc } = make();
    const calls = [
      () => ctl.getRadiusSession('alice', req(ISP_B)),
      () => ctl.getLiveTraffic('alice', req(ISP_B)),
      () => ctl.getBandwidthHistory('alice', req(ISP_B)),
      () => ctl.getDailyUsage('alice', req(ISP_B)),
      () => ctl.getRadiusAuthLog('alice', req(ISP_B)),
      () => ctl.getRadiusChecks('alice', req(ISP_B)),
      () => ctl.checkRadiusStatus('alice', req(ISP_B)),
      () => ctl.findByUsername('alice', req(ISP_B)),
      () => ctl.removeFromRadius('alice', req(ISP_B)),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    for (const m of ['getRadiusSession', 'getLiveTraffic', 'getBandwidthHistory', 'getDailyUsage',
      'getRadiusAuthLog', 'getRadiusChecks', 'checkRadiusStatus', 'findByUsername']) {
      expect(svc[m]).not.toHaveBeenCalled();
    }
    expect(svc.radiusSync.removeSubscriberFromRadius).not.toHaveBeenCalled();
  });

  it('an orphan RADIUS username is reachable by the platform owner only', async () => {
    const a = make();
    await expect(a.ctl.removeFromRadius('ghost', req(ISP_A))).rejects.toBeInstanceOf(NotFoundException);
    expect(a.svc.radiusSync.removeSubscriberFromRadius).not.toHaveBeenCalled();

    const o = make();
    await o.ctl.removeFromRadius('ghost', req(OWNER));
    expect(o.svc.radiusSync.removeSubscriberFromRadius).toHaveBeenCalledWith('ghost');
  });

  it('the owning company and the platform owner pass', async () => {
    for (const actor of [ISP_A, OWNER]) {
      const { ctl, svc } = make();
      await ctl.findOne('100', req(actor));
      await ctl.getRadiusSession('alice', req(actor));
      await ctl.syncOneToRadius('100', req(actor));
      expect(svc.findOne).toHaveBeenCalledWith(100, actor);
      expect(svc.getRadiusSession).toHaveBeenCalledWith('alice');
      expect(svc.syncToRadius).toHaveBeenCalledWith(100);
    }
  });

  it('installation-wide maintenance is platform-owner only', async () => {
    const a = make();
    expect(() => a.ctl.repairLinks(req(ISP_A))).toThrow(ForbiddenException);
    await expect(a.ctl.testRadiusConnection(req(ISP_A))).rejects.toBeInstanceOf(ForbiddenException);
    expect(a.svc.repairMissingLinks).not.toHaveBeenCalled();
    expect(a.svc.testRadiusConnection).not.toHaveBeenCalled();

    const o = make();
    await o.ctl.repairLinks(req(OWNER));
    await o.ctl.testRadiusConnection(req(OWNER));
    expect(o.svc.repairMissingLinks).toHaveBeenCalled();
    expect(o.svc.testRadiusConnection).toHaveBeenCalled();
  });

  it('missing-from-radius lists only the caller’s subscribers', async () => {
    const { ctl, svc } = make();
    const res = await ctl.getMissingFromRadius(req(ISP_A));
    expect(svc.findAll).toHaveBeenCalledWith(undefined, ISP_A);
    expect(res).toMatchObject({ total: 1, missing: 1 });
  });

  it('format/columns is a constant description (tenant-free)', () => {
    const { ctl } = make();
    const r = ctl.formatColumns(req(ISP_A));
    expect(r.count).toBe(r.columns.length);
  });
});
