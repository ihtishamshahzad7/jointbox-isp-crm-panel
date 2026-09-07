import { CacheService, redisIsRequired } from './cache.service';
import { QueueService } from './queue.service';

/**
 * REDIS MUST NOT DEGRADE SILENTLY.
 *
 * WHAT HAPPENED BEFORE
 * Both CacheService and QueueService checked `process.env.REDIS_URL`, and if
 * the connection failed they fell back — to a per-process `Map` and to inline
 * job execution respectively — behind a single `logger.warn`. No alert, no
 * crash, nothing on any dashboard.
 *
 * The result of that fallback under PM2 cluster mode is not "slightly slower".
 * It is a different system:
 *   · each worker caches separately, so invalidation on one leaves the others
 *     serving stale data indefinitely;
 *   · rate limits become per instance, so the effective limit is N× looser;
 *   · "durable" queued jobs live in one process's heap and are destroyed by
 *     any restart, with no dead letter and nothing left to notice afterwards.
 *
 * A half-finished 1M-subscriber RADIUS sync that vanishes without trace is
 * worse than one that never started, because the operator believes it ran.
 *
 * WHY REFUSING TO START IS THE RIGHT ANSWER
 * An operator who set REDIS_URL asked for that system. Running a different one
 * behind their back is worse than not running at all: a process that will not
 * start gets fixed in minutes, and a silent downgrade goes unnoticed for
 * weeks. The predicate is narrow on purpose — production AND REDIS_URL set —
 * so no development or single-instance install changes behaviour.
 */
describe('Redis strictness', () => {
  const REAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...REAL_ENV }; });

  // ───────────────────────────────────────────────────────────────
  // The predicate. Both services must agree on it exactly — if cache
  // demanded Redis and the queue tolerated its absence, an outage would
  // half-fail the process, the state neither is designed for.
  // ───────────────────────────────────────────────────────────────
  describe('redisIsRequired()', () => {
    it('is required in production once REDIS_URL is configured', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      delete process.env.REDIS_REQUIRED;
      expect(redisIsRequired()).toBe(true);
    });

    it('is NOT required in development', () => {
      // Nobody should need Redis running to work on a billing form.
      process.env.NODE_ENV = 'development';
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      delete process.env.REDIS_REQUIRED;
      expect(redisIsRequired()).toBe(false);
    });

    it('is NOT required for a production install that never configured Redis', () => {
      // The existing single-instance deployments. Demanding Redis of them
      // would turn a correctness fix into an outage on upgrade — the change
      // has to be invisible to anyone it does not apply to.
      process.env.NODE_ENV = 'production';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_REQUIRED;
      expect(redisIsRequired()).toBe(false);
    });

    it('REDIS_REQUIRED=false is an explicit opt-out that always wins', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      process.env.REDIS_REQUIRED = 'false';
      expect(redisIsRequired()).toBe(false);
    });

    it('REDIS_REQUIRED=true can demand it outside production', () => {
      // For a staging environment that must behave like production.
      process.env.NODE_ENV = 'development';
      process.env.REDIS_REQUIRED = 'true';
      expect(redisIsRequired()).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // QueueService
  // ───────────────────────────────────────────────────────────────
  describe('QueueService.assertReady()', () => {
    it('refuses to run undurably when durability was configured', () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_REQUIRED = 'true';
      delete process.env.REDIS_URL;
      // The old code logged one line here and ran jobs inline forever.
      expect(() => new QueueService().assertReady()).toThrow(/REDIS_URL/i);
    });

    it('says nothing when Redis was never asked for', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_REQUIRED;
      expect(() => new QueueService().assertReady()).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // CacheService
  // ───────────────────────────────────────────────────────────────
  describe('CacheService', () => {
    it('reports a missing-but-required Redis instead of quietly using memory', async () => {
      process.env.NODE_ENV = 'production';
      process.env.REDIS_REQUIRED = 'true';
      delete process.env.REDIS_URL;

      const cache = new CacheService();
      expect(cache.health()).toMatchObject({ required: true, ready: false });
      expect(cache.health().error).toMatch(/REDIS_URL/i);
      // Short timeout: this is the already-failed case, no point waiting.
      await expect(cache.assertReady(50)).rejects.toThrow(/REDIS_URL/i);
      cache.onModuleDestroy();
    });

    it('assertReady is a no-op when Redis is optional', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_REQUIRED;

      const cache = new CacheService();
      await expect(cache.assertReady(50)).resolves.toBeUndefined();
      expect(cache.health()).toMatchObject({ required: false, ready: false, error: null });
      cache.onModuleDestroy();
    });

    it('the in-memory path still works when Redis is optional', async () => {
      // The fallback is not being removed, only stopped from being silent
      // where it is wrong. It must still be correct where it is right.
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_REQUIRED;

      const cache = new CacheService();
      await cache.set('k', { a: 1 }, 30);
      expect(await cache.get('k')).toEqual({ a: 1 });
      await cache.delPrefix('k');
      expect(await cache.get('k')).toBeNull();
      cache.onModuleDestroy();
    });

    it('incr reports "no Redis" rather than inventing a per-process count', async () => {
      // Returning a local number here would hand RateLimitGuard a count that
      // looks cluster-wide and is not — the original bug, wearing a new hat.
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      const cache = new CacheService();
      expect(await cache.incr('ratelimit:x', 60)).toBeNull();
      cache.onModuleDestroy();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // delPrefix: SCAN, not KEYS
  // ───────────────────────────────────────────────────────────────
  describe('delPrefix', () => {
    it('uses SCAN and never KEYS', async () => {
      /**
       * `KEYS pattern` walks the whole keyspace in one shot, and Redis is
       * single-threaded, so nothing else runs for the duration — every client
       * of that instance stalls. On a keyspace holding cache entries for a
       * million subscribers that is hundreds of milliseconds to seconds, and
       * it fires on every package edit. The symptom is not slow invalidation;
       * it is unexplained latency spikes across the whole application,
       * including requests that never touch the cache.
       */
      process.env.NODE_ENV = 'development';
      delete process.env.REDIS_URL;
      const cache: any = new CacheService();

      const scan = jest
        .fn()
        .mockResolvedValueOnce(['17', ['pkg:1', 'pkg:2']])
        .mockResolvedValueOnce(['0', ['pkg:3']]);
      const del = jest.fn().mockResolvedValue(1);
      const keys = jest.fn();
      cache.redis = { status: 'ready', scan, del, keys };

      await cache.delPrefix('pkg:');

      expect(keys).not.toHaveBeenCalled();
      // Followed the cursor to completion rather than stopping at the first page.
      expect(scan).toHaveBeenCalledTimes(2);
      expect(scan.mock.calls[1][0]).toBe('17');
      expect(del).toHaveBeenCalledWith('pkg:1', 'pkg:2');
      expect(del).toHaveBeenCalledWith('pkg:3');
      cache.onModuleDestroy();
    });
  });
});
