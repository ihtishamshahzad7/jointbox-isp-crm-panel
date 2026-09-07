import { DatabaseSetupService } from './database-setup.service';

/**
 * radacct ARCHIVAL.
 *
 * THREE SEPARATE DEFECTS, ONE FUNCTION
 *
 * 1. ONE GIANT TRANSACTION. `archive_radacct` deleted every expired row in a
 *    single statement. At 100k subscribers that is fine; at 1M with a 600s
 *    interim interval, radacct accrues tens of millions of closed rows a
 *    month, and one transaction over that holds row locks for the whole run
 *    while FreeRADIUS is still writing accounting, accumulates the entire
 *    delete+insert in WAL before anything commits, blocks autovacuum from
 *    reclaiming any of it, and — if it fails at 95% — rolls the lot back and
 *    keeps no progress at all.
 *
 * 2. IT RAN ON EVERY WORKER. The caller is a `setInterval` in
 *    NetworkLogsService, which exists in every backend process. Under PM2
 *    cluster mode that is N copies of the same sweep against the same rows,
 *    contending rather than cooperating — the job got slower the more
 *    hardware you gave it. Every other cron in this codebase gates on
 *    `isPrimaryInstance()`; this one never did.
 *
 * 3. NO BOUND ON A FIRST RUN. Months of accumulated backlog would run for
 *    hours with no way to stop cleanly.
 *
 * WHY THE SQL IS NOT TESTED HERE
 * The batch function's correctness is a database property — SKIP LOCKED
 * semantics, the partial index, concurrent safety — and a mocked Prisma proves
 * none of it. It was verified against a real PostgreSQL 16: four concurrent
 * workers, no deadlocks, 60,000 eligible rows archived exactly once each
 * (`count = count(DISTINCT radacctid)`), all open sessions untouched, and
 * `EXPLAIN ANALYZE` confirming the partial index is used rather than a
 * sequential scan per batch. These tests cover the DRIVER: the loop, the gate,
 * and the budget.
 */
describe('DatabaseSetupService — radacct archival', () => {
  const REAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...REAL_ENV }; });

  /** Prisma stub whose batch function drains `available` rows, batchSize at a time. */
  function makeService(available: number) {
    let left = available;
    const calls: Array<{ retainDays: number; batchSize: number }> = [];

    const prisma: any = {
      $queryRaw: jest.fn(async (_strings: any, retainDays: number, batchSize: number) => {
        calls.push({ retainDays, batchSize });
        const n = Math.min(left, batchSize);
        left -= n;
        return [{ moved: n }];
      }),
    };
    const svc = new DatabaseSetupService(prisma);
    return { svc, prisma, calls, remaining: () => left };
  }

  beforeEach(() => {
    // Default to "this process is the primary" so the gate is not what is
    // being tested except where it is.
    process.env.NODE_APP_INSTANCE = '0';
    delete process.env.JOINTBOX_ROLE;
    delete process.env.CRON_DISABLED;
  });

  // ───────────────────────────────────────────────────────────────
  // Batching
  // ───────────────────────────────────────────────────────────────
  it('drains the backlog in batches rather than one statement', async () => {
    process.env.RADACCT_ARCHIVE_BATCH = '1000';
    const { svc, calls } = makeService(4_500);
    const r: any = await svc.archiveOldSessions(90);

    expect(r.moved).toBe(4_500);
    // 4 full batches + 1 partial + 1 empty probe that ends the loop.
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.batchSize === 1000)).toBe(true);
  });

  it('keeps looping past a SHORT batch, stopping only at zero', async () => {
    /**
     * THE SUBTLE ONE. `SKIP LOCKED` can return fewer rows than asked for
     * because some were momentarily locked, not because the backlog is done.
     * Breaking on `n < batchSize` would abandon the remainder on every run —
     * and since the next run would do the same, part of the backlog could
     * survive indefinitely while the logs reported clean completions.
     */
    process.env.RADACCT_ARCHIVE_BATCH = '1000';
    let call = 0;
    const prisma: any = {
      // 1000, then a short 300 (rows locked), then 1000 more still waiting.
      $queryRaw: jest.fn(async () => [{ moved: [1000, 300, 1000, 0][call++] ?? 0 }]),
    };
    const r: any = await new DatabaseSetupService(prisma).archiveOldSessions(90);
    expect(r.moved).toBe(2_300);
  });

  it('stops at the time budget with everything so far already committed', async () => {
    process.env.RADACCT_ARCHIVE_BATCH = '100';
    process.env.RADACCT_ARCHIVE_BUDGET_MS = '1000';

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    let tick = 0;
    clock.mockImplementation(() => now + tick * 400); // 400ms per batch

    const { svc, remaining } = makeService(100_000);
    const orig = (svc as any).prisma.$queryRaw;
    (svc as any).prisma.$queryRaw = jest.fn(async (...a: any[]) => { tick++; return orig(...a); });

    const r: any = await svc.archiveOldSessions(90);
    clock.mockRestore();

    // Gave up early, but the rows it did move stay moved.
    expect(r.moved).toBeGreaterThan(0);
    expect(r.moved).toBeLessThan(100_000);
    expect(remaining()).toBeGreaterThan(0);
  });

  it('does no work at all when the backlog is empty', async () => {
    const { svc, calls } = makeService(0);
    const r: any = await svc.archiveOldSessions(90);
    expect(r.moved).toBe(0);
    expect(calls.length).toBe(1); // one probe, then stop
  });

  // ───────────────────────────────────────────────────────────────
  // The cluster gate
  // ───────────────────────────────────────────────────────────────
  it('only the primary instance archives', async () => {
    // Worker 3 of a PM2 cluster. Previously all N ran the same sweep at once.
    process.env.NODE_APP_INSTANCE = '3';
    const { svc, prisma } = makeService(10_000);
    const r: any = await svc.archiveOldSessions(90);

    expect(r.skipped).toBe('not-primary');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('a dedicated worker process archives even when it is not instance 0', async () => {
    process.env.JOINTBOX_ROLE = 'worker';
    process.env.NODE_APP_INSTANCE = '2';
    const { svc } = makeService(500);
    const r: any = await svc.archiveOldSessions(90);
    expect(r.moved).toBe(500);
  });

  it('a web-role node never archives', async () => {
    // Otherwise a heavy maintenance sweep runs on the request path.
    process.env.JOINTBOX_ROLE = 'web';
    const { svc, prisma } = makeService(500);
    expect((await svc.archiveOldSessions(90) as any).skipped).toBe('not-primary');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('CRON_DISABLED turns it off', async () => {
    process.env.CRON_DISABLED = 'true';
    const { svc, prisma } = makeService(500);
    await svc.archiveOldSessions(90);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────
  // Re-entrancy and failure
  // ───────────────────────────────────────────────────────────────
  it('a second overlapping run in the same process is refused', async () => {
    // The interval can fire again while a long first run is still going.
    process.env.RADACCT_ARCHIVE_BATCH = '100';
    const { svc } = makeService(10_000);
    const first = svc.archiveOldSessions(90);
    const second: any = await svc.archiveOldSessions(90);
    expect(second.skipped).toBe('already-running');
    await first;
  });

  it('a failed run does not wedge archival off permanently', async () => {
    // If the guard were not released in `finally`, one transient database
    // error would silently disable archival until the next restart.
    const prisma: any = { $queryRaw: jest.fn().mockRejectedValue(new Error('deadlock detected')) };
    const svc = new DatabaseSetupService(prisma);

    const r: any = await svc.archiveOldSessions(90);
    expect(r.error).toMatch(/deadlock/);
    expect((svc as any).archiveRunning).toBe(false);

    prisma.$queryRaw = jest.fn(async () => [{ moved: 0 }]);
    await expect(svc.archiveOldSessions(90)).resolves.toMatchObject({ moved: 0 });
  });

  it('a failing archive never takes the process down', async () => {
    // It runs from an unawaited setInterval; a rejection there is an
    // unhandled promise rejection, which on modern Node exits the process.
    const prisma: any = { $queryRaw: jest.fn().mockRejectedValue(new Error('disk full')) };
    await expect(new DatabaseSetupService(prisma).archiveOldSessions(90)).resolves.toBeDefined();
  });

  it('honours the configured retention', async () => {
    process.env.RADACCT_RETAIN_DAYS = '30';
    const { svc, calls } = makeService(10);
    await svc.archiveOldSessions();
    expect(calls[0].retainDays).toBe(30);
  });
});
