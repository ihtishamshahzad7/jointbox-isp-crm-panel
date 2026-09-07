import { RadiusSyncService } from './radius-sync.service';

/**
 * BULK RADIUS SYNC — CONCURRENCY AND THE N+1.
 *
 * THE ORIGINAL
 *   for (const sub of subscribers) {
 *     const full = await this.resolveFullProfile(sub.username); // 1 DB query
 *     await this.syncSubscriberProfile(...);                    // RADIUS writes
 *   }
 *
 * Two network waits per subscriber, strictly serial. At a measured ~20-50ms
 * per subscriber that is 5.5 to 14 hours for a full 1M-subscriber re-sync,
 * single-threaded, with the process idle for essentially all of it. A full
 * re-sync is a real operational task on this product.
 *
 * TWO COSTS, AND WHY BOTH TESTS ARE HERE
 * Parallelising alone would leave `resolveFullProfile`'s per-subscriber
 * `findUnique` in place and simply point a thousand concurrent single-row
 * lookups at Postgres — faster, and a fresh way to hurt the database. Batching
 * alone would leave the run serial. The suite pins both properties separately
 * so neither can be lost while the other still passes.
 */
describe('RadiusSyncService.bulkSyncSubscribers', () => {
  const REAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...REAL_ENV }; });

  function makeService(count: number, opts: { missing?: string[]; failOn?: string[] } = {}) {
    const missing = new Set(opts.missing ?? []);
    const failOn = new Set(opts.failOn ?? []);

    const subscribers = Array.from({ length: count }, (_, i) => ({
      username: `u${i}`,
      password: `p${i}`,
    }));

    const prisma: any = {
      subscriber: {
        findMany: jest.fn(async ({ where }: any) =>
          where.username.in
            .filter((u: string) => !missing.has(u))
            .map((u: string) => ({
              username: u,
              authMethod: 'PPPOE',
              package: { id: 1, name: '10M' },
              serviceSettings: { ipType: 'DYNAMIC' },
            })),
        ),
        // Present so an accidental return to the per-row path is detectable.
        findUnique: jest.fn(),
      },
    };

    const svc: any = new RadiusSyncService(prisma);
    svc.ensureConnected = jest.fn();

    let inFlight = 0;
    let peak = 0;
    const synced: string[] = [];
    svc.syncSubscriberProfile = jest.fn(async (username: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (failOn.has(username)) throw new Error('radius write failed');
      synced.push(username);
    });

    return { svc, prisma, subscribers, synced, peak: () => peak };
  }

  // ───────────────────────────────────────────────────────────────
  // Cost 1 — the N+1
  // ───────────────────────────────────────────────────────────────
  it('fetches profiles in bulk, not one query per subscriber', async () => {
    process.env.RADIUS_SYNC_CHUNK = '1000';
    const { svc, prisma, subscribers } = makeService(500);
    await svc.bulkSyncSubscribers(subscribers);

    // 500 subscribers, one chunk → exactly one query. The old code issued 500.
    expect(prisma.subscriber.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscriber.findUnique).not.toHaveBeenCalled();
    expect(prisma.subscriber.findMany.mock.calls[0][0].where.username.in).toHaveLength(500);
  });

  it('still includes the relations the RADIUS profile is built from', async () => {
    // Dropping `package` or `serviceSettings` from the batched query would
    // sync every subscriber with no speed limit and no static IP — a silent,
    // estate-wide misconfiguration that looks like a successful run.
    const { svc, prisma, subscribers } = makeService(5);
    await svc.bulkSyncSubscribers(subscribers);
    const include = prisma.subscriber.findMany.mock.calls[0][0].include;
    expect(include.package).toEqual({ include: { pool: true } });
    expect(include.serviceSettings).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────
  // Cost 2 — the serial loop
  // ───────────────────────────────────────────────────────────────
  it('runs RADIUS writes concurrently', async () => {
    process.env.RADIUS_SYNC_CONCURRENCY = '20';
    const { svc, subscribers, peak } = makeService(100);
    await svc.bulkSyncSubscribers(subscribers);

    // The old loop's peak was exactly 1. This is the assertion it fails.
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(20);
  });

  it('respects the configured ceiling rather than flooding the RADIUS pool', async () => {
    // Above the pool's `max`, extra tasks only queue for a connection while
    // holding a connectionTimeoutMillis clock — self-inflicted contention that
    // eventually fails rows for no other reason.
    process.env.RADIUS_SYNC_CONCURRENCY = '5';
    const { svc, subscribers, peak } = makeService(60);
    await svc.bulkSyncSubscribers(subscribers);
    expect(peak()).toBeLessThanOrEqual(5);
  });

  // ───────────────────────────────────────────────────────────────
  // Correctness must survive the speed-up
  // ───────────────────────────────────────────────────────────────
  it('syncs every subscriber exactly once', async () => {
    // A pool with an off-by-one in its index handling either skips rows or
    // syncs some twice, and both look like success in the tally.
    process.env.RADIUS_SYNC_CONCURRENCY = '7';
    const { svc, subscribers, synced } = makeService(53);
    const r = await svc.bulkSyncSubscribers(subscribers);

    expect(r).toEqual({ total: 53, success: 53, failed: 0 });
    expect(new Set(synced).size).toBe(53);
  });

  it('spans multiple chunks correctly', async () => {
    // The chunk boundary is where a batching bug hides: rows in chunk 2 built
    // from chunk 1's lookup map would be synced with the wrong profile.
    process.env.RADIUS_SYNC_CHUNK = '10';
    process.env.RADIUS_SYNC_CONCURRENCY = '3';
    const { svc, prisma, subscribers, synced } = makeService(35);
    const r = await svc.bulkSyncSubscribers(subscribers);

    expect(prisma.subscriber.findMany).toHaveBeenCalledTimes(4); // 10+10+10+5
    expect(r.success).toBe(35);
    expect(new Set(synced).size).toBe(35);
  });

  it('counts a subscriber deleted mid-run as failed, not as success', async () => {
    // Present in the input, absent from the batched lookup. Treating a missing
    // row as "nothing to do" would report a clean run while leaving that
    // subscriber unsynced in RADIUS — exactly the inconsistency a re-sync is
    // performed to eliminate.
    const { svc, subscribers } = makeService(10, { missing: ['u3', 'u7'] });
    const r = await svc.bulkSyncSubscribers(subscribers);
    expect(r).toEqual({ total: 10, success: 8, failed: 2 });
  });

  it('one failed write does not abort the run', async () => {
    // `Promise.all` over raw promises would reject on the first failure and
    // abandon the remaining subscribers. The failure is per-task on purpose.
    const { svc, subscribers, synced } = makeService(20, { failOn: ['u5'] });
    const r = await svc.bulkSyncSubscribers(subscribers);
    expect(r).toEqual({ total: 20, success: 19, failed: 1 });
    expect(synced).not.toContain('u5');
  });

  it('reports progress as it goes', async () => {
    // A multi-hour job with no progress is indistinguishable from a hung one,
    // and the operator's only recourse is to restart it from the beginning.
    process.env.RADIUS_SYNC_CHUNK = '10';
    process.env.RADIUS_SYNC_CONCURRENCY = '5';
    const { svc, subscribers } = makeService(30);
    const seen: Array<[number, number]> = [];
    await svc.bulkSyncSubscribers(subscribers, (done: number, total: number) => seen.push([done, total]));
    expect(seen).toEqual([[10, 30], [20, 30], [30, 30]]);
  });

  it('never lets the chunk be smaller than the concurrency', async () => {
    // Workers are `min(CONCURRENCY, chunk.length)`, so a chunk below the
    // concurrency silently throttles the run — RADIUS_SYNC_CHUNK=1 with
    // CONCURRENCY=20 would look configured for parallelism and execute
    // strictly serially, which is the performance bug being fixed, restored
    // by a config value. The clamp makes that unreachable.
    process.env.RADIUS_SYNC_CHUNK = '2';
    process.env.RADIUS_SYNC_CONCURRENCY = '10';
    const { svc, subscribers, peak } = makeService(40);
    await svc.bulkSyncSubscribers(subscribers);
    expect(peak()).toBeGreaterThan(2);
  });

  it('handles an empty list without querying anything', async () => {
    const { svc, prisma } = makeService(0);
    const r = await svc.bulkSyncSubscribers([]);
    expect(r).toEqual({ total: 0, success: 0, failed: 0 });
    expect(prisma.subscriber.findMany).not.toHaveBeenCalled();
  });

  it('the single-subscriber path builds an identical profile', async () => {
    // Bulk and single share `profileFromRow`. If they ever diverge, the first
    // symptom is subscribers synced with a different service type depending on
    // which code path touched them — so the shared mapping is pinned here.
    const { svc } = makeService(1);
    const row = {
      authMethod: 'STATIC',
      package: { id: 1 },
      serviceSettings: { ipType: 'STATIC', ipAddress: '10.0.0.9', allowMultipleSessions: true },
    };
    const p = svc.profileFromRow(row);
    expect(p.opts.staticIp).toBe('10.0.0.9');
    expect(p.opts.serviceType).toBe('STATIC');
    expect(p.opts.allowMultipleSessions).toBe(true);
  });

  it('does not hand a static IP to a dynamic subscriber', async () => {
    // A stale ipAddress on a subscriber since moved to a pool would pin them
    // to an address that belongs to somebody else.
    const { svc } = makeService(1);
    const p = svc.profileFromRow({
      authMethod: 'PPPOE',
      package: null,
      serviceSettings: { ipType: 'DYNAMIC', ipAddress: '10.0.0.9' },
    });
    expect(p.opts.staticIp).toBeNull();
  });
});
