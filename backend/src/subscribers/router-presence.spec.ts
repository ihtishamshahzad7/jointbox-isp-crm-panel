/**
 * P1 — router presence fan-out.
 *
 * Proves the sweep is bounded (never all routers at once), times each NAS out,
 * excludes demo NAS, caches the union, and collapses concurrent cache-miss
 * callers into a single sweep (single-flight).
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { SubscribersService } from './subscribers.service';
import { DEMO_NAS_SERVER } from '../common/scope.service';

function makeHarness(opts: {
  nases: any[];
  getUsers: (n: any) => Promise<Array<{ username: string }>>;
}) {
  const store = new Map<string, any>();
  const cache = {
    async get(k: string) { return store.has(k) ? store.get(k) : null; },
    async set(k: string, v: any) { store.set(k, v); },
  };
  let active = 0;
  let peak = 0;
  const mikrotik = {
    async getActivePppoeUsers(ip: string) {
      active++; peak = Math.max(peak, active);
      try { return await opts.getUsers({ ip }); }
      finally { active--; }
    },
  };
  const queries: any[] = [];
  const prisma = {
    nas: {
      async findMany(args: any) { queries.push(args); return opts.nases; },
    },
  };
  // Bypass the real DI constructor; wire only what routerPresence touches.
  const svc: any = Object.create(SubscribersService.prototype);
  svc.cache = cache; svc.prisma = prisma; svc.mikrotik = mikrotik;
  return { svc, store, getPeak: () => peak, queries };
}

const OLD_ENV = process.env;
beforeEach(() => { process.env = { ...OLD_ENV }; });
afterAll(() => { process.env = OLD_ENV; });

const nas = (ip: string, extra: any = {}) => ({ nasIp: ip, apiPort: 8728, apiUsername: 'api', apiPassword: 'p', server: null, ...extra });

describe('SubscribersService.routerPresence (P1)', () => {
  it('bounds concurrency to NAS_POLL_CONCURRENCY', async () => {
    process.env.NAS_POLL_CONCURRENCY = '5';
    const nases = Array.from({ length: 40 }, (_, i) => nas(`10.0.0.${i}`));
    const h = makeHarness({
      nases,
      getUsers: async () => { await new Promise((r) => setTimeout(r, 10)); return [{ username: 'u' }]; },
    });
    const set = await h.svc.routerPresence();
    expect(h.getPeak()).toBeLessThanOrEqual(5); // never 40 at once
    expect(set.has('u')).toBe(true);
  });

  it('times a hung NAS out and still returns the reachable ones', async () => {
    process.env.NAS_POLL_CONCURRENCY = '10';
    process.env.NAS_API_TIMEOUT_MS = '1000';
    const h = makeHarness({
      nases: [nas('10.0.0.1'), nas('10.0.0.2')],
      getUsers: async ({ ip }: any) => {
        if (ip === '10.0.0.1') return new Promise(() => {}); // never resolves
        return [{ username: 'live' }];
      },
    });
    const start = Date.now();
    const set = await h.svc.routerPresence();
    expect(Date.now() - start).toBeLessThan(1500); // did not hang on the dead NAS
    expect(set.has('live')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('excludes demo NAS at the query level', async () => {
    const h = makeHarness({ nases: [], getUsers: async () => [] });
    await h.svc.routerPresence();
    const where = h.queries[0].where;
    expect(where.OR).toEqual([{ server: null }, { server: { not: DEMO_NAS_SERVER } }]);
    expect(where.apiUsername).toEqual({ not: null });
  });

  it('caches the union for reuse (second call hits cache, no re-sweep)', async () => {
    let sweeps = 0;
    const h = makeHarness({
      nases: [nas('10.0.0.1')],
      getUsers: async () => { sweeps++; return [{ username: 'u' }]; },
    });
    await h.svc.routerPresence();
    await h.svc.routerPresence();
    expect(sweeps).toBe(1); // second call served from cache
    expect(h.store.get('subs:router-presence')).toEqual(['u']);
  });

  it('single-flight: concurrent cache-miss callers run ONE sweep', async () => {
    let sweeps = 0;
    const h = makeHarness({
      nases: [nas('10.0.0.1')],
      getUsers: async () => { sweeps++; await new Promise((r) => setTimeout(r, 20)); return [{ username: 'u' }]; },
    });
    const [a, b, c] = await Promise.all([h.svc.routerPresence(), h.svc.routerPresence(), h.svc.routerPresence()]);
    expect(sweeps).toBe(1);
    for (const s of [a, b, c]) expect(s.has('u')).toBe(true);
  });
});
