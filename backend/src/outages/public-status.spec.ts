import { OutagesService } from './outages.service';

/**
 * PUBLIC STATUS PAGE — what an unauthenticated visitor may see.
 *
 * These routes have no login, so the tests below are a disclosure boundary,
 * not a formatting check. The staff board (currentStatus) returns exact
 * subscriber counts per area, offline percentages and verdicts like
 * "investigate power or network". Published openly, the counts hand every
 * competitor a live map of the business and the verdicts are instructions to
 * staff, not information for customers.
 *
 * So publicStatus() is a SEPARATE method rather than a filter over the staff
 * one, and these tests exist to make sure it stays separate and stays narrow.
 *
 * The other rule they protect: only state a cause the classifier is actually
 * confident about. A low-confidence guess published on a public page comes
 * back as "your website says it's a fibre cut" — the customer will repeat it
 * to support as fact.
 */
describe('OutagesService — public status', () => {
  function makeService(opts: { areas?: any[]; open?: any[]; history?: any[] } = {}) {
    const prisma: any = {
      area: { findMany: jest.fn().mockResolvedValue(opts.areas ?? []) },
      powerOutage: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          // publicStatus asks for open outages; publicHistory asks for closed.
          Promise.resolve(where?.endedAt === null ? (opts.open ?? []) : (opts.history ?? [])),
        ),
      },
    };
    const svc = new OutagesService(prisma, {} as any, {} as any, {} as any, {} as any);
    return { prisma, svc };
  }

  const AREAS = [
    { id: 1, name: 'Jinnah Town', city: 'Quetta' },
    { id: 2, name: 'Patil Bagh', city: 'Quetta' },
  ];

  // ── The disclosure boundary ──────────────────────────────────────────────
  describe('what it must never expose', () => {
    it('returns no subscriber counts, percentages or internal notes', async () => {
      const { svc } = makeService({
        areas: AREAS,
        open: [{
          areaId: 1, startedAt: new Date('2026-08-29T10:00:00Z'), type: 'UNSCHEDULED',
          cause: 'FIBER_CUT', causeConfidence: 0.85,
        }],
      });

      const res = await svc.publicStatus();
      const serialised = JSON.stringify(res);

      // Nothing that reveals the size or internals of the business.
      for (const leaked of ['total', 'online', 'offline', 'offlinePercent', 'verdict', 'notes', 'causeReasons', 'affectedCount', 'areaTotal']) {
        expect(serialised).not.toContain(leaked);
      }
      // And no database ids to enumerate.
      expect(res.areas[0]).not.toHaveProperty('areaId');
      expect(res.areas[0]).not.toHaveProperty('outageId');
    });

    it('exposes only area, city, status, cause, message and since', async () => {
      const { svc } = makeService({ areas: [AREAS[0]], open: [] });
      const res = await svc.publicStatus();
      expect(Object.keys(res.areas[0]).sort()).toEqual(
        ['area', 'cause', 'city', 'message', 'since', 'status'],
      );
    });

    it('coarsens the start time to the minute, not the second', async () => {
      // The exact second reveals the polling cadence and helps nobody.
      const { svc } = makeService({
        areas: [AREAS[0]],
        open: [{ areaId: 1, startedAt: new Date('2026-08-29T10:07:43.512Z'), type: 'UNSCHEDULED', cause: 'POWER_RELATED', causeConfidence: 0.9 }],
      });
      const res = await svc.publicStatus();
      const since = new Date(res.areas[0].since as any);
      expect(since.getSeconds()).toBe(0);
      expect(since.getMilliseconds()).toBe(0);
      expect(since.getMinutes()).toBe(7);
    });

    it('only lists active areas', async () => {
      const { svc, prisma } = makeService({ areas: AREAS });
      await svc.publicStatus();
      expect(prisma.area.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    });
  });

  // ── Not publishing guesses ───────────────────────────────────────────────
  describe('confidence gating', () => {
    const withConfidence = (c: number, cause = 'FIBER_CUT') =>
      makeService({
        areas: [AREAS[0]],
        open: [{ areaId: 1, startedAt: new Date(), type: 'UNSCHEDULED', cause, causeConfidence: c }],
      });

    it('states a confident cause', async () => {
      const res = await withConfidence(0.85).svc.publicStatus();
      expect(res.areas[0].cause).toBe('FIBER_CUT');
      expect(res.areas[0].message.en).toMatch(/fibre fault/i);
    });

    it('WITHHOLDS a low-confidence cause and says it is being investigated', async () => {
      const res = await withConfidence(0.3).svc.publicStatus();
      // Still reported as down — that part is true and useful.
      expect(res.areas[0].status).toBe('OUTAGE');
      // But no cause is claimed.
      expect(res.areas[0].cause).toBeNull();
      expect(res.areas[0].message.en).toMatch(/investigating/i);
    });

    it('treats a missing confidence as not confident', async () => {
      const { svc } = makeService({
        areas: [AREAS[0]],
        open: [{ areaId: 1, startedAt: new Date(), type: 'UNSCHEDULED', cause: 'FIBER_CUT', causeConfidence: null }],
      });
      const res = await svc.publicStatus();
      expect(res.areas[0].cause).toBeNull();
    });
  });

  // ── What the customer actually reads ─────────────────────────────────────
  describe('customer-facing wording', () => {
    it('reports an unaffected area as operational', async () => {
      const { svc } = makeService({ areas: AREAS, open: [] });
      const res = await svc.publicStatus();
      expect(res.areas.every((a: any) => a.status === 'OPERATIONAL')).toBe(true);
      expect(res.areas[0].since).toBeNull();
    });

    it('does not promise a restoration time for a power cut', async () => {
      // The grid coming back is not ours to promise; the wording points at the
      // load-shedding schedule instead of inventing an ETA.
      const { svc } = makeService({
        areas: [AREAS[0]],
        open: [{ areaId: 1, startedAt: new Date(), type: 'SCHEDULED', cause: 'POWER_RELATED', causeConfidence: 0.95 }],
      });
      const res = await svc.publicStatus();
      expect(res.areas[0].message.en).toMatch(/load-shedding schedule/i);
      expect(res.areas[0].message.en).not.toMatch(/\b\d+\s*(minutes|hours)\b/i);
    });

    it('tells the customer someone is on the way for a fault that IS ours', async () => {
      // The call the page is meant to deflect is "when will it be fixed".
      const res = await makeService({
        areas: [AREAS[0]],
        open: [{ areaId: 1, startedAt: new Date(), type: 'UNSCHEDULED', cause: 'FIBER_CUT', causeConfidence: 0.9 }],
      }).svc.publicStatus();
      expect(res.areas[0].message.en).toMatch(/technicians/i);
    });

    it('carries Urdu alongside English for every message', async () => {
      const { svc } = makeService({
        areas: AREAS,
        open: [{ areaId: 1, startedAt: new Date(), type: 'UNSCHEDULED', cause: 'POWER_RELATED', causeConfidence: 0.9 }],
      });
      const res = await svc.publicStatus();
      for (const a of res.areas) {
        expect(typeof a.message.en).toBe('string');
        expect(a.message.ur.length).toBeGreaterThan(0);
      }
    });

    it('puts affected areas first, so a visitor sees the problem immediately', async () => {
      const { svc } = makeService({
        areas: AREAS,
        open: [{ areaId: 2, startedAt: new Date(), type: 'UNSCHEDULED', cause: 'POWER_RELATED', causeConfidence: 0.9 }],
      });
      const res = await svc.publicStatus();
      expect(res.areas[0].area).toBe('Patil Bagh');
      expect(res.areas[0].status).toBe('OUTAGE');
    });

    it('handles a deployment with no areas without throwing', async () => {
      const { svc } = makeService({ areas: [] });
      const res = await svc.publicStatus();
      expect(res.areas).toEqual([]);
    });
  });

  // ── History ──────────────────────────────────────────────────────────────
  describe('publicHistory()', () => {
    it('reports resolved incidents with a duration', async () => {
      const { svc } = makeService({
        history: [{
          startedAt: new Date('2026-08-28T10:00:00Z'),
          endedAt: new Date('2026-08-28T12:30:00Z'),
          cause: 'POWER_RELATED', causeConfidence: 0.9,
          area: { name: 'Bela' },
        }],
      });
      const rows = await svc.publicHistory();
      expect(rows[0]).toMatchObject({ area: 'Bela', cause: 'POWER_RELATED', minutes: 150 });
    });

    it('applies the same confidence gate as the live status', async () => {
      const { svc } = makeService({
        history: [{
          startedAt: new Date('2026-08-28T10:00:00Z'), endedAt: new Date('2026-08-28T10:30:00Z'),
          cause: 'FIBER_CUT', causeConfidence: 0.2, area: { name: 'Bela' },
        }],
      });
      const rows = await svc.publicHistory();
      expect(rows[0].cause).toBeNull();
    });

    it('caps the window so the endpoint cannot be asked for everything', async () => {
      const { svc, prisma } = makeService({ history: [] });
      await svc.publicHistory(9999);
      const since = prisma.powerOutage.findMany.mock.calls[0][0].where.startedAt.gte as Date;
      const days = (Date.now() - since.getTime()) / 86400_000;
      expect(days).toBeLessThanOrEqual(31);
    });
  });
});
