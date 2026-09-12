import {
  appendReading,
  toRatePoints,
  achievedResolution,
  buildWindow,
  LiveTrafficService,
  Reading,
} from './live-traffic.service';

/**
 * WHAT THESE TESTS ARE PROTECTING
 *
 * The old chart drew nothing because `radacct` keeps one mutable row per
 * session — there was never a series to plot. The obvious fix (sample on every
 * poll) produces something worse than nothing: with a 300-second interim
 * interval and 5-second polling, 59 of every 60 readings are identical, so the
 * graph shows a flat line at zero followed by a single enormous spike. An
 * operator reading that would conclude the subscriber was idle for five
 * minutes and then burst — when in fact they were downloading steadily the
 * whole time.
 *
 * So the tests below are mostly about what must NOT be plotted.
 */

const R = (
  at: number,
  up: number,
  down: number,
  sessionKey = 'S1',
  source: Reading['source'] = 'radius',
): Reading => ({ at, uploadBytes: up, downloadBytes: down, sessionKey, source });

// ───────────────────────────────────────────────────────────────────────────
// Appending readings
// ───────────────────────────────────────────────────────────────────────────

describe('appendReading', () => {
  it('adds the first reading', () => {
    const out = appendReading([], R(1000, 100, 200));
    expect(out).toHaveLength(1);
  });

  it('THE KEY CASE: a counter that has not moved is not appended', () => {
    // This is every poll that lands between two RADIUS interim updates.
    const ring = [R(1000, 100, 200)];
    const out = appendReading(ring, R(1000, 100, 200));

    expect(out).toHaveLength(1);
    // Same reference, so the caller skips a pointless Redis write.
    expect(out).toBe(ring);
  });

  it('appends when the counter advances', () => {
    const ring = [R(1000, 100, 200)];
    const out = appendReading(ring, R(6000, 500, 900));
    expect(out).toHaveLength(2);
  });

  it('appends when only the timestamp advances, even at identical bytes', () => {
    // A genuinely idle subscriber: the interim landed, the counters did not
    // move. That IS a real zero-rate reading and belongs on the graph.
    const ring = [R(1000, 100, 200)];
    const out = appendReading(ring, R(301000, 100, 200));
    expect(out).toHaveLength(2);
  });

  it('replaces rather than grows when bytes change at the same timestamp', () => {
    const ring = [R(1000, 100, 200)];
    const out = appendReading(ring, R(1000, 150, 250));
    expect(out).toHaveLength(1);
    expect(out[0].uploadBytes).toBe(150);
  });

  it('appends across a session change even with identical counters', () => {
    // Reconnect: counters restart at zero, which by value alone looks like
    // "nothing happened". The session key is what distinguishes them.
    const ring = [R(1000, 0, 0, 'S1')];
    const out = appendReading(ring, R(2000, 0, 0, 'S2'));
    expect(out).toHaveLength(2);
  });

  it('is bounded — a long watch cannot grow without limit', () => {
    let ring: Reading[] = [];
    for (let i = 0; i < 500; i++) {
      ring = appendReading(ring, R(i * 5000, i * 1000, i * 2000));
    }
    expect(ring.length).toBeLessThanOrEqual(150);
    // And it keeps the NEWEST readings, not the oldest.
    expect(ring[ring.length - 1].uploadBytes).toBe(499 * 1000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Turning readings into rates
// ───────────────────────────────────────────────────────────────────────────

describe('toRatePoints', () => {
  it('needs two readings to make one point', () => {
    expect(toRatePoints([])).toEqual([]);
    expect(toRatePoints([R(1000, 0, 0)])).toEqual([]);
    expect(toRatePoints([R(0, 0, 0), R(1000, 100, 200)])).toHaveLength(1);
  });

  it('divides by the COUNTER span, not the poll interval', () => {
    // 1 MB uploaded over 10 seconds = 800,000 bits/sec.
    const points = toRatePoints([R(0, 0, 0), R(10_000, 1_000_000, 0)]);
    expect(points[0].uploadBps).toBe(800_000);
    expect(points[0].spanSeconds).toBe(10);
  });

  it('reports bits per second, not bytes', () => {
    const points = toRatePoints([R(0, 0, 0), R(1000, 1000, 2000)]);
    expect(points[0].uploadBps).toBe(8000);
    expect(points[0].downloadBps).toBe(16000);
  });

  it('THE MISLEADING GRAPH: a 300s interim yields one honest point, not 60 fake ones', () => {
    // Simulate 5-second polling across a 300-second interim window. A naive
    // implementation appends 60 readings and plots 59 zeros plus a spike.
    let ring: Reading[] = [];
    for (let poll = 0; poll <= 60; poll++) {
      // The counter only refreshes at t=0 and t=300.
      const counterAt = poll * 5 < 300 ? 0 : 300_000;
      const bytes = counterAt === 0 ? 0 : 37_500_000; // 1 Mbps for 300s
      ring = appendReading(ring, R(counterAt, bytes, 0));
    }

    const points = toRatePoints(ring);

    expect(ring).toHaveLength(2);
    expect(points).toHaveLength(1);
    expect(points[0].uploadBps).toBe(1_000_000); // a steady 1 Mbps, correctly
    expect(points[0].spanSeconds).toBe(300);

    // And critically: no zero-rate points were invented in between.
    expect(points.filter((p) => p.uploadBps === 0)).toHaveLength(0);
  });

  it('does not draw a rate across a reconnect', () => {
    // Counters restart at 0 on the new session. Without the session check this
    // is a large negative delta — clamped to zero it would silently hide the
    // reconnect and show a fake idle period.
    const points = toRatePoints([
      R(0, 5_000_000, 9_000_000, 'S1'),
      R(5000, 0, 0, 'S2'),
      R(10_000, 1_000_000, 2_000_000, 'S2'),
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].at).toBe(10_000);
    expect(points[0].uploadBps).toBe(1_600_000);
  });

  it('skips a backwards counter inside one session', () => {
    // A router that reset its interface counters mid-session.
    const points = toRatePoints([
      R(0, 5_000_000, 0, 'S1'),
      R(5000, 1_000, 0, 'S1'),
    ]);
    expect(points).toHaveLength(0);
  });

  it('ignores a zero or negative time span', () => {
    expect(toRatePoints([R(5000, 0, 0), R(5000, 100, 0)])).toHaveLength(0);
    expect(toRatePoints([R(5000, 0, 0), R(1000, 100, 0)])).toHaveLength(0);
  });

  it('plots a genuinely idle subscriber as zero, not as a gap', () => {
    const points = toRatePoints([R(0, 1000, 2000), R(60_000, 1000, 2000)]);
    expect(points).toHaveLength(1);
    expect(points[0].uploadBps).toBe(0);
    expect(points[0].downloadBps).toBe(0);
  });

  it('handles a realistic MikroTik series at 5-second resolution', () => {
    // 2 Mbps down, 500 kbps up, sampled every 5s.
    const ring: Reading[] = [];
    for (let i = 0; i <= 12; i++) {
      ring.push(R(i * 5000, i * 312_500, i * 1_250_000, 'S1', 'mikrotik'));
    }
    const points = toRatePoints(ring);
    expect(points).toHaveLength(12);
    for (const p of points) {
      expect(p.uploadBps).toBe(500_000);
      expect(p.downloadBps).toBe(2_000_000);
      expect(p.spanSeconds).toBe(5);
    }
  });
});

describe('achievedResolution', () => {
  it('is null with nothing to measure', () => {
    expect(achievedResolution([])).toBeNull();
  });

  it('reports the median gap, so one slow poll does not skew it', () => {
    const points = toRatePoints([
      R(0, 0, 0), R(5000, 100, 0), R(10_000, 200, 0),
      R(90_000, 300, 0), R(95_000, 400, 0),
    ]);
    expect(achievedResolution(points)).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The window the API returns
// ───────────────────────────────────────────────────────────────────────────

describe('buildWindow', () => {
  const now = () => Date.now();

  it('keeps one reading from before the window so the leading edge survives', () => {
    const t = now();
    const ring = [
      R(t - 310_000, 0, 0),          // outside a 5-minute window
      R(t - 290_000, 1_000_000, 0),  // inside
      R(t - 100_000, 2_000_000, 0),
    ];
    const w = buildWindow('ali', ring, 300, ring[ring.length - 1]);

    // Without the lead-in reading, the first in-window point would be lost.
    expect(w.points.length).toBe(2);
  });

  it('marks a subscriber offline when the source returned nothing', () => {
    const w = buildWindow('ali', [], 300, null);
    expect(w.online).toBe(false);
    expect(w.points).toEqual([]);
    expect(w.notice).toContain('not online');
  });

  it('still shows the last readings after a session ends', () => {
    const t = now();
    const ring = [R(t - 60_000, 0, 0), R(t - 30_000, 1_000_000, 0)];
    const w = buildWindow('ali', ring, 300, null);
    expect(w.online).toBe(false);
    expect(w.points).toHaveLength(1);
    expect(w.notice).toContain('before the session ended');
  });

  it('says it is collecting rather than showing an empty chart', () => {
    const t = now();
    const first = R(t, 0, 0);
    const w = buildWindow('ali', [first], 300, first);
    expect(w.points).toEqual([]);
    expect(w.notice).toContain('Collecting');
  });

  it('explains a coarse line instead of letting it look broken', () => {
    // 300-second interim: two readings five minutes apart.
    const t = now();
    const ring = [R(t - 300_000, 0, 0), R(t, 37_500_000, 0)];
    const w = buildWindow('ali', ring, 600, ring[1]);

    expect(w.points).toHaveLength(1);
    expect(w.resolutionSeconds).toBe(300);
    expect(w.notice).toContain('interim-update');
    // The operator is told the fix, not just the symptom.
    expect(w.notice).toContain('Acct-Interim-Interval');
  });

  it('says nothing when a router feed is already fine-grained', () => {
    const t = now();
    const ring: Reading[] = [];
    for (let i = 10; i >= 0; i--) {
      ring.push(R(t - i * 5000, (10 - i) * 312_500, 0, 'S1', 'mikrotik'));
    }
    const w = buildWindow('ali', ring, 300, ring[ring.length - 1]);
    expect(w.source).toBe('mikrotik');
    expect(w.resolutionSeconds).toBe(5);
    expect(w.notice).toBeNull();
  });

  it('reports the latest rate and the session totals', () => {
    const t = now();
    const ring = [R(t - 5000, 0, 0), R(t, 625_000, 1_250_000)];
    const w = buildWindow('ali', ring, 300, ring[1]);
    expect(w.latest).toEqual({ uploadBps: 1_000_000, downloadBps: 2_000_000 });
    expect(w.totals).toEqual({ uploadBytes: 625_000, downloadBytes: 1_250_000 });
  });

  it('drops points older than the window', () => {
    const t = now();
    const ring: Reading[] = [];
    for (let i = 120; i >= 0; i--) {
      ring.push(R(t - i * 5000, (120 - i) * 100_000, 0));
    }
    const w = buildWindow('ali', ring, 60, ring[ring.length - 1]);
    for (const p of w.points) {
      expect(p.at).toBeGreaterThanOrEqual(t - 61_000);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The service
// ───────────────────────────────────────────────────────────────────────────

describe('LiveTrafficService', () => {
  function cacheStub() {
    const store = new Map<string, unknown>();
    return {
      store,
      writes: 0,
      async get<T>(k: string): Promise<T | null> {
        return (store.get(k) as T) ?? null;
      },
      async set(k: string, v: unknown) {
        (this as any).writes++;
        store.set(k, JSON.parse(JSON.stringify(v)));
      },
      async del(...keys: string[]) {
        keys.forEach((k) => store.delete(k));
      },
    };
  }

  it('accumulates a series across polls', async () => {
    const cache = cacheStub();
    const svc = new LiveTrafficService(cache as any);

    const t = Date.now();
    for (let i = 0; i < 4; i++) {
      await svc.sample('ali', 300, async () =>
        R(t + i * 5000, i * 625_000, 0, 'S1', 'mikrotik'),
      );
    }

    const out = await svc.sample('ali', 300, async () =>
      R(t + 4 * 5000, 4 * 625_000, 0, 'S1', 'mikrotik'),
    );

    expect(out.points).toHaveLength(4);
    expect(out.points.every((p) => p.uploadBps === 1_000_000)).toBe(true);
  });

  it('does not write to the cache when the counter has not moved', async () => {
    const cache = cacheStub();
    const svc = new LiveTrafficService(cache as any);
    const fixed = R(1000, 500, 900, 'S1', 'radius');

    await svc.sample('ali', 300, async () => fixed);
    const afterFirst = (cache as any).writes;

    // 20 more polls between interim updates — the common case at 300s interim.
    for (let i = 0; i < 20; i++) {
      await svc.sample('ali', 300, async () => fixed);
    }

    expect((cache as any).writes).toBe(afterFirst);
  });

  it('survives a reader that throws, and still returns history', async () => {
    const cache = cacheStub();
    const svc = new LiveTrafficService(cache as any);
    const t = Date.now();

    await svc.sample('ali', 300, async () => R(t - 10_000, 0, 0));
    await svc.sample('ali', 300, async () => R(t - 5000, 625_000, 0));

    const out = await svc.sample('ali', 300, async () => {
      throw new Error('router unreachable');
    });

    expect(out.online).toBe(false);
    expect(out.points).toHaveLength(1); // history preserved
  });

  it('reset clears the buffer', async () => {
    const cache = cacheStub();
    const svc = new LiveTrafficService(cache as any);

    await svc.sample('ali', 300, async () => R(1000, 0, 0));
    await svc.reset('ali');
    const out = await svc.sample('ali', 300, async () => null);

    expect(out.points).toEqual([]);
  });

  it('is keyed case-insensitively, matching RADIUS username handling', async () => {
    const cache = cacheStub();
    const svc = new LiveTrafficService(cache as any);
    const t = Date.now();

    await svc.sample('Ali', 300, async () => R(t - 5000, 0, 0));
    const out = await svc.sample('ali', 300, async () => R(t, 625_000, 0));

    expect(out.points).toHaveLength(1);
  });
});
