import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { CacheService } from './cache.service';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * The shared cache, handed over once at bootstrap.
 *
 * WHY A MODULE-LEVEL SINGLETON AND NOT CONSTRUCTOR INJECTION
 * This guard is applied as `@UseGuards(new RateLimitGuard(10, 60_000))` — an
 * instance built by hand at class-decoration time, so Nest never constructs it
 * and cannot inject anything into it. That per-route configuration is worth
 * keeping; routing it through DI tokens would mean changing every call site
 * for no gain to the operator.
 *
 * So the cache is registered once, from bootstrap, and every hand-built guard
 * reads the same one. It is deliberately a `let` with a setter rather than an
 * import-time lookup: the CacheService instance belongs to the Nest container
 * and does not exist when this module is first evaluated.
 */
let sharedCache: CacheService | null = null;

/** Called once from bootstrap, after the Nest container is up. */
export function setRateLimitCache(cache: CacheService): void {
  sharedCache = cache;
}

/**
 * REQUEST RATE LIMITING.
 *
 * WHAT WAS WRONG
 * The store was a `Map` on the guard instance — per process, always, with no
 * Redis path at all. Under PM2 cluster mode (which SCALING.md recommends for
 * this product) every worker enforces its own independent counter, so the
 * effective limit is N times whatever was configured. On a 16-core box a limit
 * of 10/minute is really 160/minute, and nothing at the call site hints at it.
 * This is the guard on the PUBLIC hotspot voucher endpoint, so in practice
 * voucher brute-forcing got 16× the budget the author intended.
 *
 * It grew looser precisely as the deployment scaled — the opposite of what a
 * limiter is for.
 *
 * WHY INCR RATHER THAN GET-THEN-SET
 * Read-modify-write across a network round trip loses updates under exactly
 * the concurrency this exists to survive: two simultaneous requests both read
 * 9, both write 10, and one gets in free. `CacheService.incr()` is a single
 * atomic Redis INCR and cannot.
 *
 * THE FALLBACK IS STILL HERE, AND IS STILL RIGHT
 * Without Redis the per-process map is all there is, and a loose limit beats
 * no limit and beats refusing traffic. What changed is that it says so instead
 * of being silent, and it is no longer the only path — and in production
 * `redisIsRequired()` means the process would not have started in that state.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static readonly logger = new Logger(RateLimitGuard.name);
  /** Fallback store, used only when Redis is unavailable. */
  private store = new Map<string, RateLimitEntry>();
  private warnedAboutFallback = false;

  constructor(
    private readonly maxRequests: number = 60,
    private readonly windowMs: number = 60_000,
    /** Test seam; production wiring goes through setRateLimitCache(). */
    private readonly cache: CacheService | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    // The window is bucketed by wall clock so every process derives the SAME
    // key for the same instant. Without this, two workers would count one
    // caller into two different keys and the limit would fragment again — the
    // exact bug being fixed, reintroduced through the key.
    const bucket = Math.floor(now / this.windowMs);
    const key = `ratelimit:${ip}:${bucket}`;

    const cache = this.cache ?? sharedCache;
    if (cache) {
      // Two windows of TTL: the counter has to outlive its own bucket a
      // little, or a request landing at the very end of a window finds its
      // counter already evicted and starts again from zero.
      const count = await cache.incr(key, Math.ceil((this.windowMs * 2) / 1000));
      if (count !== null) {
        if (count > this.maxRequests) this.reject();
        return true;
      }
    }

    return this.allowViaLocalFallback(key, now);
  }

  /** Per-process counting. Correct for one instance, loose across several. */
  private allowViaLocalFallback(key: string, now: number): boolean {
    if (!this.warnedAboutFallback) {
      this.warnedAboutFallback = true;
      RateLimitGuard.logger.warn(
        'Rate limiting is using per-process memory (Redis unavailable) — limits are per instance, not cluster-wide',
      );
    }

    let entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(key, entry);
    }

    // Keys are bucketed by time, so an old key is never revisited and would
    // sit there forever. An unbounded map keyed by client IP is a slow memory
    // leak that an attacker can drive from outside.
    if (this.store.size > 10_000) {
      for (const [k, v] of this.store) if (now > v.resetAt) this.store.delete(k);
    }

    entry.count++;
    if (entry.count > this.maxRequests) this.reject();
    return true;
  }

  private reject(): never {
    throw new HttpException(
      { message: 'Too many requests. Please try again later.', statusCode: HttpStatus.TOO_MANY_REQUESTS },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
