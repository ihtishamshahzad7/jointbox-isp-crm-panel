import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * AUTHENTICATION FOR THE SSE STREAM.
 *
 * ── The bug this closes ──────────────────────────────────────────────────
 * `events.controller.ts` imported `UseGuards` and `JwtAuthGuard`, carried a
 * doc comment stating the stream "requires a valid JWT as a query parameter",
 * and then never applied a guard to the handler. The import is what made it
 * survive review: the file looks guarded.
 *
 * It was not. `curl -N http://host:3001/events` returned a live stream to an
 * anonymous client, pushing every payment (amount, invoice number) and every
 * operator login (email address) as it happened — across ALL tenants, because
 * the broadcast bus has no scoping of its own.
 *
 * ── Why not simply `@UseGuards(JwtAuthGuard)` ────────────────────────────
 * That would have broken every dashboard. The operator `JwtStrategy` extracts
 * the token with `ExtractJwt.fromAuthHeaderAsBearerToken()`, and the browser's
 * native `EventSource` cannot send an Authorization header — which is exactly
 * why the frontend puts the token in the query string (`use-sse.ts`). The
 * guard would have rejected every legitimate client while the endpoint stayed
 * the most interesting one on the box.
 *
 * The alternative — teaching `JwtStrategy` to read `?token=` — was rejected
 * deliberately. It would make a query-string token valid on EVERY route,
 * putting credentials into access logs, `Referer` headers and browser history
 * for the whole API. The exception belongs where the constraint actually is:
 * this one streaming endpoint.
 *
 * ── The scope check ──────────────────────────────────────────────────────
 * Repeated here, not inherited: the customer portal signs its tokens with the
 * same secret, so without this a subscriber's 30-day portal token would read
 * the operator event bus. See `auth/token-scope.spec.ts` for the full account
 * of why the two token populations must stay separated by `scope`.
 */
@Injectable()
export class SseAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = SseAuthGuard.extract(req);
    if (!token) {
      throw new UnauthorizedException('This stream requires a token.');
    }

    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      // Signature, expiry and malformed tokens all land here. The message
      // stays deliberately uninformative — an unauthenticated caller learns
      // nothing about which of the three it was.
      throw new UnauthorizedException('Invalid or expired token.');
    }

    if (payload?.scope && payload.scope !== 'admin') {
      throw new UnauthorizedException('This token is not valid for the operator API.');
    }
    if (!payload?.role) {
      throw new UnauthorizedException('This account is not an operator account.');
    }

    req.user = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name,
      imp: payload.imp,
      isDemo: payload.isDemo === true,
    };
    return true;
  }

  /**
   * Header first, query second. A caller that CAN send a header should, so
   * the weaker channel stays a fallback for `EventSource` rather than the
   * primary path.
   */
  static extract(req: any): string | null {
    const header: string | undefined = req?.headers?.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
    const q = req?.query?.token;
    return typeof q === 'string' && q.length > 0 ? q : null;
  }
}
