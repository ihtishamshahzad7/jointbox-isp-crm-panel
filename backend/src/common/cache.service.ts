import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * Is this process required to have working Redis?
 *
 * WHY THIS PREDICATE EXISTS RATHER THAN AN INLINE `if`
 * CacheService and QueueService must agree about it exactly. If cache demanded
 * Redis and the queue tolerated its absence, a Redis outage would half-fail
 * the process — the confusing state neither of them is designed for.
 *
 * The rule: an operator who set REDIS_URL has said this deployment uses Redis.
 * Falling back to per-process memory after that is not graceful degradation,
 * it is silently running a DIFFERENT system than the one they configured, and
 * doing it with a single `logger.warn` nobody is watching at 3am.
 *
 * REDIS_REQUIRED=false is the deliberate escape hatch for a single-instance
 * install that wants the old tolerance. It has to be typed on purpose.
 */
export function redisIsRequired(): boolean {
  if (process.env.REDIS_REQUIRED === 'false') return false;
  if (process.env.REDIS_REQUIRED === 'true') return true;
  return process.env.NODE_ENV === 'production' && !!process.env.REDIS_URL;
}

/**
 * Unified cache layer.
 * - If REDIS_URL is set → uses Redis (ioredis).
 * - Otherwise → falls back to a fast in-memory TTL map (single instance).
 * All consumers use the same API either way.
 *
 * ON THE FALLBACK, AT SCALE
 * The in-memory path is correct for one process and quietly wrong for several.
 * Under PM2 cluster mode — which SCALING.md recommends for exactly this
 * product — each worker gets its OWN map, so a cache invalidation on worker 3
 * leaves workers 0-2 serving stale data, and hit rate falls as instances are
 * added. That is a fine trade for a laptop and an incident on a 1M-subscriber
 * deployment, which is why `redisIsRequired()` now turns it into a startup
 * failure instead of a warning.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: any = null;
  private memory = new Map<string, { value: string; expiresAt: number }>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Set when Redis was required and could not be reached. Read by /health/ready. */
  private fatalError: string | null = null;

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Redis = require('ioredis');
        this.redis = new Redis(url, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          enableOfflineQueue: false,
        });
        this.redis.connect().catch((e: Error) => {
          if (redisIsRequired()) {
            // Recorded, not thrown. This callback runs on the event loop long
            // after the constructor returned, so throwing here becomes an
            // unhandled rejection — a stack trace with no context instead of a
            // clear message. `assertReady()` reports it at the point where
            // bootstrap can still refuse to come up cleanly, and
            // /health/ready reports it to the load balancer thereafter.
            this.fatalError = `Redis required but unreachable: ${e.message}`;
            this.logger.error(this.fatalError);
            this.redis = null;
            return;
          }
          this.logger.warn(`Redis unavailable (${e.message}) — using in-memory cache`);
          this.redis = null;
        });
        this.logger.log('Cache: Redis mode');
      } catch {
        if (redisIsRequired()) {
          this.fatalError = 'Redis required but the ioredis package is not installed';
          this.logger.error(this.fatalError);
        } else {
          this.logger.warn('ioredis not installed — using in-memory cache');
        }
        this.redis = null;
      }
    } else if (redisIsRequired()) {
      this.fatalError = 'REDIS_REQUIRED is set but REDIS_URL is not configured';
      this.logger.error(this.fatalError);
    } else {
      this.logger.log('Cache: in-memory mode (set REDIS_URL to enable Redis)');
    }
    // sweep expired in-memory entries every minute
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.memory) if (v.expiresAt < now) this.memory.delete(k);
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      if (this.redis?.status === 'ready') {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      }
    } catch {
      /* fall through to memory */
    }
    const hit = this.memory.get(key);
    if (!hit || hit.expiresAt < Date.now()) return null;
    return JSON.parse(hit.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds = 30): Promise<void> {
    const raw = JSON.stringify(value);
    try {
      if (this.redis?.status === 'ready') {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
        return;
      }
    } catch {
      /* fall through to memory */
    }
    this.memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    try {
      if (this.redis?.status === 'ready' && keys.length) await this.redis.del(...keys);
    } catch {
      /* ignore */
    }
    for (const k of keys) this.memory.delete(k);
  }

  /**
   * Delete all keys starting with a prefix (e.g. invalidate 'packages:').
   *
   * SCAN, NOT KEYS.
   * `KEYS pattern` walks the entire keyspace in one shot and Redis is single
   * threaded, so for the whole duration nothing else runs — every other client
   * of that Redis instance is stalled. On a keyspace holding cache entries for
   * a million subscribers that is hundreds of milliseconds to seconds, and it
   * fires on every package edit. The symptom is not "cache invalidation is
   * slow"; it is unexplained latency spikes across the entire application,
   * including requests that never touch the cache.
   *
   * SCAN returns a cursor and a slice, so other commands interleave between
   * iterations. It may return a key twice or miss one added mid-scan — both
   * harmless when the operation is "delete these", which is idempotent.
   */
  async delPrefix(prefix: string): Promise<void> {
    try {
      if (this.redis?.status === 'ready') {
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
          if (keys.length) await this.redis.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
    } catch {
      /* ignore */
    }
    for (const k of this.memory.keys()) if (k.startsWith(prefix)) this.memory.delete(k);
  }

  /**
   * Atomically increment a counter and return its new value, setting the TTL
   * on first write. Used by RateLimitGuard.
   *
   * WHY THIS IS NOT `get()` THEN `set()`
   * Read-modify-write across a network round trip is not atomic. Two requests
   * that both read 59 both write 60, and the sixtieth request through a limit
   * of 60 is admitted. Under exactly the concurrency a rate limiter exists to
   * survive, the lost-update race gets worse the more it is needed. INCR is
   * one atomic operation on Redis's single thread and cannot lose a count.
   *
   * The TTL is set only when the counter is created (`n === 1`), which makes
   * this a FIXED window: the expiry is anchored to the first request of the
   * window, and a caller cannot extend their own window by continuing to
   * knock. Setting EXPIRE on every increment would produce a counter that
   * never expires while traffic continues — a limiter that locks somebody out
   * permanently after one burst.
   *
   * Returns null when Redis is not available, so the caller decides what a
   * per-process count is worth rather than being handed one that looks
   * cluster-wide.
   */
  async incr(key: string, ttlSeconds: number): Promise<number | null> {
    if (this.redis?.status !== 'ready') return null;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, ttlSeconds);
      return n;
    } catch {
      return null;
    }
  }

  /** True when reads and writes are actually hitting Redis, not the local map. */
  isRedisReady(): boolean {
    return this.redis?.status === 'ready';
  }

  /**
   * Throw if Redis was required and is not usable. Called from bootstrap so a
   * misconfigured production process refuses to start rather than starting and
   * serving a subtly different system.
   *
   * WHY IT WAITS
   * The client is created with `lazyConnect` and connected in the background,
   * so at the moment bootstrap runs the socket is legitimately still opening.
   * Checking `status === 'ready'` synchronously would fail a perfectly healthy
   * start about as often as a broken one — a flaky boot check gets disabled,
   * and then it protects nothing. So it polls to a deadline, and only the
   * deadline is a failure.
   */
  async assertReady(timeoutMs = 10_000): Promise<void> {
    if (!redisIsRequired()) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.fatalError) throw new Error(this.fatalError);
      if (this.isRedisReady()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      this.fatalError ??
        `Redis required in production but not ready within ${timeoutMs}ms (REDIS_URL=${process.env.REDIS_URL ? 'set' : 'unset'})`,
    );
  }

  /** Non-throwing view of the same state, for the readiness probe. */
  health(): { required: boolean; ready: boolean; error: string | null } {
    return { required: redisIsRequired(), ready: this.isRedisReady(), error: this.fatalError };
  }

  /** Cache-aside helper: return cached value or compute + store it. */
  async wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await fn();
    // never cache null/undefined
    if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
    return value;
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.redis?.quit?.().catch(() => undefined);
  }
}
