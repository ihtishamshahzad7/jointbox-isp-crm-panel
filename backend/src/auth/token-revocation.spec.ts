import { TokenBlacklistService } from './token-blacklist.service';
import { CacheService } from '../common/cache.service';

/**
 * Logout used to revoke the token in ONE process's memory. PM2 runs several,
 * and a restart empties all of them, so the "logged out" token kept working.
 */
function jwtWithExp(secondsFromNow: number) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ sub: 1, exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;
}

describe('token revocation survives other processes and restarts', () => {
  it('a token revoked by one process is refused by another sharing the cache', async () => {
    const shared = new CacheService(); // the Redis stand-in both processes talk to
    const procA = new TokenBlacklistService(shared);
    const procB = new TokenBlacklistService(shared);
    const t = jwtWithExp(3600);
    await procA.add(t);
    expect(procB.isBlacklisted(t)).toBe(false); // B's own memory never saw it…
    expect(await procB.isRevoked(t)).toBe(true); // …but the shared store did
  });

  it('a restart (fresh process) still refuses the token', async () => {
    const shared = new CacheService();
    const t = jwtWithExp(3600);
    await new TokenBlacklistService(shared).add(t);
    expect(await new TokenBlacklistService(shared).isRevoked(t)).toBe(true);
  });

  it('stores a hash, never the token, and expires with the token', async () => {
    const shared = new CacheService();
    const spy = jest.spyOn(shared, 'set');
    const t = jwtWithExp(120);
    await new TokenBlacklistService(shared).add(t);
    const [key, , ttl] = spy.mock.calls[0];
    expect(key).not.toContain(t);
    expect(key).toMatch(/^revoked:[0-9a-f]{64}$/);
    expect(ttl).toBeGreaterThanOrEqual(60);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('an unrelated token is not revoked', async () => {
    const shared = new CacheService();
    await new TokenBlacklistService(shared).add(jwtWithExp(3600));
    expect(
      await new TokenBlacklistService(shared).isRevoked(jwtWithExp(3599)),
    ).toBe(false);
  });
});
