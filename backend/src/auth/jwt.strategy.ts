import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenBlacklistService } from './token-blacklist.service';
import { PrismaService } from '../prisma/prisma.service';
import { accountStatus, PASSWORD_CHANGE_ALLOWED } from './account-status';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly blacklist: TokenBlacklistService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: any) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (token && this.blacklist.isBlacklisted(token)) {
      throw new UnauthorizedException('Token revoked');
    }

    /**
     * A SUBSCRIBER PORTAL TOKEN IS NOT AN OPERATOR TOKEN.
     *
     * The customer portal signs its own JWTs with THIS SAME secret and service
     * (`portal.service.ts` — `{ sub: <subscriberId>, scope: 'subscriber' }`,
     * 30-day expiry). The portal's own guard checks that scope; this strategy
     * never did. So the token a customer receives by logging in with their
     * PPPoE password verified perfectly here, and `payload.role` came back
     * `undefined` — which `PermissionsGuard` then treated as "no role to
     * check" and waved through.
     *
     * What followed is the part that makes it critical: `ScopeService` keys on
     * `req.user.sub`, and `sub` is a SUBSCRIBER id being read as a USER id. A
     * subscriber whose id collides with an operator's user id inherits that
     * operator's entire subtree — id 1 being the SUPER_ADMIN that `main.ts`
     * creates on first boot.
     *
     * Two systems of identity sharing one signing key is the root cause; until
     * they have separate keys (or an `aud` claim), this check is the boundary.
     */
    if (payload?.scope && payload.scope !== 'admin') {
      throw new UnauthorizedException('This token is not valid for the operator API.');
    }

    /**
     * SUSPENSION AND FORCED PASSWORD CHANGE — checked here, on every request.
     *
     * This is the one place every operator request passes after its token is
     * verified, which is why the check lives here rather than in login alone:
     * login only stops NEW sessions, and a 7-day token issued before the
     * suspension would otherwise keep working for a week.
     *
     * An "act as" session (imp) is exempt from the suspension check: the
     * platform owner driving a suspended company's view to investigate it is
     * exactly when that view is needed.
     */
    const status = payload?.sub ? await accountStatus(this.prisma, Number(payload.sub)) : null;
    if (!status) throw new UnauthorizedException('Account not found');
    if (!payload.imp && !status.active) {
      throw new UnauthorizedException('This account is suspended. Contact your provider.');
    }
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];
    if (!payload.imp && status.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.test(path)) {
      throw new ForbiddenException('PASSWORD_CHANGE_REQUIRED');
    }

    // IMPORTANT: Return 'sub' not 'userId' - matches what controller expects
    return {
      sub: payload.sub,     // ← This matches req.user.sub in controller
      email: payload.email,
      // The role the account has NOW, not the one baked into the token when it
      // was issued: a company moved out of the platform account (or any role
      // change) takes effect on the next request instead of at token expiry.
      role: status.role || payload.role,
      name: payload.name,
      imp: payload.imp,     // present when this is an "act as" session
      isDemo: payload.isDemo === true,
      mustChangePassword: status.mustChangePassword,
    };
  }
}
