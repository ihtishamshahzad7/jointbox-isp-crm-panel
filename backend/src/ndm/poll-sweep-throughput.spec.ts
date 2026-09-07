import { NdmPortPollingService } from './port-polling.service';

/**
 * SNMP POLL SWEEP THROUGHPUT.
 *
 * THE CEILING THIS REMOVES
 * The sweep took `.slice(0, 40)` of the due devices and walked them in serial
 * batches of 8 on a 5-second timer. That is 40 devices per tick — 8 per second
 * at best, and only if every poll returns instantly. At 1,000 NAS on a 30s
 * interval the system needs ~33 per second sustained merely to visit each
 * device once per interval, so it was roughly 4× short before any real network
 * latency was involved.
 *
 * The devices past the cap were not delayed. They were dropped for that tick,
 * with no counter and no log line, and the dashboard went on showing their
 * last known state — which looks exactly like a healthy device.
 *
 * WHY THE HEAD-OF-LINE TEST IS THE IMPORTANT ONE
 * `Promise.all` over a chunk of 8 waits for the slowest member, so a single
 * unreachable device burning its full `snmpTimeoutMs × snmpRetries` held seven
 * healthy devices hostage. Raising the batch size would NOT have fixed this;
 * only replacing chunking with a pool does, because a pool slot is refilled
 * the instant it frees rather than at the end of a chunk. That property is
 * what the third test pins, and it is the one a well-meaning "just make BATCH
 * bigger" change would silently lose.
 */
describe('NdmPortPollingService — sweep throughput', () => {
  const REAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...REAL_ENV };
    jest.useRealTimers();
  });

  /**
   * Builds a service with `count` devices, all due, and a pollDevice stub that
   * takes `latency(i)` ms. Returns the polled order and concurrency high-water
   * mark, which is what all of these assertions are really about.
   */
  function makeService(count: number, latency: (i: number) => number = () => 0) {
    const devices = Array.from({ length: count }, (_, i) => ({
      id: i,
      name: `dev${i}`,
      pollIntervalSec: 30,
    }));
    const prisma: any = { networkDevice: { findMany: jest.fn().mockResolvedValue(devices) } };

    const svc: any = new NdmPortPollingService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any,
    );

    const polled: number[] = [];
    let inFlight = 0;
    let peak = 0;
    svc.pollDevice = jest.fn(async (d: any) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, latency(d.id)));
      polled.push(d.id);
      inFlight--;
    });

    // isPrimaryInstance() gates the sweep; `last` empty means everything is due.
    return { svc, polled, peak: () => peak };
  }

  const runTick = (svc: any) => svc.tick();

  beforeEach(() => {
    // The sweep only runs on the primary instance.
    process.env.PM2_INSTANCE_ID = '0';
    process.env.NODE_APP_INSTANCE = '0';
  });

  it('polls every due device — no 40-device cap', async () => {
    process.env.SNMP_POLL_CONCURRENCY = '50';
    const { svc, polled } = makeService(300);
    await runTick(svc);

    // The old code returned exactly 40 here and reported nothing about the
    // other 260. This is the assertion that fails against it.
    expect(polled.length).toBe(300);
    expect(svc.health.lastSweepDue).toBe(300);
    expect(svc.health.lastSweepPolled).toBe(300);
    expect(svc.health.lastSweepSkipped).toBe(0);
  });

  it('honours the configured concurrency ceiling', async () => {
    // A pool that ignores its own limit is a thundering herd against 1,000
    // network devices and the RADIUS box behind them.
    process.env.SNMP_POLL_CONCURRENCY = '10';
    const { svc, peak } = makeService(100, () => 5);
    await runTick(svc);

    expect(peak()).toBeLessThanOrEqual(10);
    expect(peak()).toBeGreaterThan(1); // and it really is concurrent
  });

  it('one slow device does not stall the devices behind it', async () => {
    /**
     * THE HEAD-OF-LINE TEST.
     *
     * Device 0 takes 300ms; every other device takes 1ms. With a pool of 4,
     * the three free slots keep draining the queue while device 0 sits on its
     * timeout, so device 0 finishes LAST despite starting first.
     *
     * Under the old batch-of-8 code, devices 1-7 would have completed but
     * devices 8+ could not start until device 0 returned — the whole estate
     * paced by its worst link.
     */
    process.env.SNMP_POLL_CONCURRENCY = '4';
    const { svc, polled } = makeService(40, (i) => (i === 0 ? 300 : 1));
    await runTick(svc);

    expect(polled.length).toBe(40);
    expect(polled[polled.length - 1]).toBe(0);
    // Everything else got through while device 0 was still blocked.
    expect(polled.indexOf(39)).toBeLessThan(polled.indexOf(0));
  });

  it('reports what it could not reach instead of dropping it silently', async () => {
    // The whole point: falling behind must be VISIBLE. A tiny budget forces
    // the sweep to give up part-way, and `lastSweepSkipped` is the number an
    // operator alerts on.
    process.env.SNMP_POLL_CONCURRENCY = '1';
    process.env.SNMP_SWEEP_BUDGET_MS = '1000';
    const { svc, polled } = makeService(200, () => 30);
    await runTick(svc);

    expect(polled.length).toBeLessThan(200);
    expect(svc.health.lastSweepSkipped).toBeGreaterThan(0);
    expect(svc.health.lastSweepPolled + svc.health.lastSweepSkipped).toBe(200);
  });

  it('exposes per-poll duration percentiles', async () => {
    // "Polling is slow" is not actionable; "p95 is 200ms" is. These are the
    // numbers that tell an operator whether the pool is too small or a few
    // devices are simply unreachable.
    process.env.SNMP_POLL_CONCURRENCY = '5';
    const { svc } = makeService(20, (i) => (i < 2 ? 60 : 1));
    await runTick(svc);

    const d = svc.health.pollDurationMs;
    expect(d.max).toBeGreaterThanOrEqual(50);
    expect(d.p50).toBeLessThan(d.max);
  });

  it('does not poll anything when no device is due', async () => {
    process.env.SNMP_POLL_CONCURRENCY = '10';
    const { svc, polled } = makeService(10);
    // Mark all as polled a moment ago; their 30s interval has not elapsed.
    for (let i = 0; i < 10; i++) svc.last.set(i, Date.now());
    await runTick(svc);

    expect(polled.length).toBe(0);
    expect(svc.health.lastSweepDue).toBe(0);
    expect(svc.health.lastSweepSkipped).toBe(0);
  });

  it('a failing device is counted, not fatal to the sweep', async () => {
    process.env.SNMP_POLL_CONCURRENCY = '5';
    const { svc } = makeService(10);
    svc.pollDevice = jest.fn(async (d: any) => {
      if (d.id === 3) throw new Error('unreachable');
    });
    await expect(runTick(svc)).resolves.not.toThrow();
    // It still counts as attempted — the sweep visited it and got an answer.
    expect(svc.health.lastSweepPolled).toBe(10);
  });
});
