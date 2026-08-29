import { OutageClassifierService } from './outage-classifier.service';

/**
 * OUTAGE CAUSE CLASSIFICATION.
 *
 * detect() already found outages and matched them against the load-shedding
 * timetable. What it could not answer was WHY the area was down — its note
 * ended "verify whether this is power or network", which is the question that
 * decides whether anyone drives out. This service answers it from telemetry
 * the ONUs already send.
 *
 * THE TWO DECISIVE SIGNALS
 *   DYING_GASP — an ONU's final transmission as its mains supply collapses.
 *     If ONUs are gasping, the premises lost POWER. Not a heuristic.
 *   LOS — the optical carrier is gone while the ONU still had power to say so.
 *     That is the FIBRE.
 *
 * THE RULE THESE TESTS EXIST TO PROTECT: never guess. A wrong cause is worse
 * than no cause, because it sends a technician to dig up a road during a
 * load-shedding slot. Where signals are absent or conflict, the answer must be
 * UNKNOWN with low confidence — not a plausible-sounding invention.
 */
describe('OutageClassifierService', () => {
  /**
   * The service issues three independent raw queries: optical states, devices
   * down, sibling areas. They are routed by matching the SQL text so the tests
   * do not depend on call ordering.
   */
  function makeService(signals: {
    optical?: Array<{ status: string; n: number }>;
    devicesDown?: number;
    siblingAreas?: number;
    opticalThrows?: boolean;
  }) {
    const prisma: any = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        if (sql.includes('onu_telemetry')) {
          if (signals.opticalThrows) return Promise.reject(new Error('relation does not exist'));
          return Promise.resolve(signals.optical ?? []);
        }
        if (sql.includes('NetworkDevice')) {
          return Promise.resolve([{ n: signals.devicesDown ?? 0 }]);
        }
        if (sql.includes('PowerOutage')) {
          return Promise.resolve([{ n: signals.siblingAreas ?? 0 }]);
        }
        return Promise.resolve([]);
      }),
    };
    return new OutageClassifierService(prisma);
  }

  // ── The decisive signals ───────────────────────────────────────────────
  describe('dying gasp means power', () => {
    it('classifies a dying gasp as POWER_RELATED with high confidence', async () => {
      const svc = makeService({ optical: [{ status: 'DYING_GASP', n: 8 }] });
      const v = await svc.classify(1);
      expect(v.cause).toBe('POWER_RELATED');
      expect(v.confidence).toBeGreaterThanOrEqual(0.9);
      expect(v.reasons.join(' ')).toMatch(/dying gasp/i);
    });

    it('is even more confident when the timetable agrees', async () => {
      const unscheduled = await makeService({ optical: [{ status: 'DYING_GASP', n: 8 }] }).classify(1);
      const scheduled = await makeService({ optical: [{ status: 'DYING_GASP', n: 8 }] })
        .classify(1, { scheduled: true });
      expect(scheduled.confidence).toBeGreaterThan(unscheduled.confidence);
      expect(scheduled.cause).toBe('POWER_RELATED');
    });

    it('still says POWER even OUTSIDE a load-shedding window — the gasp is the evidence', async () => {
      // An unscheduled power cut is still a power cut. Deferring to the
      // timetable here would report a fibre fault that does not exist.
      const svc = makeService({ optical: [{ status: 'DYING_GASP', n: 5 }] });
      const v = await svc.classify(1, { scheduled: false });
      expect(v.cause).toBe('POWER_RELATED');
      expect(v.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('loss of signal means fibre', () => {
    it('classifies LOS with no gasp as FIBER_CUT', async () => {
      const svc = makeService({ optical: [{ status: 'LOS', n: 6 }] });
      const v = await svc.classify(2);
      expect(v.cause).toBe('FIBER_CUT');
      expect(v.confidence).toBeGreaterThanOrEqual(0.8);
      expect(v.reasons.join(' ')).toMatch(/still had power/i);
    });

    it('prefers EQUIPMENT_FAILURE when a dark device explains the LOS', async () => {
      // ONUs downstream of a dead OLT report LOS without any fibre being cut.
      const svc = makeService({ optical: [{ status: 'LOS', n: 6 }], devicesDown: 1 });
      const v = await svc.classify(2);
      expect(v.cause).toBe('EQUIPMENT_FAILURE');
    });

    it('lets a dying gasp outrank LOS when both appear', async () => {
      // Mixed estate: some premises lost mains, some ONUs then saw no light.
      // Power is the root cause and the one that dictates the response.
      const svc = makeService({ optical: [{ status: 'DYING_GASP', n: 4 }, { status: 'LOS', n: 9 }] });
      const v = await svc.classify(1);
      expect(v.cause).toBe('POWER_RELATED');
    });
  });

  // ── Wider-scope evidence ───────────────────────────────────────────────
  describe('several areas at once', () => {
    it('calls it UPSTREAM_ISP when independent areas drop together', async () => {
      const svc = makeService({ siblingAreas: 3 });
      const v = await svc.classify(1);
      expect(v.cause).toBe('UPSTREAM_ISP');
      expect(v.reasons.join(' ')).toMatch(/other areas dropped/i);
    });

    it('does NOT call load shedding an upstream fault', async () => {
      // Load shedding is regional by nature, so simultaneous areas are exactly
      // what it looks like. Reporting a transit fault here would send the NOC
      // chasing the wrong thing every single evening.
      const svc = makeService({ siblingAreas: 4 });
      const v = await svc.classify(1, { scheduled: true });
      expect(v.cause).toBe('POWER_RELATED');
      expect(v.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('ignores a single other area as coincidence', async () => {
      const svc = makeService({ siblingAreas: 1, optical: [{ status: 'LOS', n: 3 }] });
      const v = await svc.classify(1);
      expect(v.cause).toBe('FIBER_CUT');
    });
  });

  // ── Refusing to guess ──────────────────────────────────────────────────
  describe('when nothing is conclusive', () => {
    it('returns UNKNOWN with low confidence rather than inventing a cause', async () => {
      const svc = makeService({ optical: [{ status: 'ONLINE', n: 4 }] });
      const v = await svc.classify(3, { scheduled: false });
      expect(v.cause).toBe('UNKNOWN');
      expect(v.confidence).toBeLessThan(0.5);
    });

    it('returns UNKNOWN when there is no optical estate at all', async () => {
      const svc = makeService({ optical: [] });
      const v = await svc.classify(3, { scheduled: false });
      expect(v.cause).toBe('UNKNOWN');
      expect(v.reasons.join(' ')).toMatch(/no optical telemetry/i);
    });

    it('falls back to the timetable ALONE only at moderate confidence', async () => {
      // The schedule says the power should be off, not that it is. A fibre cut
      // during a load-shedding slot looks identical, so this must not claim
      // the certainty a dying gasp would.
      const svc = makeService({ optical: [] });
      const v = await svc.classify(3, { scheduled: true });
      expect(v.cause).toBe('POWER_RELATED');
      expect(v.confidence).toBeLessThan(0.8);
      expect(v.confidence).toBeGreaterThan(0.4);
    });

    it('survives a deployment with no optical tables at all', async () => {
      // Not every ISP runs fibre. A missing signal must degrade, not throw —
      // an unclassified outage still beats no outage record.
      const svc = makeService({ opticalThrows: true, devicesDown: 0 });
      const v = await svc.classify(1, { scheduled: false });
      expect(v.cause).toBe('UNKNOWN');
      expect(v.confidence).toBeLessThan(0.5);
    });

    it('still uses equipment state when optical is unavailable', async () => {
      const svc = makeService({ opticalThrows: true, devicesDown: 2 });
      const v = await svc.classify(1);
      expect(v.cause).toBe('EQUIPMENT_FAILURE');
    });
  });

  // ── How the verdict is worded ──────────────────────────────────────────
  describe('describe()', () => {
    const svc = () => makeService({});

    it('states a high-confidence verdict plainly', () => {
      const s = svc().describe({ cause: 'POWER_RELATED', confidence: 0.95, reasons: ['dying gasp'] });
      expect(s).toMatch(/^Likely a power failure —/);
      expect(s).not.toMatch(/probable|unconfirmed/);
    });

    it('hedges a middling verdict', () => {
      const s = svc().describe({ cause: 'FIBER_CUT', confidence: 0.6, reasons: ['LOS'] });
      expect(s).toMatch(/probable/);
    });

    it('marks a weak verdict unconfirmed, so nobody acts on it as fact', () => {
      const s = svc().describe({ cause: 'UNKNOWN', confidence: 0.2, reasons: ['no telemetry'] });
      expect(s).toMatch(/unconfirmed/);
    });

    it('always carries the reasons, so the operator can judge it', () => {
      const s = svc().describe({
        cause: 'POWER_RELATED', confidence: 0.9,
        reasons: ['8 ONUs sent a dying gasp', 'inside a published load-shedding window'],
      });
      expect(s).toContain('8 ONUs sent a dying gasp');
      expect(s).toContain('load-shedding window');
    });
  });
});
