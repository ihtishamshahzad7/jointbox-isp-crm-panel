import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * POST /auth/refresh and /auth/verify act on the token in the body, with no
 * authenticated request around it, so the operator strategy's checks never
 * run. A subscriber portal token (same signing secret, `sub` = SUBSCRIBER id)
 * must not be traded for an operator token of the USER with that id, and a
 * logged-out token must not mint a fresh one.
 *
 * The service is mocked: these assert only that the controller refuses before
 * the token ever reaches it.
 */
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: any) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;

const PORTAL = jwt({ sub: 1, username: 'cust1', scope: 'subscriber' });
const OPERATOR = jwt({ sub: 10, role: 'ADMIN' });
const OPERATOR_SCOPED = jwt({ sub: 10, role: 'ADMIN', scope: 'admin' });
const REVOKED = jwt({ sub: 1, role: 'SUPER_ADMIN' });

function make() {
  const authService = {
    refreshToken: jest.fn().mockResolvedValue({ token: 'new' }),
    verifyToken: jest.fn().mockResolvedValue({ valid: true, user: { id: 10 } }),
  } as any;
  const blacklist = { isBlacklisted: jest.fn((t: string) => t === REVOKED), add: jest.fn() } as any;
  return { authService, ctl: new AuthController(authService, blacklist) };
}

describe('auth: refresh / verify refuse tokens that are not live operator tokens', () => {
  it('refuses to refresh a subscriber portal token into an operator token', async () => {
    const { authService, ctl } = make();
    await expect(ctl.refresh({ token: PORTAL })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.refreshToken).not.toHaveBeenCalled();
  });

  it('does not reveal an operator profile for a portal token', async () => {
    const { authService, ctl } = make();
    await expect(ctl.verifyToken({ token: PORTAL })).resolves.toEqual({ valid: false, message: 'Invalid token' });
    expect(authService.verifyToken).not.toHaveBeenCalled();
  });

  it('refuses to refresh or verify a logged-out token', async () => {
    const { authService, ctl } = make();
    await expect(ctl.refresh({ token: REVOKED })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.verifyToken({ token: REVOKED })).resolves.toEqual({ valid: false, message: 'Token revoked' });
    expect(authService.refreshToken).not.toHaveBeenCalled();
    expect(authService.verifyToken).not.toHaveBeenCalled();
  });

  it('passes a live operator token through unchanged', async () => {
    const { authService, ctl } = make();
    await expect(ctl.refresh({ token: OPERATOR })).resolves.toEqual({ token: 'new' });
    await expect(ctl.refresh({ token: OPERATOR_SCOPED })).resolves.toEqual({ token: 'new' });
    await expect(ctl.verifyToken({ token: OPERATOR })).resolves.toEqual({ valid: true, user: { id: 10 } });
    expect(authService.refreshToken).toHaveBeenCalledWith(OPERATOR);
  });

  it('treats a missing or garbage token as invalid, as before', async () => {
    const { ctl } = make();
    await expect(ctl.refresh({} as any)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.verifyToken({} as any)).resolves.toEqual({ valid: false, message: 'Invalid token' });
  });
});

describe('auth: refreshing an "act as" session keeps it one', () => {
  const { AuthService } = jest.requireActual('./auth.service');
  function svc(byActive = true) {
    const signed: any[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 20
            ? { id: 20, email: 'd@x', role: 'RESELLER', name: 'Dealer', isActive: true, isDemo: false }
            : where.id === 1
              ? { isActive: byActive }
              : null,
        ),
      },
    };
    const jwtService: any = {
      verify: jest.fn((t: string) => JSON.parse(t)),
      sign: jest.fn((p: any, o: any) => { signed.push({ p, o }); return 'tok'; }),
    };
    return { s: new AuthService(prisma, jwtService, {} as any, {} as any, {} as any), signed };
  }

  it('keeps the imp claim and the 1-day lifetime', async () => {
    const { s, signed } = svc();
    await s.refreshToken(JSON.stringify({ sub: 20, imp: { by: 1, byName: 'Owner', byRole: 'SUPER_ADMIN' } }));
    expect(signed[0].p.imp).toEqual({ by: 1, byName: 'Owner', byRole: 'SUPER_ADMIN' });
    expect(signed[0].o.expiresIn).toBe('1d');
  });

  it('an ordinary session refreshes to 7 days with no imp', async () => {
    const { s, signed } = svc();
    await s.refreshToken(JSON.stringify({ sub: 20 }));
    expect(signed[0].p.imp).toBeUndefined();
    expect(signed[0].o.expiresIn).toBe('7d');
  });

  it('refuses when the operator who started it has been suspended', async () => {
    const { s } = svc(false);
    await expect(s.refreshToken(JSON.stringify({ sub: 20, imp: { by: 1 } }))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
