import { BadRequestException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';

/**
 * HOTSPOT CARD REDEMPTION — the only unauthenticated money path in the panel.
 *
 * WHAT THIS FEATURE IS FOR
 * A hotspot customer walks into a cafe, buys a printed card, and has no
 * account. redeemVoucher() cannot serve them: it requires a subscriberId,
 * which by definition does not exist yet. So the card itself has to become the
 * RADIUS credential. That makes this endpoint different from every other one
 * in the codebase — it is public, and what it hands back is internet access.
 *
 * WHY EACH TEST BELOW IS A MONEY TEST, NOT A TIDINESS TEST
 *
 *  1. NON-ENUMERABILITY. A card is bearer value and the code is often
 *     printed in a guessable series. If a wrong PIN said "wrong PIN" while an
 *     unknown code said "no such card", the endpoint would be a free oracle
 *     for harvesting live codes — the attacker learns which of a million
 *     guesses are real cards, then brute-forces only those. Every refusal must
 *     be byte-identical.
 *  2. ATOMIC CLAIM. Two phones submitting the same code at the same instant
 *     must produce exactly one activation. A read-then-write would sell one
 *     card twice; the conditional updateMany is what makes the loser lose.
 *  3. ROLLBACK ON RADIUS FAILURE. The customer has already paid cash. If the
 *     card were marked USED and the RADIUS push then failed, their money is
 *     gone and they are still offline, with no staff recourse. The card goes
 *     back to UNUSED so they can simply try again.
 *  4. REFUSAL WITHOUT A PACKAGE. A card with no plan authenticates the user
 *     and applies NO rate limit — an unlimited session sold as an hour card.
 *     That is a revenue leak that looks like success, so it must be a hard
 *     refusal, not a default.
 *
 * WHAT THESE TESTS CANNOT PROVE: Prisma is mocked, so they verify the
 * service's logic, not that `Voucher.packageId` exists in the generated
 * client. Run `npx prisma generate && npm run build` before deploying.
 */
describe('VouchersService — hotspot card redemption', () => {
  const PKG = {
    id: 3,
    name: 'Hotspot 1 Day',
    downloadSpeed: 10,
    uploadSpeed: 5,
  };

  function makeService(
    opts: { voucher?: any; claimCount?: number; radiusFails?: boolean } = {},
  ) {
    const prisma: any = {
      voucher: {
        findUnique: jest.fn().mockResolvedValue(opts.voucher ?? null),
        updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const scope: any = { isAdmin: jest.fn(), rootId: jest.fn(), descendantIds: jest.fn() };
    const radius: any = {
      syncSubscriberProfile: opts.radiusFails
        ? jest.fn().mockRejectedValue(new Error('radius down'))
        : jest.fn().mockResolvedValue(undefined),
    };
    return { prisma, radius, svc: new VouchersService(prisma, scope, radius) };
  }

  const card = (over: any = {}) => ({
    id: 1,
    code: 'ABC123',
    pin: '445566',
    status: 'UNUSED',
    validityDays: 1,
    dataQuota: null,
    expireDate: null,
    package: PKG,
    ...over,
  });

  async function refusalFrom(svc: VouchersService, code: string, pin: string) {
    try {
      await svc.redeemAtHotspot(code, pin);
      throw new Error('expected a refusal');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      return e.message as string;
    }
  }

  // ───────────────────────────────────────────────────────────────
  // 1 — the endpoint must not tell an attacker which codes are real
  // ───────────────────────────────────────────────────────────────
  describe('non-enumerability', () => {
    it('returns the SAME message for unknown code, wrong PIN, used and expired', async () => {
      const unknown = await refusalFrom(makeService({ voucher: null }).svc, 'NOPE', '000000');
      const wrongPin = await refusalFrom(
        makeService({ voucher: card() }).svc,
        'ABC123',
        '999999',
      );
      const used = await refusalFrom(
        makeService({ voucher: card({ status: 'USED' }) }).svc,
        'ABC123',
        '445566',
      );
      const expired = await refusalFrom(
        makeService({ voucher: card({ expireDate: new Date(Date.now() - 86_400_000) }) }).svc,
        'ABC123',
        '445566',
      );

      // One distinct message across all four. If this ever fails, the endpoint
      // has become a code-harvesting oracle.
      expect(new Set([unknown, wrongPin, used, expired]).size).toBe(1);
    });

    it('never echoes the submitted code or PIN back in the refusal', async () => {
      const msg = await refusalFrom(makeService({ voucher: null }).svc, 'ABC123', '445566');
      expect(msg).not.toContain('ABC123');
      expect(msg).not.toContain('445566');
    });

    it('refuses a blank code or PIN without even reaching the database', async () => {
      const { svc, prisma } = makeService({ voucher: card() });
      await refusalFrom(svc, '', '445566');
      await refusalFrom(svc, 'ABC123', '   ');
      expect(prisma.voucher.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a lowercase, padded code — a real customer types it by hand', async () => {
      const { svc, prisma } = makeService({ voucher: card() });
      await svc.redeemAtHotspot('  abc123 ', ' 445566 ');
      expect(prisma.voucher.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: 'ABC123' } }),
      );
    });

    it('marks a lapsed card EXPIRED so it stops being retried', async () => {
      const { svc, prisma } = makeService({
        voucher: card({ expireDate: new Date(Date.now() - 1000) }),
      });
      await refusalFrom(svc, 'ABC123', '445566');
      expect(prisma.voucher.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'EXPIRED' } }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 2 — one card, one activation, even under a race
  // ───────────────────────────────────────────────────────────────
  describe('double-spend', () => {
    it('claims the card with a status-guarded conditional update', async () => {
      const { svc, prisma } = makeService({ voucher: card() });
      await svc.redeemAtHotspot('ABC123', '445566');

      // The guard is the whole defence: without `status: 'UNUSED'` in the
      // WHERE clause, two concurrent requests both write USED and both win.
      const where = prisma.voucher.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 1, status: 'UNUSED' });
    });

    it('refuses the loser of a race, and does NOT push credentials for them', async () => {
      // claimCount 0 = another request flipped the row first.
      const { svc, radius } = makeService({ voucher: card(), claimCount: 0 });
      await refusalFrom(svc, 'ABC123', '445566');
      expect(radius.syncSubscriberProfile).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 3 — a paying customer is never burned by our own outage
  // ───────────────────────────────────────────────────────────────
  describe('RADIUS failure', () => {
    it('releases the card back to UNUSED when activation fails', async () => {
      const { svc, prisma } = makeService({ voucher: card(), radiusFails: true });
      await refusalFrom(svc, 'ABC123', '445566');

      const rollback = prisma.voucher.update.mock.calls.find(
        (c: any[]) => c[0]?.data?.status === 'UNUSED',
      );
      expect(rollback).toBeTruthy();
      // usedAt/activatedAt must clear too, or the card reads as "spent once".
      expect(rollback[0].data).toMatchObject({
        status: 'UNUSED',
        usedAt: null,
        activatedAt: null,
      });
    });

    it('tells the customer to retry rather than leaking the RADIUS error', async () => {
      const { svc } = makeService({ voucher: card(), radiusFails: true });
      const msg = await refusalFrom(svc, 'ABC123', '445566');
      expect(msg).not.toMatch(/radius/i);
      expect(msg).toMatch(/try again/i);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 4 — a card with no plan is an unlimited session
  // ───────────────────────────────────────────────────────────────
  describe('missing package', () => {
    it('refuses rather than granting an unrated session', async () => {
      const { svc, prisma, radius } = makeService({ voucher: card({ package: null }) });
      await refusalFrom(svc, 'ABC123', '445566');
      expect(radius.syncSubscriberProfile).not.toHaveBeenCalled();
      // And the card is NOT consumed — it is a misconfiguration, not a spend.
      expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // 5 — what the router is actually told
  // ───────────────────────────────────────────────────────────────
  describe('successful activation', () => {
    it('returns the card as the credential pair', async () => {
      const { svc } = makeService({ voucher: card() });
      const out = await svc.redeemAtHotspot('ABC123', '445566');
      expect(out).toMatchObject({ username: 'ABC123', password: '445566' });
    });

    it('sells TIME: validityDays becomes a Session-Timeout in seconds', async () => {
      const { svc, radius } = makeService({ voucher: card({ validityDays: 1 }) });
      const out = await svc.redeemAtHotspot('ABC123', '445566');

      expect(out.minutes).toBe(1440);
      const opts = radius.syncSubscriberProfile.mock.calls[0][3];
      expect(opts.sessionTimeout).toBe(1440 * 60);
      expect(opts.serviceType).toBe('HOTSPOT');
    });

    it('binds the session to the MAC the router supplied', async () => {
      const { svc, radius } = makeService({ voucher: card() });
      await svc.redeemAtHotspot('ABC123', '445566', { macAddress: 'AA:BB:CC:DD:EE:FF' });
      expect(radius.syncSubscriberProfile.mock.calls[0][3].macAddress).toBe(
        'AA:BB:CC:DD:EE:FF',
      );
    });

    it('pushes the package so the router applies a rate limit', async () => {
      const { svc, radius } = makeService({ voucher: card() });
      await svc.redeemAtHotspot('ABC123', '445566');
      const [username, password, pkg] = radius.syncSubscriberProfile.mock.calls[0];
      expect(username).toBe('ABC123');
      expect(password).toBe('445566');
      expect(pkg).toMatchObject({ downloadSpeed: 10, uploadSpeed: 5 });
    });
  });
});
