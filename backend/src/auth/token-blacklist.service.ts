import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { CacheService } from '../common/cache.service';

/**
 * REVOKED TOKENS (logout, password change).
 *
 * This used to be a Set in process memory. PM2 runs the API as several
 * processes, and every restart or deploy empties memory, so a token revoked
 * on one process was still accepted by the others — and by all of them after
 * the next restart — for the rest of its 7-day life. Logout did not log out.
 *
 * Revocations now go to the shared cache (Redis when REDIS_URL is set, which
 * production requires — see cache.service), keyed by a hash of the token so
 * the token itself is never stored, and expiring when the token would have.
 * The local Set stays as a fast path and as the only store on a single
 * process with no Redis.
 */
@Injectable()
export class TokenBlacklistService {
  private blacklist = new Set<string>();

  constructor(@Optional() private readonly cache?: CacheService) {}

  private static key(token: string) {
    return `revoked:${createHash('sha256').update(token).digest('hex')}`;
  }

  /** Seconds until the token's own `exp`, so the entry dies with the token. */
  private static ttl(token: string): number {
    try {
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'),
      ) as { exp?: unknown } | null;
      const exp = Number(claims?.exp);
      const left = Math.ceil(exp - Date.now() / 1000);
      if (Number.isFinite(left))
        return Math.max(60, Math.min(left, 30 * 24 * 3600));
    } catch {
      /* not a JWT: fall back to the longest token life */
    }
    return 7 * 24 * 3600;
  }

  add(token: string): Promise<void> {
    const ttl = TokenBlacklistService.ttl(token);
    this.blacklist.add(token);
    setTimeout(() => this.blacklist.delete(token), ttl * 1000).unref?.();
    return (
      this.cache?.set(TokenBlacklistService.key(token), 1, ttl) ??
      Promise.resolve()
    );
  }

  /** This process only. Prefer isRevoked(), which also sees other processes. */
  isBlacklisted(token: string): boolean {
    return this.blacklist.has(token);
  }

  async isRevoked(token: string): Promise<boolean> {
    if (this.blacklist.has(token)) return true;
    if (!this.cache) return false;
    return (
      (await this.cache.get<number>(TokenBlacklistService.key(token))) === 1
    );
  }
}
