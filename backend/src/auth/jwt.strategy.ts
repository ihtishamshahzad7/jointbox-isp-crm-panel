import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenBlacklistService } from './token-blacklist.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly blacklist: TokenBlacklistService) {
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

    // IMPORTANT: Return 'sub' not 'userId' - matches what controller expects
    return {
      sub: payload.sub,     // ← This matches req.user.sub in controller
      email: payload.email,
      role: payload.role,
      name: payload.name,
      imp: payload.imp,     // present when this is an "act as" session
      isDemo: payload.isDemo === true,
    };
  }
}
