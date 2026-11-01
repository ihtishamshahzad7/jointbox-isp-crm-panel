/**
 * S1 — distributed login lockout (service-level).
 *
 * Proves the brute-force protection is backed by SHARED atomic counters, not a
 * per-process map: two AuthService instances sharing one fake Redis lock each
 * other out; an attacker who rotates the source IP still hits the per-account
 * ceiling; an attacker who sprays many invented emails from one IP hits the
 * per-IP ceiling; a success clears the counters; the window expires on its own;
 * and when Redis is required but down, login fails closed instead of silently
 * dropping protection.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from './auth.service';

/** A fake Redis shared by several AuthService instances. INCR/EXPIRE/TTL/GET/DEL. */
function makeSharedRedis() {
  const store = new Map<string, { n: number; expiresAt: number }>();
  let ready = true;
  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { store.delete(k); return null; }
    return e;
  };
  const cache: any = {
    isRedisReady: () => ready,
    async incr(key: string, ttlSeconds: number) {
      if (!ready) return null;
      const e = live(key) ?? { n: 0, expiresAt: Date.now() + ttlSeconds * 1000 };
      e.n += 1;
      store.set(key, e);
      return e.n;
    },
    async getCount(key: string) {
      if (!ready) return null;
      return live(key)?.n ?? 0;
    },
    async ttlSeconds(key: string) {
      if (!ready) return null;
      const e = live(key);
      return e ? Math.ceil((e.expiresAt - Date.now()) / 1000) : -2;
    },
    async del(...keys: string[]) {
      for (const k of keys) store.delete(k);
    },
  };
  return {
    cache,
    store,
    setReady: (v: boolean) => { ready = v; },
    // Advance all TTLs as though `ms` elapsed.
    advance: (ms: number) => { for (const e of store.values()) e.expiresAt -= ms; },
  };
}

function svc(cache: any) {
  // Only the lockout path is exercised; other deps are never touched by it.
  return new AuthService({} as any, {} as any, {} as any, {} as any, {} as any, cache as any);
}

async function expectLocked(fn: () => Promise<any>) {
  await expect(fn()).rejects.toBeInstanceOf(UnauthorizedException);
}

const OLD_ENV = process.env;
beforeEach(() => { process.env = { ...OLD_ENV }; });
afterAll(() => { process.env = OLD_ENV; });

describe('AuthService distributed lockout (S1)', () => {
  it('shares the counter across instances: fails on A lock the account on B', async () => {
    const r = makeSharedRedis();
    const a: any = svc(r.cache);
    const b: any = svc(r.cache);
    // 8 email+IP fails spread across two instances.
    for (let i = 0; i < 4; i++) await a.registerFail('u@x.io', '1.1.1.1');
    for (let i = 0; i < 4; i++) await b.registerFail('u@x.io', '1.1.1.1');
    // Instance B — which only saw half the attempts — must now lock out.
    await expectLocked(() => b.assertNotLocked('u@x.io', '1.1.1.1'));
    // And so must A.
    await expectLocked(() => a.assertNotLocked('u@x.io', '1.1.1.1'));
  });

  it('caps per-account guesses even when the source IP keeps changing', async () => {
    const r = makeSharedRedis();
    const s: any = svc(r.cache);
    // 24 fails, each from a different address: under the per-IP and per-pair
    // limits individually, but they all roll up to the one account counter.
    for (let i = 0; i < 24; i++) await s.registerFail('victim@x.io', `10.0.0.${i}`);
    // 25th different-IP attempt is still allowed (ceiling is 25)...
    await s.assertNotLocked('victim@x.io', '10.0.0.200');
    await s.registerFail('victim@x.io', '10.0.0.200');
    // ...now the account is locked from a brand-new address.
    await expectLocked(() => s.assertNotLocked('victim@x.io', '10.0.0.201'));
  });

  it('caps email-spraying: many invented emails from one IP', async () => {
    const r = makeSharedRedis();
    const s: any = svc(r.cache);
    // 50 fails, each a different (non-existent) email, all from one address.
    for (let i = 0; i < 50; i++) await s.registerFail(`ghost${i}@x.io`, '9.9.9.9');
    // A 51st email from that IP is refused before the password is ever checked.
    await expectLocked(() => s.assertNotLocked('ghost-new@x.io', '9.9.9.9'));
    // A different IP is unaffected.
    await s.assertNotLocked('ghost-new@x.io', '8.8.8.8');
  });

  it('clears the counters after a successful login', async () => {
    const r = makeSharedRedis();
    const s: any = svc(r.cache);
    for (let i = 0; i < 7; i++) await s.registerFail('u@x.io', '1.1.1.1');
    await s.clearFails('u@x.io', '1.1.1.1');
    // Back to a clean slate: 7 more fails are needed again, not 1.
    for (let i = 0; i < 7; i++) await s.registerFail('u@x.io', '1.1.1.1');
    await s.assertNotLocked('u@x.io', '1.1.1.1'); // still under the limit of 8
  });

  it('lifts the lock once the window expires', async () => {
    const r = makeSharedRedis();
    const s: any = svc(r.cache);
    for (let i = 0; i < 8; i++) await s.registerFail('u@x.io', '1.1.1.1');
    await expectLocked(() => s.assertNotLocked('u@x.io', '1.1.1.1'));
    r.advance(16 * 60_000); // 16 min later — past the 15-min window
    await s.assertNotLocked('u@x.io', '1.1.1.1'); // allowed again
  });

  it('fails CLOSED when Redis is required but unreachable', async () => {
    process.env.REDIS_REQUIRED = 'true';
    const r = makeSharedRedis();
    r.setReady(false); // Redis down
    const s: any = svc(r.cache);
    await expect(s.assertNotLocked('u@x.io', '1.1.1.1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('falls back to a local counter on a single-instance install (Redis not required)', async () => {
    process.env.REDIS_REQUIRED = 'false';
    const r = makeSharedRedis();
    r.setReady(false); // no Redis at all
    const s: any = svc(r.cache);
    for (let i = 0; i < 8; i++) await s.registerFail('u@x.io', '1.1.1.1');
    await expectLocked(() => s.assertNotLocked('u@x.io', '1.1.1.1'));
  });

  it('has no attacker-triggered global reset: unrelated traffic never frees a lock', async () => {
    process.env.REDIS_REQUIRED = 'false';
    const r = makeSharedRedis();
    r.setReady(false); // in-memory path
    const s: any = svc(r.cache);
    // Lock a victim first.
    for (let i = 0; i < 8; i++) await s.registerFail('victim@x.io', '1.1.1.1');
    await expectLocked(() => s.assertNotLocked('victim@x.io', '1.1.1.1'));
    // Unrelated attempts from other emails/IPs (the old code did a blanket
    // .clear() on size overflow, which would have wiped the victim's lock).
    for (let i = 0; i < 500; i++) await s.registerFail(`flood${i}@x.io`, `2.2.0.${i & 255}`);
    // The victim is STILL locked — pruneMemory only evicts EXPIRED entries.
    await expectLocked(() => s.assertNotLocked('victim@x.io', '1.1.1.1'));
  });

  it('pruneMemory evicts only expired entries, never an active lock', async () => {
    process.env.REDIS_REQUIRED = 'false';
    const r = makeSharedRedis();
    r.setReady(false);
    const s: any = svc(r.cache);
    for (let i = 0; i < 8; i++) await s.registerFail('live@x.io', '1.1.1.1');
    // Inject an already-expired entry, then prune.
    s.loginAttempts.set('authfail:email:stale@x.io', { count: 99, until: Date.now() - 1 });
    s.pruneMemory(Date.now());
    expect(s.loginAttempts.has('authfail:email:stale@x.io')).toBe(false); // expired → gone
    await expectLocked(() => s.assertNotLocked('live@x.io', '1.1.1.1')); // active → kept
  });
});
