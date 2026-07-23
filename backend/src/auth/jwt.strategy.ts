import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production',
    });
  }

  async validate(payload: any) {
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