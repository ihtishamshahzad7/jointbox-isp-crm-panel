import { DemoDataService } from './demo-data.service';
import { DemoRepairService } from './demo-repair.service';

/**
 * THE SANDBOX MUST NOT REACH THE LIVE AUTHENTICATION PATH.
 *
 * `radcheck` and `radreply` are FreeRADIUS's tables, not the panel's. FreeRADIUS
 * reads them straight out of Postgres on every authentication, keyed by username
 * alone — the stock schema has no owner column, so ScopeService cannot reach
 * them and no amount of tenant scoping in the API makes any difference.
 *
 * Seeding them therefore did not create "demo credentials". It created ten
 * thousand working subscriber logins on the production RADIUS server, with a
 * password (`DemoPass-00001`) derivable from a single example.
 *
 * radacct is different and IS still seeded: it is accounting history, it
 * authenticates nobody, and it is what makes the demo look like a live network.
 */
describe('demo: RADIUS exposure', () => {
  /** Records every model.method call so we can assert on what was written. */
  const recordingPrisma = (overrides: Record<string, any> = {}) => {
    const calls: Array<{ model: string; method: string; arg: any }> = [];
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => {
            if (overrides[`${name}.${String(method)}`]) return overrides[`${name}.${String(method)}`];
            return jest.fn(async (arg: any) => {
              calls.push({ model: name, method: String(method), arg });
              return [];
            });
          },
        },
      );
    const prisma: any = new Proxy(
      { $executeRawUnsafe: jest.fn(async () => 0), $queryRaw: jest.fn(async () => []) },
      {
        get: (t: any, prop: string) => {
          if (prop in t) return t[prop];
          if (!t[prop]) t[prop] = model(String(prop));
          return t[prop];
        },
      },
    );
    return { prisma, calls };
  };

  // ── the seeder ───────────────────────────────────────────────────────────
  it('THE FIX: seeding creates no radcheck or radreply rows', async () => {
    const rows = (n: number, extra: (i: number) => any = () => ({})) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, ...extra(i) }));

    const { prisma, calls } = recordingPrisma({
      'subscriber.count': jest.fn(async () => 0),
      'nas.count': jest.fn(async () => 0),
      'area.createManyAndReturn': jest.fn(async () => rows(20, (i) => ({ name: `A${i}` }))),
      'nas.findMany': jest.fn(async () => rows(500, (i) => ({ nasIp: `10.255.0.${i % 250}` }))),
      'ipPool.findMany': jest.fn(async () => rows(50)),
      'package.findMany': jest.fn(async () => rows(12, () => ({ price: 1000 }))),
      'subscriber.findMany': jest.fn(async () =>
        rows(5, (i) => ({ username: `demo-0000${i + 1}`, nasId: 1, status: 'ACTIVE' })),
      ),
    });

    await new DemoDataService(prisma).seedForUser(1, 5);

    const written = new Set(calls.filter((c) => c.method === 'createMany').map((c) => c.model));

    // The assertion this whole file exists for.
    expect(written.has('radCheck')).toBe(false);
    expect(written.has('radReply')).toBe(false);

    // ...and the sandbox is still populated, or the fix broke the feature.
    expect(written.has('subscriber')).toBe(true);
    expect(written.has('nas')).toBe(true);
    expect(written.has('radAcct')).toBe(true); // accounting history: authenticates nobody
  });

  it('no seeded value anywhere looks like a password attribute', async () => {
    const rows = (n: number, extra: (i: number) => any = () => ({})) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, ...extra(i) }));
    const { prisma, calls } = recordingPrisma({
      'subscriber.count': jest.fn(async () => 0),
      'nas.count': jest.fn(async () => 0),
      'area.createManyAndReturn': jest.fn(async () => rows(20, (i) => ({ name: `A${i}` }))),
      'nas.findMany': jest.fn(async () => rows(500, (i) => ({ nasIp: `10.255.0.${i % 250}` }))),
      'ipPool.findMany': jest.fn(async () => rows(50)),
      'package.findMany': jest.fn(async () => rows(12, () => ({ price: 1000 }))),
      'subscriber.findMany': jest.fn(async () =>
        rows(5, (i) => ({ username: `demo-0000${i + 1}`, nasId: 1, status: 'ACTIVE' })),
      ),
    });
    await new DemoDataService(prisma).seedForUser(1, 5);

    // Catches a future re-introduction under a different model name — the
    // failure mode this guards against is someone adding it back by hand.
    const serialized = JSON.stringify(
      calls.filter((c) => c.method === 'createMany').map((c) => c.arg),
      // radacct counters are BigInt, which JSON.stringify refuses outright.
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(serialized).not.toMatch(/Cleartext-Password/);
  });

  // ── revoking what is already out there ───────────────────────────────────
  /**
   * A fix that only applies to future installs leaves every existing one
   * exposed, and nobody re-reads a seeder to discover that.
   */
  it('revokes credentials already written, scoped through the owner', async () => {
    const { prisma } = recordingPrisma();
    const svc = new DemoRepairService(prisma, {} as any);
    await svc.revokeDemoRadiusCredentials();

    const sql: string[] = prisma.$executeRawUnsafe.mock.calls.map((c: any[]) => c[0]);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toMatch(/DELETE FROM radcheck/);
    expect(sql[1]).toMatch(/DELETE FROM radreply/);

    for (const s of sql) {
      // Ownership, never a username pattern. A LIKE 'demo-%' would delete the
      // credentials of a real customer called "demo-fibre" and take them off
      // the network — worse than the problem being fixed.
      expect(s).toMatch(/"isDemo" = true/);
      expect(s).not.toMatch(/LIKE/i);
    }
  });

  // ── keeping the demo alive ───────────────────────────────────────────────
  /**
   * "Online now" only counts a session updated in the last 15 minutes. Nothing
   * updated a seeded one, so the demo showed ~2,500 online for a quarter of an
   * hour after the weekly reset and an empty network for the rest of the week —
   * which is when almost every visitor arrived.
   */
  it('refreshes only demo-owned, still-open sessions', async () => {
    const { prisma } = recordingPrisma();
    delete process.env.CRON_DISABLED;
    delete process.env.JOINTBOX_ROLE;
    process.env.NODE_APP_INSTANCE = '0';

    await new DemoRepairService(prisma, {} as any).refreshDemoSessions();
    const sql: string = prisma.$executeRawUnsafe.mock.calls[0][0];

    expect(sql).toMatch(/UPDATE radacct/);
    expect(sql).toMatch(/u\."isDemo" = true/);      // never a real subscriber
    expect(sql).toMatch(/a\.acctstoptime IS NULL/); // never revive a closed session
    expect(sql).toMatch(/acctinputoctets/);         // counters move, so graphs aren't flat
  });

  it('runs on one worker only — twelve would fight over the same rows', async () => {
    const { prisma } = recordingPrisma();
    process.env.NODE_APP_INSTANCE = '5';
    await new DemoRepairService(prisma, {} as any).refreshDemoSessions();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    process.env.NODE_APP_INSTANCE = '0';
  });

  it('does nothing when the public demo is switched off', async () => {
    const { prisma } = recordingPrisma();
    process.env.NODE_APP_INSTANCE = '0';
    process.env.DEMO_PUBLIC = '0';
    await new DemoRepairService(prisma, {} as any).refreshDemoSessions();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    delete process.env.DEMO_PUBLIC;
  });
});
