import { HttpException } from '@nestjs/common';
import { LicenceCapacityService } from './licence-capacity.service';

/**
 * THE CAP MUST REFUSE EXACTLY ONE THING, AND ONLY WHEN IT IS SURE.
 *
 * Two failure directions, both expensive:
 *
 *  - Too lax, and the plan tiers are decoration. A Basic customer runs 5,000
 *    subscribers on an 800 plan and the price list means nothing.
 *  - Too strict, and a paying ISP cannot add a customer because our agent is
 *    stopped, or their licence server is a version behind. That is a support
 *    emergency caused entirely by us.
 *
 * The second is worse, so every uncertain state here resolves to "allow", and
 * most of these tests exist to pin that.
 */
describe('licence: plan capacity', () => {
  const ORIGINAL_ENV = process.env.JBX_LICENCE_ENFORCE;

  /** Rows the fake table holds. The service must never ask for the count. */
  function make(opts: {
    rows?: number;
    capHard?: number;
    maxNas?: number;
    hasEntitlement?: boolean;
    plan?: string;
    maxSubs?: number;
    throws?: boolean;
  }) {
    const rows = opts.rows ?? 0;
    const calls: Array<{ sql: string; offset: number }> = [];

    const prisma: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, offset: number) => {
        if (opts.throws) throw new Error('connection terminated');
        calls.push({ sql, offset });
        // OFFSET n LIMIT 1 yields a row only when the table has at least n+1.
        return rows >= offset + 1 ? [{ one: 1 }] : [];
      }),
    };

    const licence: any = {
      capHard: opts.capHard ?? 0,
      maxNas: opts.maxNas ?? 0,
      maxSubscribers: opts.maxSubs ?? opts.capHard ?? 0,
      hasEntitlement: opts.hasEntitlement ?? true,
      status: () => ({ plan: opts.plan ?? 'basic' }),
    };

    return { svc: new LicenceCapacityService(prisma, licence), prisma, calls };
  }

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.JBX_LICENCE_ENFORCE;
    else process.env.JBX_LICENCE_ENFORCE = ORIGINAL_ENV;
  });

  // ── the boundary, exactly ───────────────────────────────────────────────

  it('allows the record that fills the cap', async () => {
    // 799 existing on a cap of 800: creating the 800th is allowed.
    const { svc } = make({ rows: 799, capHard: 800 });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
  });

  it('refuses the one after', async () => {
    const { svc } = make({ rows: 800, capHard: 800 });
    await expect(svc.assertCanAddSubscriber()).rejects.toBeInstanceOf(HttpException);
  });

  it('asks the database the bounded question, not for a count', async () => {
    const { svc, calls } = make({ rows: 10, capHard: 800 });
    await svc.assertCanAddSubscriber();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('OFFSET');
    expect(calls[0].sql).toContain('LIMIT 1');
    expect(calls[0].sql).not.toMatch(/COUNT/i);
    // offset = cap - 1, so Postgres stops after `cap` rows however big the
    // table is. This is the whole reason the check is cheap on the hot path.
    expect(calls[0].offset).toBe(799);
  });

  // ── every reason to fail open ───────────────────────────────────────────

  it('allows when licensing is switched off', async () => {
    process.env.JBX_LICENCE_ENFORCE = 'false';
    const { svc, prisma } = make({ rows: 99999, capHard: 800 });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('allows when the agent has given us no entitlement', async () => {
    // Agent missing, stopped, or never installed. Not a lapse — our problem.
    const { svc, prisma } = make({ rows: 99999, capHard: 800, hasEntitlement: false });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('allows when the cap is 0, the unlimited convention', async () => {
    const { svc } = make({ rows: 99999, capHard: 0 });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
  });

  it('allows when the licence server is too old to send a cap', async () => {
    // A licence server before migration 002 signs no cap_hard at all, so the
    // getter returns 0. An out-of-date licence server must not stop sales.
    const { svc } = make({ rows: 99999, capHard: undefined as any });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
  });

  it('allows when the capacity query itself fails', async () => {
    const { svc } = make({ rows: 99999, capHard: 800, throws: true });
    await expect(svc.assertCanAddSubscriber()).resolves.toBeUndefined();
  });

  // ── what the operator is told ───────────────────────────────────────────

  it('answers 402 so the frontend shows the licence dialog, not an error toast', async () => {
    const { svc } = make({ rows: 800, capHard: 800, maxSubs: 800, plan: 'basic' });
    const err = await svc.assertCanAddSubscriber().catch((e) => e);
    expect(err.getStatus()).toBe(402);
    const body: any = err.getResponse();
    expect(body.error).toBe('LICENCE_CAP_REACHED');
    expect(body.limit).toBe(800);
  });

  /**
   * The single most important assertion in this file. An operator refused at
   * 2am needs to know in the same breath that nobody went offline, or the next
   * thing they do is start restarting services.
   */
  it('says plainly that nobody was disconnected', async () => {
    const { svc } = make({ rows: 800, capHard: 800 });
    const err = await svc.assertCanAddSubscriber().catch((e) => e);
    const body: any = err.getResponse();
    expect(body.detail).toMatch(/nobody has been disconnected/i);
    expect(body.detail).toMatch(/authentication, accounting and bandwidth/i);
  });

  it('names the overage allowance when the hard limit exceeds the sold cap', async () => {
    // Basic: 800 sold, 10% overage, so cap_hard is 880. The operator should be
    // told both numbers — otherwise "limit 800" contradicts what just happened.
    const { svc } = make({ rows: 880, capHard: 880, maxSubs: 800 });
    const err = await svc.assertCanAddSubscriber().catch((e) => e);
    const body: any = err.getResponse();
    expect(body.message).toContain('800');
    expect(body.message).toContain('880');
    expect(body.hardLimit).toBe(880);
  });

  // ── NAS ─────────────────────────────────────────────────────────────────

  it('enforces the NAS cap on its own number', async () => {
    const { svc, calls } = make({ rows: 10, maxNas: 10 });
    await expect(svc.assertCanAddNas()).rejects.toBeInstanceOf(HttpException);
    expect(calls[0].sql).toContain('"Nas"');
  });

  it('does not refuse NAS when only the subscriber cap is reached', async () => {
    const { svc } = make({ rows: 5, capHard: 800, maxNas: 0 });
    await expect(svc.assertCanAddNas()).resolves.toBeUndefined();
  });

  /**
   * RATCHET. The table name is interpolated into SQL rather than bound, which
   * is safe only while every call site passes a literal. If a future change
   * ever lets a request-supplied name reach it, that is an injection, and this
   * test is the thing standing in the way.
   */
  it('never builds its SQL from anything but a literal table name', () => {
    const src = require('fs').readFileSync(__dirname + '/licence-capacity.service.ts', 'utf8');
    const callSites = src.match(/this\.atLeast\(\s*'[A-Za-z]+'\s*,/g) || [];
    const allCalls = src.match(/this\.atLeast\(/g) || [];
    expect(allCalls.length).toBeGreaterThan(0);
    expect(callSites.length).toBe(allCalls.length);
  });
});
