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

    // IMPORTANT: Return 'sub' not 'userId' - matches what controller expects
    return {
      sub: payload.sub,     // ← This matches req.user.sub in controller
      email: payload.email,
      role: payload.role,
      name: payload.name,
      imp: payload.imp,     // present when this is an "act as" session
    };
  }
}
