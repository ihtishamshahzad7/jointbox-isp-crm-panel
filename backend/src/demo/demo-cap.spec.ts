import { ForbiddenException } from '@nestjs/common';
import { DemoController } from './demo.controller';

/**
 * THE CAP HAS TO BOUND ROWS, NOT ACCOUNTS.
 *
 * `MAX_LIVE_DEMOS = 50` was written when a demo account was an empty franchise
 * shell, where fifty of them cost fifty rows. Seeding changed the unit price
 * without anyone revisiting the cap: each account now writes 10,000 subscribers,
 * 500 NAS, 50 pools, 20 areas and a 20-node reseller tree. Fifty of those is
 * half a million synthetic subscribers sharing the tables that hold the
 * operator's real customers — reachable from an unauthenticated POST.
 *
 * Two further holes made the stated limits weaker than they read:
 *   • the per-IP cooldown lived in a static Map in process memory while the
 *     panel runs twelve PM2 workers, so each worker enforced its own copy;
 *   • `liveCount()` then `create()` is read-then-write across those workers,
 *     so concurrent requests pass the 50 check together.
 *
 * The fix is to stop minting accounts by default and share one sandbox, which
 * makes the cost fixed however many visitors arrive. These tests pin that.
 */
describe('demo: bounded sandbox', () => {
  const ORIGINAL = process.env.DEMO_SELF_SERVE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEMO_SELF_SERVE;
    else process.env.DEMO_SELF_SERVE = ORIGINAL;
  });

  const makeDemo = () => ({
    publicCredentials: jest.fn(() => ({
      enabled: true,
      email: 'demo@jointbox.net',
      username: 'demo@jointbox.net',
      password: 'secret',
      role: 'Franchise (sandbox)',
      note: 'original',
    })),
    create: jest.fn(async () => ({ email: 'demo-abc@demo.jointbox' })),
    liveCount: jest.fn(async () => 0),
  });

  it('THE FIX: POST /demo/create writes nothing by default', async () => {
    delete process.env.DEMO_SELF_SERVE;
    const demo = makeDemo();
    const res: any = await new DemoController(demo as any).create('1.2.3.4');

    // The single most important assertion in this file: no account, therefore
    // no 10,000-row dataset, no matter how many times this is called.
    expect(demo.create).not.toHaveBeenCalled();
    expect(res.shared).toBe(true);
    expect(res.email).toBe('demo@jointbox.net');
  });

  it('stays bounded under a burst — 500 calls, still zero accounts created', async () => {
    delete process.env.DEMO_SELF_SERVE;
    const demo = makeDemo();
    const c = new DemoController(demo as any);
    // Distinct IPs, because the old per-IP cooldown would not have stopped
    // these either — this is the scripted-abuse shape the endpoint must survive.
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => c.create(`10.0.${(i / 250) | 0}.${i % 250}`)),
    );
    expect(demo.create).not.toHaveBeenCalled();
  });

  it('the visitor still gets working credentials, not an error', async () => {
    delete process.env.DEMO_SELF_SERVE;
    const demo = makeDemo();
    const res: any = await new DemoController(demo as any).create('1.2.3.4');
    // The login screen's "Try a NEW demo account" button must keep working; a
    // 403 there would read as a broken product to someone evaluating it.
    expect(res.password).toBeTruthy();
    expect(res.username).toBeTruthy();
    expect(res.note).toMatch(/real customer data is never exposed/i);
  });

  // ── the opt-in path still behaves ────────────────────────────────────────
  it('DEMO_SELF_SERVE=1 restores per-visitor accounts', async () => {
    process.env.DEMO_SELF_SERVE = '1';
    const demo = makeDemo();
    const res: any = await new DemoController(demo as any).create('9.9.9.9');
    expect(demo.create).toHaveBeenCalledTimes(1);
    expect(res.email).toBe('demo-abc@demo.jointbox');
  });

  it('and still refuses once capacity is reached', async () => {
    process.env.DEMO_SELF_SERVE = '1';
    const demo = makeDemo();
    demo.liveCount = jest.fn(async () => 50);
    await expect(new DemoController(demo as any).create('9.9.9.8')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(demo.create).not.toHaveBeenCalled();
  });

  it('only the exact value 1 enables self-serve', () => {
    for (const v of ['0', 'true', 'yes', '', 'on']) {
      process.env.DEMO_SELF_SERVE = v;
      expect(DemoController.selfServeEnabled()).toBe(false);
    }
    process.env.DEMO_SELF_SERVE = '1';
    expect(DemoController.selfServeEnabled()).toBe(true);
  });
});
