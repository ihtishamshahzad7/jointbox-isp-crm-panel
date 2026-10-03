import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { PermissionsGuard } from '../security/permissions.guard';
import { invalidateAllAccountStatus } from './account-status';

/**
 * A SUBSCRIBER PORTAL TOKEN MUST NEVER BE AN OPERATOR TOKEN.
 *
 * THE BUG THIS CLOSES — three correct-looking pieces that combined into a full
 * authentication bypass:
 *
 *  1. `portal.service.ts` signs customer tokens with the SAME JwtService and
 *     therefore the same JWT_SECRET: `{ sub: <subscriberId>, scope:'subscriber' }`,
 *     valid for 30 days. The portal's own guard checks that scope.
 *  2. `JwtStrategy.validate` — the operator strategy — never looked at `scope`.
 *     A portal token verified perfectly: right signature, not expired, not
 *     blacklisted. `payload.role` simply came back undefined.
 *  3. `PermissionsGuard` read that undefined role and returned `true`, on the
 *     reasoning that "no role" meant an unauthenticated route with its own
 *     guard. The permission matrix, the AUDITOR floor and ISP_ONLY_WRITE were
 *     all skipped.
 *
 * What made it critical rather than merely wrong: `ScopeService` keys on
 * `req.user.sub`, and `sub` here is a SUBSCRIBER id being read as a USER id.
 * A customer whose subscriber id collides with an operator's user id inherits
 * that operator's whole subtree — and user id 1 is the SUPER_ADMIN that
 * `main.ts` creates on first boot.
 *
 * So the exploit was: log into the customer portal with your own PPPoE
 * password, take the token, point it at the operator API.
 */
describe('security: portal tokens are not operator tokens', () => {
  /**
   * The strategy now asks the database whether the account may act (suspended?
   * must change password?). An active, unremarkable account by default, so the
   * scope tests below keep testing scope and nothing else.
   */
  const prismaFor = (
    u: { isActive?: boolean; mustChangePassword?: boolean } | null = {},
    chainActive = true,
  ) => ({
    user: {
      findUnique: async () =>
        u ? { isActive: u.isActive ?? true, mustChangePassword: u.mustChangePassword ?? false } : null,
    },
    $queryRaw: async () => [{ ok: chainActive }],
  }) as any;
  const strategy = (prisma = prismaFor()) => new JwtStrategy({ isBlacklisted: () => false } as any, prisma);
  // The status cache is per user id and module-level; each test starts cold.
  beforeEach(() => invalidateAllAccountStatus());

  // ── the strategy ─────────────────────────────────────────────────────────
  it('THE FIX: a subscriber-scoped token is refused by the operator strategy', async () => {
    await expect(
      strategy().validate({ headers: {} }, { sub: 1, username: 'demo-1', scope: 'subscriber' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an operator token still passes', async () => {
    const user = await strategy().validate(
      { headers: {} },
      { sub: 7, email: 'a@b.c', role: 'RESELLER', name: 'A' },
    );
    expect(user).toMatchObject({ sub: 7, role: 'RESELLER' });
  });

  /**
   * Any future scope must fail closed. If someone adds a third token type — an
   * installer app, a kiosk — it must be refused here until it is deliberately
   * allowed, rather than inheriting operator access by being unrecognised.
   */
  it.each(['subscriber', 'portal', 'kiosk', 'installer', ''])(
    'refuses the scope %p rather than guessing',
    async (scope) => {
      const p = strategy().validate({ headers: {} }, { sub: 1, scope, role: 'RESELLER' });
      if (scope === '') {
        // An empty scope is absent-equivalent and must behave like a normal token.
        await expect(p).resolves.toBeDefined();
      } else {
        await expect(p).rejects.toBeInstanceOf(UnauthorizedException);
      }
    },
  );

  // ── the guard ────────────────────────────────────────────────────────────
  const guard = () => new PermissionsGuard({ get: jest.fn() } as any, {} as any);
  const ctx = (user: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, method: 'GET', path: '/subscribers' }) }),
    }) as any;

  it('THE SECOND LOCK: an authenticated principal with no role is refused', async () => {
    // Defence in depth. Even if a roleless principal reaches the guard by some
    // other route, it must not be treated as "nothing to check".
    await expect(guard().canActivate(ctx({ sub: 1 }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a genuinely unauthenticated request still defers to the route own guard', async () => {
    // `req.user` absent is the real "public route" case and must stay allowed,
    // or every login and health endpoint breaks.
    await expect(guard().canActivate(ctx(undefined))).resolves.toBe(true);
  });

  /**
   * The structural fix, stated as a test so it is not lost: the two token
   * populations share a signing key. Until they have separate keys or an
   * audience claim, `scope` is the only thing separating a customer from an
   * operator — so nothing may strip it.
   */
  it('the portal still stamps a scope on every token it signs', () => {
    const src = require('fs').readFileSync(__dirname + '/../portal/portal.service.ts', 'utf8');
    const signs = src.match(/this\.jwt\.sign\(/g) || [];
    const scoped = src.match(/scope:\s*'subscriber'/g) || [];
    expect(signs.length).toBeGreaterThan(0);
    expect(scoped.length).toBe(signs.length);
  });
});

/**
 * SUSPENSION AND FORCED PASSWORD CHANGE.
 *
 * Nothing in the auth path used to read isActive: every "suspend" button in the
 * product changed a column no request consulted, so a suspended account kept
 * full access on the 7-day token it already held. These pin the strategy —
 * the one point every operator request passes — to enforcing both.
 */
describe('security: account status is enforced on every request', () => {
  const prismaFor = (
    u: { isActive?: boolean; mustChangePassword?: boolean } | null = {},
    chainActive = true,
  ) => ({
    user: {
      findUnique: async () =>
        u ? { isActive: u.isActive ?? true, mustChangePassword: u.mustChangePassword ?? false } : null,
    },
    $queryRaw: async () => [{ ok: chainActive }],
  }) as any;
  const strategy = (prisma: any) => new JwtStrategy({ isBlacklisted: () => false } as any, prisma);
  const req = (url = '/subscribers') => ({ headers: {}, originalUrl: url });
  const op = { sub: 11, email: 'a@b.c', role: 'ADMIN', name: 'A' };

  beforeEach(() => invalidateAllAccountStatus());

  it('refuses a suspended account holding a still-valid token', async () => {
    await expect(strategy(prismaFor({ isActive: false })).validate(req(), op))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an active account whose company (an ancestor) is suspended', async () => {
    await expect(strategy(prismaFor({}, false)).validate(req(), op))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token for an account that no longer exists', async () => {
    await expect(strategy(prismaFor(null)).validate(req(), op))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets the platform owner act-as a suspended company to investigate it', async () => {
    const user = await strategy(prismaFor({ isActive: false })).validate(req(), { ...op, imp: 1 });
    expect(user).toMatchObject({ sub: 11 });
  });

  it('blocks a must-change-password account from the rest of the API', async () => {
    await expect(strategy(prismaFor({ mustChangePassword: true })).validate(req('/subscribers'), op))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['/auth/change-password', '/auth/profile', '/auth/logout', '/profile', '/api/auth/change-password'])(
    'but still lets it reach %p',
    async (url) => {
      const user = await strategy(prismaFor({ mustChangePassword: true })).validate(req(url), op);
      expect(user).toMatchObject({ sub: 11, mustChangePassword: true });
    },
  );

  it('does not let a look-alike path through the change-password allowance', async () => {
    await expect(
      strategy(prismaFor({ mustChangePassword: true })).validate(req('/auth/change-password-and-more'), op),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
