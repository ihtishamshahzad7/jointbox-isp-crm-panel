import { HttpException } from '@nestjs/common';
import { RateLimitGuard, setRateLimitCache } from './rate-limit.guard';

/**
 * RATE LIMITING ACROSS A CLUSTER.
 *
 * THE BUG
 * The store was a `Map` on the guard instance, with no Redis path at all.
 * PM2 cluster mode — which SCALING.md recommends for this product — gives each
 * worker its own module registry, its own guard instance, and therefore its
 * own counter. The effective limit becomes N × configured, where N is the
 * instance count, and nothing at the call site hints at it. On a 16-core box a
 * limit of 10/minute admits 160.
 *
 * This guards the PUBLIC hotspot voucher endpoint, so the practical effect was
 * that voucher brute-forcing got 16× the budget the author intended — and the
 * limiter got looser precisely as the deployment grew.
 *
 * WHAT THESE TESTS SIMULATE
 * A cluster is modelled as several guard INSTANCES sharing one fake Redis.
 * That is exactly the shape of the real failure: separate instances, shared
 * backing store. A test using one guard instance would pass against the buggy
 * code and prove nothing.
 */
describe('RateLimitGuard', () => {
  /** A fake Redis-backed cache with a genuinely atomic incr. */
  function fakeCache() {
    const counts = new Map<string, number>();
    return {
      counts,
      incr: jest.fn(async (key: string) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      }),
    } as any;
  }

  /** A cache standing in for "Redis is down" — incr returns null. */
  const deadCache = () => ({ incr: jest.fn(async () => null) }) as any;

  const ctx = (ip = '1.2.3.4') =>
    ({ switchToHttp: () => ({ getRequest: () => ({ ip }) }) }) as any;

  afterEach(() => setRateLimitCache(null as any));

  it('enforces the limit within a single instance', async () => {
    const guard = new RateLimitGuard(3, 60_000, fakeCache());
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('THE FIX: four cluster workers share one budget, not four', async () => {
    // Against the old per-process Map this passes 12 requests through a limit
    // of 3 and never throws. It is the whole reason this file exists.
    const cache = fakeCache();
    const workers = [0, 1, 2, 3].map(() => new RateLimitGuard(3, 60_000, cache));

    await expect(workers[0].canActivate(ctx())).resolves.toBe(true);
    await expect(workers[1].canActivate(ctx())).resolves.toBe(true);
    await expect(workers[2].canActivate(ctx())).resolves.toBe(true);
    // Fourth request, different worker, same caller — must be refused.
    await expect(workers[3].canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('rejects with 429, not a 500', async () => {
    // A limiter that throws the wrong status tells the client to retry
    // differently, or looks like a server fault in the logs.
    const guard = new RateLimitGuard(1, 60_000, fakeCache());
    await guard.canActivate(ctx());
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({ status: 429 });
  });

  it('counts each caller separately', async () => {
    const cache = fakeCache();
    const guard = new RateLimitGuard(2, 60_000, cache);
    await guard.canActivate(ctx('10.0.0.1'));
    await guard.canActivate(ctx('10.0.0.1'));
    // A different IP has spent nothing; exhausting one must not block others.
    await expect(guard.canActivate(ctx('10.0.0.2'))).resolves.toBe(true);
  });

  it('derives the same key on every instance for the same instant', async () => {
    // If the key embedded anything per-process — a pid, a random id, an
    // instance counter — the limit would fragment again while every test
    // above still passed. So the key itself is asserted.
    const cache = fakeCache();
    await new RateLimitGuard(10, 60_000, cache).canActivate(ctx('9.9.9.9'));
    await new RateLimitGuard(10, 60_000, cache).canActivate(ctx('9.9.9.9'));
    expect(cache.counts.size).toBe(1);
    expect([...cache.counts.keys()][0]).toMatch(/^ratelimit:9\.9\.9\.9:\d+$/);
  });

  it('sets a TTL longer than the window', async () => {
    // A TTL equal to the window lets a counter expire at the very moment a
    // request lands at the end of it, handing the caller a fresh budget.
    const cache = fakeCache();
    await new RateLimitGuard(5, 60_000, cache).canActivate(ctx());
    const [, ttl] = cache.incr.mock.calls[0];
    expect(ttl).toBeGreaterThan(60);
  });

  it('starts a fresh budget in the next window', async () => {
    const cache = fakeCache();
    const guard = new RateLimitGuard(1, 1_000, cache);
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');

    spy.mockReturnValue(now);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);

    // Two seconds later — a new bucket, so the caller is allowed again rather
    // than locked out permanently by one burst.
    spy.mockReturnValue(now + 2_000);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    spy.mockRestore();
  });

  it('still limits when Redis is unavailable', async () => {
    // Degraded, not disabled. A per-process limit is loose across a cluster
    // and is still far better than admitting everything.
    const guard = new RateLimitGuard(2, 60_000, deadCache());
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('picks up the cache registered at bootstrap', async () => {
    // The guards in controllers are built by hand with `new`, so Nest cannot
    // inject into them. If this wiring is wrong every one of them silently
    // stays on the per-process path and the fix ships doing nothing.
    const cache = fakeCache();
    setRateLimitCache(cache);
    const a = new RateLimitGuard(1, 60_000);
    const b = new RateLimitGuard(1, 60_000);
    await expect(a.canActivate(ctx('7.7.7.7'))).resolves.toBe(true);
    await expect(b.canActivate(ctx('7.7.7.7'))).rejects.toThrow(HttpException);
  });

  it('does not grow its fallback map without bound', async () => {
    // Keys are time-bucketed, so old ones are never revisited. Keyed by client
    // IP, an unswept map is a memory leak an attacker can drive from outside.
    const guard: any = new RateLimitGuard(1_000_000, 1, deadCache());
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    for (let i = 0; i < 12_000; i++) {
      spy.mockReturnValue(now + i);
      await guard.canActivate(ctx(`10.1.${(i >> 8) & 255}.${i & 255}`));
    }
    spy.mockRestore();
    expect(guard.store.size).toBeLessThan(12_000);
  });
});
