import { SubscribersService } from './subscribers.service';

/**
 * Verification-phase Priority 2 — the three bulk routes that previously took
 * ids and NO caller:
 *
 *   PATCH  /subscribers/bulk-service-settings   bulkUpdateServiceSettings
 *   POST   /subscribers/bulk-sync-to-radius     bulkSyncToRadius
 *   POST   /subscribers/sync-*-to-radius/queue  enqueueRadiusSync
 *
 * The structural guarantee (the handler receives `req.user`) is enforced by
 * the authorization-matrix suite. This file pins the BEHAVIOUR the actor is
 * then supposed to drive: per-id subtree checks that SKIP foreign ids (the
 * bulk-action pattern — one bad id never aborts or contaminates the batch),
 * and queued syncs whose job payload confines the job to the actor's subtree.
 */
describe('SubscribersService bulk-scope (Priority 2)', () => {
  function makeMocks(overrides: any = {}) {
    const prisma: any = {
      subscriber: { update: jest.fn().mockResolvedValue({}) },
      serviceSettings: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
      ...overrides.prisma,
    };
    const queue: any = { add: jest.fn().mockResolvedValue('radius-sync-all:1') };
    const scope: any = {
      canAccessSubscriber: jest.fn().mockResolvedValue(true),
      subscriberWhere: jest.fn().mockResolvedValue({ userId: { in: [7, 9] } }),
      ...overrides.scope,
    };

    const service = new SubscribersService(
      prisma,
      {} as any,      // radiusSync
      {} as any,      // cache
      queue,
      {} as any,      // accounting
      {} as any,      // notifications
      scope,
      {} as any,      // pricing
      {} as any,      // invoices
      {} as any,      // security
      {} as any,      // renewal
      {} as any,      // mikrotik
      {} as any,      // currency
      {} as any,      // liveTraffic
    );
    return { prisma, queue, scope, service };
  }

  describe('bulkUpdateServiceSettings', () => {
    it('skips ids outside the actor\x27s subtree and still applies the rest', async () => {
      const { scope, service } = makeMocks();
      // id 11 is foreign; 22 and 22 (deduped) are in-scope.
      scope.canAccessSubscriber.mockImplementation(async (_a: any, id: number) => id !== 11);
      service.findOne = jest.fn().mockResolvedValue({ id: 22, username: 'u22' });

      const out = await service.bulkUpdateServiceSettings([11, 22, 22], { profileStatus: 'ACTIVE' }, { sub: 7, role: 'RESELLER' } as any);

      expect(out).toMatchObject({ total: 2, success: 1, failed: 0, skipped: 1 });
      // The foreign id was never read or written — findOne ran only for id 22.
      expect(service.findOne).toHaveBeenCalledTimes(1);
      expect(scope.canAccessSubscriber).toHaveBeenCalledWith(expect.anything(), 11);
      expect(scope.canAccessSubscriber).toHaveBeenCalledWith(expect.anything(), 22);
    });

    it('does not skip anything when no actor is passed (internal callers)', async () => {
      const { service } = makeMocks();
      service.findOne = jest.fn().mockResolvedValue({ id: 5, username: 'u5' });

      const out = await service.bulkUpdateServiceSettings([5], { profileStatus: 'INACTIVE' });

      expect(out).toMatchObject({ total: 1, success: 1, skipped: 0 });
      expect(service.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('bulkSyncToRadius', () => {
    it('never reads or rewrites a subscriber outside the actor\x27s subtree', async () => {
      const { scope, service } = makeMocks();
      scope.canAccessSubscriber.mockImplementation(async (_a: any, id: number) => id === 1);
      service.findOne = jest.fn().mockResolvedValue({ id: 1, username: 'u1', password: 'p' });
      service.syncToRadius = jest.fn().mockResolvedValue({ synced: true });

      const out = await service.bulkSyncToRadius([1, 99], { sub: 7, role: 'RESELLER' } as any);

      expect(out.results).toEqual([
        { id: 1, username: 'u1', status: 'success' },
        { id: 99, status: 'skipped', reason: 'Outside your account.' },
      ]);
      // 99 was rejected before findOne — no cross-tenant read even happened.
      expect(service.findOne).toHaveBeenCalledTimes(1);
      expect(service.syncToRadius).toHaveBeenCalledTimes(1);
    });

    it('dedupes ids and filters non-numbers', async () => {
      const { scope, service } = makeMocks();
      service.findOne = jest.fn().mockResolvedValue({ id: 1, username: 'u1', password: 'p' });
      service.syncToRadius = jest.fn().mockResolvedValue({ synced: true });

      const out = await service.bulkSyncToRadius([1, 1, 0, NaN as any, 2, 2], { sub: 7, role: 'RESELLER' } as any);

      expect(out.results).toHaveLength(2);
      expect(service.findOne).toHaveBeenCalledTimes(2);
      expect(scope.canAccessSubscriber).toHaveBeenCalledTimes(2);
    });
  });

  describe('enqueueRadiusSync', () => {
    it('puts the actor\x27s subtree in the job payload, so the worker never walks another tenant', async () => {
      const { queue, scope, service } = makeMocks();
      scope.subscriberWhere.mockResolvedValue({ userId: { in: [7, 9] } });

      await service.enqueueRadiusSync('all', { sub: 7, role: 'RESELLER' } as any);

      expect(queue.add).toHaveBeenCalledWith('radius-sync-all', { scope: { userId: { in: [7, 9] } } });
    });

    it('passes an undefined scope for actorless (background) callers — full sync as before', async () => {
      const { queue, service } = makeMocks();
      await service.enqueueRadiusSync('missing');

      expect(queue.add).toHaveBeenCalledWith('radius-sync-missing', { scope: undefined });
    });
  });
});