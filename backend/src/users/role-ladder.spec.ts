import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * ROLE LADDER — privilege-escalation regression tests.
 *
 * THE HOLE THESE CLOSE
 *
 * create() enforced a strict one-level-down ladder (ISP → Franchise → Dealer →
 * Retailer). update() did not: `role` passed straight through into the Prisma
 * update. And update() also accepts `password`.
 *
 * So a franchise could take its own dealer — an account inside its subtree, so
 * scope.assertUser() permitted the edit — set that account's role to ADMIN, set
 * its password, and sign in with full ISP access. isAdmin() bypasses every
 * scope check in the product, so that is total privilege escalation from a
 * mid-tier reseller account.
 *
 * A second, quieter hole was in the ladder check itself: it read
 * `const allowed = nextRole[parent.role]` and then tested `if (allowed && …)`,
 * so a parent whose role was NOT a key in that map yielded `undefined` and
 * silently passed. SALES and AUDITOR are exactly such roles.
 *
 * The rule is now one shared method, and both paths call it.
 */
describe('UsersService — role ladder', () => {
  const ADMIN = { role: 'ADMIN', sub: 1 } as any;
  const FRANCHISE = { role: 'RESELLER', sub: 2 } as any;

  function makeService(opts: { target?: any; parent?: any; childCount?: number } = {}) {
    const prisma: any = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 3 }),
        count: jest.fn().mockResolvedValue(opts.childCount ?? 0),
      },
    };
    // First findUnique in update() is the email-uniqueness / target lookup, and
    // later ones resolve the parent. Route by the `where` shape instead of call
    // order so the tests do not depend on internal sequencing.
    const target = opts.target ?? { id: 3, role: 'RETAILER', parentId: 2, email: 'd@x.com' };
    const parent = opts.parent ?? { id: 2, role: 'RESELLER' };
    prisma.user.findUnique.mockImplementation(({ where }: any) => {
      if (where?.id === target.id) return Promise.resolve(target);
      if (where?.id === parent.id) return Promise.resolve(parent);
      if (where?.email) return Promise.resolve(null); // no email clash
      return Promise.resolve(null);
    });

    const scope: any = {
      isAdmin: jest.fn((r: string) => r === 'ADMIN' || r === 'SUPER_ADMIN'),
      assertUser: jest.fn().mockResolvedValue(undefined),
      actorId: jest.fn().mockReturnValue(2),
    };
    return { prisma, scope, svc: new UsersService(prisma, scope) };
  }

  // ───────────────────────────────────────────────────────────────
  // The escalation itself
  // ───────────────────────────────────────────────────────────────
  describe('the privilege-escalation path', () => {
    it('BLOCKS a franchise promoting its own dealer to ADMIN', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.update(3, { role: 'ADMIN' }, FRANCHISE)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('BLOCKS the same promotion to SUPER_ADMIN', async () => {
      const { svc, prisma } = makeService();
      await expect(svc.update(3, { role: 'SUPER_ADMIN' }, FRANCHISE)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('BLOCKS escalate-and-set-password in one request', async () => {
      const { svc, prisma } = makeService();
      // The full attack: become an admin AND take a known password.
      await expect(
        svc.update(3, { role: 'ADMIN', password: 'Passw0rd123' }, FRANCHISE),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('BLOCKS skipping a rung — dealer promoted straight past its tier', async () => {
      // Target sits under a Franchise, so only SUB_RESELLER (Dealer) is legal.
      const { svc } = makeService();
      await expect(svc.update(3, { role: 'RESELLER' }, ADMIN)).rejects.toThrow(/can only have a Dealer/);
    });

    it('BLOCKS an escalation smuggled in alongside a re-parent', async () => {
      // Re-parenting to a Dealer, then claiming ADMIN. The role must be judged
      // against the parent the account will actually have.
      const { svc } = makeService({
        target: { id: 3, role: 'RETAILER', parentId: 2, email: 'd@x.com' },
        parent: { id: 9, role: 'SUB_RESELLER' },
      });
      await expect(
        svc.update(3, { role: 'ADMIN', parentId: 9 }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // The fall-through hole: unknown parent role must fail closed
  // ───────────────────────────────────────────────────────────────
  describe('unknown parent roles fail closed', () => {
    it('refuses a sub-account beneath a STAFF account', async () => {
      const { svc } = makeService({ parent: { id: 2, role: 'SALES' } });
      // Old code: NEXT_ROLE['SALES'] === undefined → validation silently passed.
      await expect(svc.update(3, { role: 'ADMIN' }, ADMIN)).rejects.toThrow(/cannot have sub-accounts/);
    });

    it('refuses a sub-account beneath an AUDITOR account', async () => {
      const { svc } = makeService({ parent: { id: 2, role: 'AUDITOR' } });
      await expect(svc.update(3, { role: 'RESELLER' }, ADMIN)).rejects.toThrow(/cannot have sub-accounts/);
    });

    it('refuses a sub-reseller beneath a RETAILER (explicit end of the ladder)', async () => {
      // Target is currently RETAILER, so ask for a DIFFERENT role — an
      // unchanged role legitimately skips the ladder check.
      const { svc } = makeService({ parent: { id: 2, role: 'RETAILER' } });
      await expect(svc.update(3, { role: 'SUB_RESELLER' }, ADMIN)).rejects.toThrow(
        /only have Staff accounts/,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Legitimate changes must still work
  // ───────────────────────────────────────────────────────────────
  describe('legitimate role changes', () => {
    it('allows the ladder-correct tier under a franchise', async () => {
      const { svc, prisma } = makeService();
      await svc.update(3, { role: 'SUB_RESELLER' }, ADMIN);
      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.user.update.mock.calls[0][0].data.role).toBe('SUB_RESELLER');
    });

    it('allows STAFF under any tier', async () => {
      const { svc, prisma } = makeService({ parent: { id: 2, role: 'RETAILER' } });
      await svc.update(3, { role: 'SALES' }, ADMIN);
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('allows an AUDITOR only under the ISP', async () => {
      const ok = makeService({ parent: { id: 2, role: 'ADMIN' } });
      await ok.svc.update(3, { role: 'AUDITOR' }, ADMIN);
      expect(ok.prisma.user.update).toHaveBeenCalled();

      const bad = makeService({ parent: { id: 2, role: 'RESELLER' } });
      await expect(bad.svc.update(3, { role: 'AUDITOR' }, ADMIN)).rejects.toThrow(/Only the ISP owner/);
    });

    it('does not run the ladder check when the role is unchanged', async () => {
      // An ordinary edit (name, phone) must not be blocked by role rules.
      const { svc, prisma } = makeService({ childCount: 5 });
      await svc.update(3, { name: 'New Name', role: 'RETAILER' }, ADMIN);
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('does not run the ladder check when no role is supplied at all', async () => {
      const { svc, prisma } = makeService({ childCount: 5 });
      await svc.update(3, { phone: '0300' }, ADMIN);
      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Re-roling an account that has a downline
  // ───────────────────────────────────────────────────────────────
  describe('accounts with a downline', () => {
    it('REFUSES to re-role an account that has accounts beneath it', async () => {
      // Demotion is the dangerous direction: a Franchise demoted to Retailer
      // would keep dealers under it that it may no longer legitimately hold,
      // and their pricing ladder would break.
      const { svc, prisma } = makeService({ childCount: 12 });
      await expect(svc.update(3, { role: 'SUB_RESELLER' }, ADMIN)).rejects.toThrow(/12 accounts beneath it/);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('names the count so the operator knows what to move first', async () => {
      const { svc } = makeService({ childCount: 1 });
      await expect(svc.update(3, { role: 'SUB_RESELLER' }, ADMIN)).rejects.toThrow(/1 account beneath it/);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Root accounts
  // ───────────────────────────────────────────────────────────────
  describe('top-level accounts', () => {
    const root = { id: 3, role: 'ADMIN', parentId: null, email: 'isp@x.com' };

    it('lets only an ISP owner re-role a parentless account', async () => {
      const { svc, prisma } = makeService({ target: root });
      await svc.update(3, { role: 'RESELLER' }, ADMIN);
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('refuses a non-admin re-roling a parentless account', async () => {
      // Root is already ADMIN, so ask for a different role to exercise the check.
      const { svc, prisma } = makeService({ target: root });
      await expect(svc.update(3, { role: 'RESELLER' }, FRANCHISE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
