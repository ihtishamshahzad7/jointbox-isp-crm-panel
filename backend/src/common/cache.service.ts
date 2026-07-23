import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * Unified cache layer.
 * - If REDIS_URL is set → uses Redis (ioredis).
 * - Otherwise → falls back to a fast in-memory TTL map (single instance).
 * All consumers use the same API either way.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: any = null;
  private memory = new Map<string, { value: string; expiresAt: number }>();
  private sweepTimer: NodeJS.Timeout | null = null;

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
          this.logger.warn(`Redis unavailable (${e.message}) — using in-memory cache`);
          this.redis = null;
        });
        this.logger.log('Cache: Redis mode');
      } catch {
        this.logger.warn('ioredis not installed — using in-memory cache');
        this.redis = null;
      }
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

  /** Delete all keys starting with a prefix (e.g. invalidate 'packages:'). */
  async delPrefix(prefix: string): Promise<void> {
    try {
      if (this.redis?.status === 'ready') {
        const keys = await this.redis.keys(`${prefix}*`);
        if (keys.length) await this.redis.del(...keys);
      }
    } catch {
      /* ignore */
    }
    for (const k of this.memory.keys()) if (k.startsWith(prefix)) this.memory.delete(k);
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
