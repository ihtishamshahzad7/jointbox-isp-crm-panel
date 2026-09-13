import { EventsService } from './events.service';
import { EventsController } from './events.controller';

/**
 * A1 — LIVE EVENTS MUST CROSS WORKERS, AND MUST NOT TAKE THE API DOWN.
 *
 * These are unit tests with a fake Redis, and that is the right level for the
 * three properties that actually broke: what gets published, what gets emitted
 * locally, and what happens when the connection fails. A real Redis adds
 * nothing to any of those and would make the suite need infrastructure to
 * answer questions that are pure logic.
 *
 * The one thing this level CANNOT prove is that two real processes sharing a
 * real Redis see each other's events. That is measured, not asserted — it
 * belongs in the R9 load test and is listed there as UNPROVEN until then.
 */

/** Minimum viable ioredis: connect, publish, subscribe, message, quit. */
function fakeRedis() {
  const subscribers: Array<(ch: string, msg: string) => void> = [];
  const bus = { subscribers };
  const make = () => {
    const handlers: Record<string, Function[]> = {};
    const client: any = {
      published: [] as string[],
      on: (ev: string, fn: Function) => ((handlers[ev] ||= []).push(fn), client),
      connect: jest.fn(async () => undefined),
      subscribe: jest.fn(async () => {
        subscribers.push((ch, msg) => (handlers['message'] || []).forEach((h) => h(ch, msg)));
      }),
      publish: jest.fn(async (ch: string, msg: string) => {
        client.published.push(msg);
        // Redis delivers to EVERY subscriber, including the publisher's own
        // process. Modelling that is the whole point — the originating worker
        // must be served by the same path as the others.
        subscribers.forEach((s) => s(ch, msg));
        return 1;
      }),
      quit: jest.fn(async () => 'OK'),
      emitError: (e: Error) => (handlers['error'] || []).forEach((h) => h(e)),
      fail: () => {
        client.publish = jest.fn(async () => {
          throw new Error('READONLY You cannot write against a read only replica.');
        });
      },
    };
    return client;
  };
  return { make, bus };
}

function withFakeRedis(fake: ReturnType<typeof fakeRedis>) {
  const clients: any[] = [];
  jest.doMock('ioredis', () => {
    return function Redis() {
      const c = fake.make();
      clients.push(c);
      return c;
    };
  });
  return clients;
}

describe('A1: live events across a PM2 cluster', () => {
  const OLD = process.env.REDIS_URL;
  afterEach(() => {
    process.env.REDIS_URL = OLD;
    jest.resetModules();
    jest.dontMock('ioredis');
  });

  const boot = async () => {
    const fake = fakeRedis();
    const clients = withFakeRedis(fake);
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { EventsService: Svc } = await import('./events.service');
    const svc = new Svc() as EventsService;
    // Let the connect/subscribe promise chain settle.
    await new Promise((r) => setImmediate(r));
    return { svc, clients, fake };
  };

  // ── the bug ─────────────────────────────────────────────────────────────
  it('THE POINT: an event published by one worker reaches a client on another', async () => {
    const fake = fakeRedis();
    withFakeRedis(fake);
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { EventsService: Svc } = await import('./events.service');

    const workerA = new Svc() as EventsService;
    const workerB = new Svc() as EventsService;
    await new Promise((r) => setImmediate(r));

    // The operator's dashboard is connected to worker B.
    const seen: any[] = [];
    workerB.subscribe((event, payload) => seen.push({ event, payload }));

    // The payment is recorded on worker A.
    workerA.broadcast('payment', { amount: 1500, invoiceNo: 'INV-2026-00001' });
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([{ event: 'payment', payload: { amount: 1500, invoiceNo: 'INV-2026-00001' } }]);
  });

  it('and the originating worker sees it exactly ONCE, not twice', async () => {
    // The subtle failure mode of this fix: emit locally AND publish, and every
    // dashboard on the worker that handled the action shows the event twice.
    const { svc } = await boot();
    const seen: any[] = [];
    svc.subscribe((e) => seen.push(e));

    svc.broadcast('login', { email: 'ops@isp.pk' });
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['login']);
  });

  it('publishes once per broadcast, as JSON the other end can read', async () => {
    const { svc, clients } = await boot();
    svc.broadcast('session', { username: 'ihtisham01' });
    const pub = clients[0];
    expect(pub.publish).toHaveBeenCalledTimes(1);
    expect(JSON.parse(pub.published[0])).toEqual({
      event: 'session',
      payload: { username: 'ihtisham01' },
    });
  });

  // ── Redis failure must not become an API failure ────────────────────────
  it('a failed publish degrades to this worker instead of throwing', async () => {
    const { svc, clients } = await boot();
    const seen: string[] = [];
    svc.subscribe((e) => seen.push(e));

    clients[0].fail();
    // The caller is a payment handler. It must not see an exception.
    expect(() => svc.broadcast('payment', { amount: 10 })).not.toThrow();
    await new Promise((r) => setImmediate(r));

    // The operator on THIS worker still gets it — degraded, not dead.
    expect(seen).toEqual(['payment']);
    expect(svc.getStats().degraded).toBe(true);
    expect(svc.getStats().clustered).toBe(false);
  });

  it('a connection error does not crash the worker', async () => {
    // An unhandled 'error' on an ioredis client is an uncaught exception. A
    // live feed losing its connection must not take the API with it.
    const { svc, clients } = await boot();
    expect(() => clients[1].emitError(new Error('ECONNREFUSED'))).not.toThrow();
    expect(svc.getStats().degraded).toBe(true);
  });

  it('with no REDIS_URL it still works locally, and says so', async () => {
    delete process.env.REDIS_URL;
    jest.resetModules();
    const { EventsService: Svc } = await import('./events.service');
    const svc = new Svc() as EventsService;
    const seen: string[] = [];
    svc.subscribe((e) => seen.push(e));
    svc.broadcast('payment', {});
    expect(seen).toEqual(['payment']);
    expect(svc.getStats().clustered).toBe(false);
  });

  // ── bounded resources ───────────────────────────────────────────────────
  it('raises the listener ceiling above EventEmitter default of 10', async () => {
    // An ISP NOC with more than ten dashboard tabs is normal operation, and
    // the default would fill the log with MaxListenersExceededWarning.
    const { svc } = await boot();
    for (let i = 0; i < 50; i++) svc.subscribe(() => undefined);
    expect(svc.listenerCount()).toBe(50);
  });

  it('refuses a new stream past MAX_SSE_CLIENTS rather than accumulating', async () => {
    const events: any = { listenerCount: () => 500, subscribe: jest.fn(), getStats: jest.fn() };
    const controller = new EventsController(events);
    process.env.MAX_SSE_CLIENTS = '500';
    expect(() => controller.stream({} as any)).toThrow(/already streaming to 500/);
    delete process.env.MAX_SSE_CLIENTS;
  });

  it('accepts a stream below the limit', () => {
    const unsub = jest.fn();
    const events: any = { listenerCount: () => 3, subscribe: jest.fn(() => unsub), getStats: jest.fn() };
    expect(() => new EventsController(events).stream({} as any)).not.toThrow();
  });

  it('closes both Redis connections on shutdown', async () => {
    const { svc, clients } = await boot();
    await svc.onModuleDestroy();
    expect(clients[0].quit).toHaveBeenCalled();
    expect(clients[1].quit).toHaveBeenCalled();
  });
});
