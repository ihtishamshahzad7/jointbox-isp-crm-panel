import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { PermissionsGuard } from '../security/permissions.guard';

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
  const strategy = () => new JwtStrategy({ isBlacklisted: () => false } as any);

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
