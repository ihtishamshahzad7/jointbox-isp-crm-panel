import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SseAuthGuard } from './sse-auth.guard';

/**
 * `curl -N http://host:3001/events` MUST NOT RETURN A STREAM.
 *
 * That one command was the whole finding. The controller imported a guard and
 * documented that a token was required; it never applied one. Every payment
 * (amount, invoice number) and every operator login (email address) went to
 * any anonymous client that asked, across all tenants.
 *
 * These tests pin both halves: the endpoint is guarded, and the guard accepts
 * the only credential channel `EventSource` actually has.
 */
describe('security: the SSE stream is authenticated', () => {
  const SECRET = 'test-secret';
  const jwt = new JwtService({ secret: SECRET });
  const guard = new SseAuthGuard(jwt);
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

  const operator = jwt.sign({ sub: 7, email: 'ops@isp.pk', role: 'RESELLER' });
  const portal = jwt.sign({ sub: 1, username: 'demo-1', scope: 'subscriber' });

  it('THE BUG: an anonymous request is refused', () => {
    expect(() => guard.canActivate(ctx({ headers: {}, query: {} }))).toThrow(UnauthorizedException);
  });

  it('a query-string token works, because EventSource cannot send a header', () => {
    const req: any = { headers: {}, query: { token: operator } };
    expect(guard.canActivate(ctx(req))).toBe(true);
    expect(req.user).toMatchObject({ sub: 7, role: 'RESELLER' });
  });

  it('a bearer header works too, and takes precedence', () => {
    const req: any = { headers: { authorization: `Bearer ${operator}` }, query: { token: 'garbage' } };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it('a customer portal token cannot read the operator event bus', () => {
    // Same secret, same signature — `scope` is the only separation there is.
    expect(() => guard.canActivate(ctx({ headers: {}, query: { token: portal } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('a roleless but validly signed token is refused', () => {
    const roleless = jwt.sign({ sub: 3, email: 'x@y.z' });
    expect(() => guard.canActivate(ctx({ headers: {}, query: { token: roleless } }))).toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['forged', 'not.a.jwt'],
    ['wrong key', new JwtService({ secret: 'other' }).sign({ sub: 1, role: 'SUPER_ADMIN' })],
  ])('refuses a %s token', (_label, token) => {
    expect(() => guard.canActivate(ctx({ headers: {}, query: { token } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('an expired token is refused', () => {
    const dead = jwt.sign({ sub: 7, role: 'RESELLER' }, { expiresIn: '-1s' });
    expect(() => guard.canActivate(ctx({ headers: {}, query: { token: dead } }))).toThrow(
      UnauthorizedException,
    );
  });

  /**
   * THE RATCHET.
   *
   * The original failure was not a missing guard class — it was a guard that
   * existed, was imported, and was never attached. Only reading the source
   * catches that shape of bug, so the test reads the source.
   */
  it('every route on the events controller carries the guard', () => {
    const src = require('fs').readFileSync(__dirname + '/events.controller.ts', 'utf8');
    const routes = src.match(/@Get\(/g) || [];
    const guards = src.match(/@UseGuards\(SseAuthGuard\)/g) || [];
    expect(routes.length).toBeGreaterThan(0);
    expect(guards.length).toBe(routes.length);
  });

  /**
   * And the query-string exception stays confined to this guard. If `?token=`
   * is ever taught to the operator strategy, every route in the API starts
   * accepting credentials that land in access logs and Referer headers.
   */
  it('the operator strategy still reads the header only', () => {
    const src = require('fs').readFileSync(__dirname + '/../auth/jwt.strategy.ts', 'utf8');
    expect(src).toContain('ExtractJwt.fromAuthHeaderAsBearerToken()');
    expect(src).not.toMatch(/fromUrlQueryParameter|query\.token/);
  });
});
