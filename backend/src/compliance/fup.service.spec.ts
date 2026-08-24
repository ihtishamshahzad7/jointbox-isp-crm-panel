import { FupService } from './fup.service';

/**
 * FUP (Fair Usage Policy) money/service-path regression tests.
 *
 * HANDOFF.md §5 lists FUP alongside activation, RADIUS sync, and disconnect
 * as relying on manual verification only — those three already have specs
 * (settle-activation.spec.ts, radius-sync.service.spec.ts,
 * network.service.spec.ts); this file closes the gap for FUP.
 *
 * What must never regress, because each one either loses revenue, wrongly
 * throttles a paying customer, or silently breaks a package configuration:
 *
 *   1. QUOTA RESOLUTION — subscriber override beats package default beats
 *      system default; free-text units ("500", "500GB", "1 TB") parse the
 *      same way an operator would read them.
 *   2. ENFORCEMENT IS PER-PACKAGE — THROTTLE / BLOCK / NONE is read from the
 *      package, not applied uniformly; a package with no quota is left alone
 *      entirely (not even measured).
 *   3. A MALFORMED THROTTLE IS REFUSED, NOT SENT — writing
 *      "${download}M/${upload}M" with a missing or out-of-range FUP speed
 *      would either be rejected by the router or (worse) silently raise the
 *      customer's speed as a "punishment". The guard must block this AND log
 *      it, and must NOT mark the subscriber as fupApplied when it does.
 *   4. RELEASE restores the ORIGINAL package speeds, not the FUP speeds.
 *
 * Prisma and the RADIUS/network collaborators are all mocked: these assert
 * OUR logic, not the database's or the router's.
 */
describe('FupService', () => {
  function makeService(overrides: any = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ up: 0, down: 0 }]),
      subscriber: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      serviceSettings: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      systemLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      ...(overrides.prisma || {}),
    };
    const radiusSync: any = {
      syncSubscriberProfile: jest.fn().mockResolvedValue(undefined),
      removeSubscriberFromRadius: jest.fn().mockResolvedValue(undefined),
    };
    const network: any = { disconnect: jest.fn().mockResolvedValue({ disconnected: true }) };
    const notifications: any = { send: jest.fn().mockResolvedValue(undefined) };
    const scope: any = {};
    const svc = new FupService(prisma, scope, radiusSync, network, notifications);
    return { prisma, radiusSync, network, notifications, svc };
  }

  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ---------------------------------------------------------------------
  // 1. Quota resolution — subscriber override > package > system default.
  // ---------------------------------------------------------------------
  describe('quota resolution (baseQuotaGb / quotaGb)', () => {
    function base(svc: FupService, settingsQuota?: string | null, packageQuota?: number | null) {
      return (svc as any).baseQuotaGb(settingsQuota, packageQuota);
    }

    it('parses a plain number as GB', () => {
      const { svc } = makeService();
      expect(base(svc, '500', null)).toBe(500);
    });

    it('parses "500GB" as 500', () => {
      const { svc } = makeService();
      expect(base(svc, '500GB', null)).toBe(500);
    });

    it('parses "1 TB" as 1024 GB', () => {
      const { svc } = makeService();
      expect(base(svc, '1 TB', null)).toBe(1024);
    });

    it('falls through to the package quota when the subscriber override is unparsable ("unlimited")', () => {
      const { svc } = makeService();
      expect(base(svc, 'unlimited', 250)).toBe(250);
    });

    it('falls through to the system default (env) when neither override nor package set a quota', () => {
      process.env.FUP_DEFAULT_QUOTA_GB = '1500';
      const { svc } = makeService();
      expect(base(svc, null, null)).toBe(1500);
    });

    it('is genuinely unlimited (null) when nothing is set anywhere', () => {
      delete process.env.FUP_DEFAULT_QUOTA_GB;
      const { svc } = makeService();
      expect(base(svc, null, null)).toBeNull();
    });

    it('adds bonus GB on top of the base allowance', () => {
      const { svc } = makeService();
      const effective = (svc as any).quotaGb('500', null, 50);
      expect(effective).toBe(550);
    });
  });

  // ---------------------------------------------------------------------
  // 2. enforce() — per-package action, and packages with no policy untouched.
  // ---------------------------------------------------------------------
  describe('enforce() — hourly sweep', () => {
    const overQuotaCandidate = (extra: any = {}) => {
      // NOTE: merge `package`/`serviceSettings` explicitly rather than
      // spreading `extra` last — a naive trailing `...extra` would replace
      // the whole default `package` object with only the override's keys
      // instead of layering on top of it.
      const { package: pkgOverride, serviceSettings: ssOverride, ...rest } = extra;
      return {
        id: 1,
        username: 'alice',
        phone: '+92300',
        fupApplied: false,
        package: {
          dataQuotaGb: 100,
          fupAction: 'THROTTLE',
          fupDownloadSpeed: 2,
          fupUploadSpeed: 2,
          downloadSpeed: 10,
          uploadSpeed: 10,
          duration: 30,
          ...pkgOverride,
        },
        serviceSettings: { quota: null, expiryDate: new Date('2026-08-24'), duration: 30, ...ssOverride },
        ...rest,
      };
    };

    it('BLOCK action: over quota → removed from RADIUS, disconnected, marked fupApplied, customer notified', async () => {
      const { prisma, radiusSync, network, notifications, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([
              overQuotaCandidate({ package: { fupAction: 'BLOCK', fupDownloadSpeed: null, fupUploadSpeed: null } }),
            ]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn().mockResolvedValue([{ up: 60 * 1024 ** 3, down: 60 * 1024 ** 3 }]), // 120GB used, over 100GB cap
        },
      });

      await svc.enforce();

      expect(radiusSync.removeSubscriberFromRadius).toHaveBeenCalledWith('alice');
      expect(network.disconnect).toHaveBeenCalledWith('alice');
      expect(prisma.subscriber.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ fupApplied: true }) }),
      );
      expect(notifications.send).toHaveBeenCalledWith(expect.objectContaining({ event: 'FUP_BLOCK' }));
    });

    it('THROTTLE action with valid FUP speeds: syncs the reduced profile, kicks the session, marks fupApplied', async () => {
      const { prisma, radiusSync, network, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([overQuotaCandidate()]),
            findUnique: jest.fn().mockResolvedValue({ authMethod: 'PPPOE', serviceSettings: {} }),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn().mockResolvedValue([{ up: 60 * 1024 ** 3, down: 60 * 1024 ** 3 }]),
        },
      });

      await svc.enforce();

      expect(radiusSync.syncSubscriberProfile).toHaveBeenCalled();
      const pkgArg = radiusSync.syncSubscriberProfile.mock.calls[0][2];
      expect(pkgArg.downloadSpeed).toBe(2); // FUP speed, not the plan's 10
      expect(pkgArg.uploadSpeed).toBe(2);
      expect(network.disconnect).toHaveBeenCalledWith('alice');
      expect(prisma.subscriber.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fupApplied: true }) }),
      );
    });

    it('REFUSES a malformed throttle: FUP speed exceeds the package speed → no sync, no fupApplied, logged as a config error', async () => {
      const { prisma, radiusSync, network, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([
              overQuotaCandidate({ package: { fupDownloadSpeed: 20, downloadSpeed: 10 } }), // 20 > 10 — incoherent
            ]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn().mockResolvedValue([{ up: 60 * 1024 ** 3, down: 60 * 1024 ** 3 }]),
        },
      });

      await svc.enforce();

      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
      expect(network.disconnect).not.toHaveBeenCalled();
      expect(prisma.subscriber.update).not.toHaveBeenCalled();
      expect(prisma.systemLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ level: 'ERROR', source: 'fup' }) }),
      );
    });

    it('action NONE: measured but never touched, even when over quota', async () => {
      const { prisma, radiusSync, network, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([overQuotaCandidate({ package: { fupAction: 'NONE' } })]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn().mockResolvedValue([{ up: 60 * 1024 ** 3, down: 60 * 1024 ** 3 }]),
        },
      });

      await svc.enforce();

      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
      expect(radiusSync.removeSubscriberFromRadius).not.toHaveBeenCalled();
      expect(prisma.subscriber.update).not.toHaveBeenCalled();
    });

    it('THROTTLE package missing a FUP speed is skipped before usage is even measured (no malformed rate limit risk)', async () => {
      const { prisma, radiusSync, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([
              overQuotaCandidate({ package: { fupUploadSpeed: null } }), // download set, upload missing
            ]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn(), // must never be called for this subscriber
        },
      });

      await svc.enforce();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
    });

    it('under quota: no action taken regardless of package action', async () => {
      const { prisma, radiusSync, network, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([overQuotaCandidate()]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          // 10GB used vs a 100GB cap — comfortably under.
          $queryRaw: jest.fn().mockResolvedValue([{ up: 5 * 1024 ** 3, down: 5 * 1024 ** 3 }]),
        },
      });

      await svc.enforce();

      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
      expect(network.disconnect).not.toHaveBeenCalled();
      expect(prisma.subscriber.update).not.toHaveBeenCalled();
    });

    it('a subscriber with no quota anywhere (no override, no package cap, no system default) is left alone', async () => {
      const { prisma, radiusSync, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn().mockResolvedValue([
              overQuotaCandidate({ package: { dataQuotaGb: null } }),
            ]),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
          },
          $queryRaw: jest.fn(),
        },
      });

      await svc.enforce();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // 3. release() — restores the ORIGINAL package speeds, not the FUP ones.
  // ---------------------------------------------------------------------
  describe('release()', () => {
    it('re-syncs with the plan speeds and clears fupApplied', async () => {
      const { prisma, radiusSync, network, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn(),
            findUnique: jest.fn().mockResolvedValue({
              id: 1,
              username: 'alice',
              password: 'pw',
              authMethod: 'PPPOE',
              serviceSettings: {},
              package: { downloadSpeed: 10, uploadSpeed: 10, fupDownloadSpeed: 2, fupUploadSpeed: 2 },
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        },
      });

      const res = await svc.release(1);

      expect(res).toMatchObject({ released: true, username: 'alice' });
      const pkgArg = radiusSync.syncSubscriberProfile.mock.calls[0][2];
      expect(pkgArg.downloadSpeed).toBe(10); // full plan speed restored, not 2
      expect(network.disconnect).toHaveBeenCalledWith('alice');
      expect(prisma.subscriber.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, data: { fupApplied: false, fupAppliedAt: null } }),
      );
    });

    it('does nothing for a subscriber with no username', async () => {
      const { prisma, radiusSync, svc } = makeService({
        prisma: { subscriber: { findMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 1, username: null }), update: jest.fn() } },
      });

      const res = await svc.release(1);

      expect(res).toEqual({ released: false });
      expect(radiusSync.syncSubscriberProfile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // 4. extendQuota() — a top-up can immediately lift enforcement.
  // ---------------------------------------------------------------------
  describe('extendQuota()', () => {
    it('grants the extra GB and auto-restores service when the customer is now back under quota', async () => {
      const { prisma, svc } = makeService({
        prisma: {
          subscriber: {
            findMany: jest.fn(),
            // First call: the subscriber record for the top-up itself (fupApplied true, was blocked).
            findUnique: jest
              .fn()
              .mockResolvedValueOnce({
                id: 1,
                fupApplied: true,
                serviceSettings: { bonusQuotaGb: 0 },
              })
              // Second call: inside usageFor(), re-reading with package+serviceSettings included.
              .mockResolvedValueOnce({
                id: 1,
                username: 'alice',
                fupApplied: true,
                package: { dataQuotaGb: 100 },
                serviceSettings: { quota: null, bonusQuotaGb: 50, expiryDate: new Date(), duration: 30 },
              }),
            update: jest.fn().mockResolvedValue({}),
          },
          serviceSettings: { upsert: jest.fn().mockResolvedValue({}) },
          // 60GB used — over the bare 100GB cap, but under 150GB once the 50GB bonus lands.
          $queryRaw: jest.fn().mockResolvedValue([{ up: 30 * 1024 ** 3, down: 30 * 1024 ** 3 }]),
        },
      });
      const releaseSpy = jest.spyOn(svc, 'release').mockResolvedValue({ released: true, username: 'alice' } as any);

      const res = await svc.extendQuota(1, 50);

      expect(prisma.serviceSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { bonusQuotaGb: 50 } }),
      );
      expect(releaseSpy).toHaveBeenCalledWith(1);
      expect(res).toMatchObject({ addedGb: 50, restored: true });
    });

    it('rejects a non-positive top-up', async () => {
      const { svc } = makeService();
      await expect(svc.extendQuota(1, 0)).rejects.toThrow('positive number');
      await expect(svc.extendQuota(1, -5)).rejects.toThrow('positive number');
    });
  });
});
