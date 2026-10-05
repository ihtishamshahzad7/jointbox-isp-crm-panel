import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { portalPasswordVersion } from './portal-session';

/** Guards subscriber-portal endpoints. Requires a JWT with scope 'subscriber'. */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing token');
    let payload: any;
    try {
      payload = this.jwt.verify(token);
      if (payload?.scope !== 'subscriber') throw new Error('wrong scope');
    } catch {
      throw new UnauthorizedException('Invalid portal token');
    }
    // The account must still exist and still have the password the session
    // was opened with (see portal-session.ts).
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: Number(payload.sub) },
      select: { id: true, username: true, password: true },
    });
    if (!sub || (payload.pv && payload.pv !== portalPasswordVersion(sub.password))) {
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
    req.subscriber = { id: sub.id, username: sub.username };
    return true;
  }
}
