import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';

/**
 * LIVENESS vs READINESS.
 *
 * THE GAP THIS CLOSES
 * `PrismaService.onModuleInit` deliberately tolerates a failed initial connect
 * so the app survives being started before Postgres is up. That is the right
 * call for boot resilience, and it has a consequence nobody wired for: the
 * process reports healthy at the process level while failing every real
 * request. `/health` returns `ok: true` throughout, so a load balancer
 * watching it keeps routing traffic to an instance that cannot answer a single
 * query — and every instance behind that balancer looks equally healthy.
 *
 * WHY TWO ENDPOINTS AND NOT ONE
 * They answer different questions and drive different remedies:
 *
 *   /health/live  → "is the process alive?"      → restart it if not
 *   /health/ready → "can it serve traffic?"      → route around it if not
 *
 * Conflating them is actively harmful. A liveness probe that touches the
 * database restarts every healthy worker during a brief Postgres blip, turning
 * a few seconds of degradation into a full rolling outage at the worst
 * possible moment. So liveness must check NOTHING but the process, and the
 * first test here exists to keep it that way.
 */
describe('health endpoints', () => {
  const makeController = (prisma: any, cache: any, queue: any = { getQueueDepths: jest.fn() }) =>
    new AppController(prisma, cache, queue);

  const okPrisma = () => ({ $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) });
  const deadPrisma = () => ({ $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
  const cacheWith = (h: any) => ({ health: () => h });

  // ───────────────────────────────────────────────────────────────
  // Liveness
  // ───────────────────────────────────────────────────────────────
  it('liveness touches no dependency at all', async () => {
    // If this ever starts querying, a Postgres blip becomes a mass restart.
    const prisma = deadPrisma();
    const c = makeController(prisma, cacheWith({ required: false, ready: false, error: null }));

    expect(c.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('/health stays as it was, so existing deploy smoke-tests keep working', () => {
    const c = makeController(okPrisma(), cacheWith({ required: false, ready: true, error: null }));
    expect(c.health()).toMatchObject({ ok: true });
  });

  // ───────────────────────────────────────────────────────────────
  // Readiness
  // ───────────────────────────────────────────────────────────────
  it('is ready when the database answers', async () => {
    const c = makeController(okPrisma(), cacheWith({ required: false, ready: false, error: null }));
    await expect(c.ready()).resolves.toMatchObject({ status: 'ok', db: true });
  });

  it('THE FIX: a database-less instance is pulled out of rotation', async () => {
    // The exact state the old /health called healthy.
    const c = makeController(deadPrisma(), cacheWith({ required: false, ready: false, error: null }));
    await expect(c.ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('the 503 says what is actually wrong', async () => {
    // A readiness probe that fails without a reason sends somebody hunting
    // through logs on the wrong machine.
    const c = makeController(deadPrisma(), cacheWith({ required: false, ready: false, error: null }));
    await expect(c.ready()).rejects.toMatchObject({
      response: { status: 'not_ready', db: false, error: expect.stringContaining('ECONNREFUSED') },
    });
  });

  it('a required-but-missing Redis makes the instance not ready', async () => {
    const c = makeController(
      okPrisma(),
      cacheWith({ required: true, ready: false, error: 'Redis required but unreachable' }),
    );
    await expect(c.ready()).rejects.toThrow(ServiceUnavailableException);
  });

  it('an OPTIONAL Redis being down does not park the only instance', async () => {
    /**
     * The important negative. On a single-instance install running
     * deliberately without Redis, `ready: false` is the configured state, not
     * a fault. Failing readiness on it would pull the ONLY instance out of
     * rotation and take the whole panel down — a monitoring improvement that
     * causes the outage it was added to prevent.
     */
    const c = makeController(okPrisma(), cacheWith({ required: false, ready: false, error: null }));
    await expect(c.ready()).resolves.toMatchObject({ status: 'ok' });
  });

  // ───────────────────────────────────────────────────────────────
  // Queue backlog
  // ───────────────────────────────────────────────────────────────
  describe('queue depths', () => {
    const depths = {
      mode: 'bullmq',
      queues: [{ name: 'radius-sync', waiting: 4210, active: 10, failed: 3, delayed: 0 }],
    };

    it('an admin sees the backlog', async () => {
      // `waiting` climbing is the metric that predicts "RADIUS profiles are
      // six hours stale" while there is still time to act on it.
      const c = makeController(okPrisma(), cacheWith({}), { getQueueDepths: async () => depths });
      const r: any = await c.systemQueues({ user: { role: 'SUPER_ADMIN' } });
      expect(r.visible).toBe(true);
      expect(r.queues[0].waiting).toBe(4210);
    });

    it('a non-admin sees nothing', async () => {
      // Queue names and depths describe deployment internals.
      const c = makeController(okPrisma(), cacheWith({}), { getQueueDepths: async () => depths });
      const r: any = await c.systemQueues({ user: { role: 'RESELLER' } });
      expect(r.visible).toBe(false);
      expect(r.queues).toEqual([]);
    });
  });

  it('reports the database first when both are down', async () => {
    // Redis unreachable is usually a symptom when Postgres is unreachable too
    // (the box, the network). Naming the database sends the operator to the
    // cause rather than to a second consequence.
    const c = makeController(
      deadPrisma(),
      cacheWith({ required: true, ready: false, error: 'Redis required but unreachable' }),
    );
    await expect(c.ready()).rejects.toMatchObject({ response: { db: false } });
  });
});
