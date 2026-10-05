import {
  CanActivate, ExecutionContext, Injectable, ForbiddenException, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeysService } from './api-keys.service';
import { PrismaService } from '../prisma/prisma.service';
import { accountStatus } from '../auth/account-status';

/** Mark a public-API route with the scope it needs: @RequireScope('write') */
export const RequireScope = (scope: string) => SetMetadata('apiScope', scope);

/**
 * Authenticates public-API requests via `X-API-Key` (or `Authorization: ApiKey …`).
 *
 * Separate from JwtAuthGuard on purpose: a user session and a machine
 * credential are different things with different lifetimes and revocation
 * paths, and conflating them is how service accounts end up with someone's
 * personal permissions.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private apiKeys: ApiKeysService,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const header = req.headers['x-api-key'] || '';
    const auth = req.headers['authorization'] || '';
    const raw = header || (auth.startsWith('ApiKey ') ? auth.slice(7) : '');

    // req.ip honours `trust proxy`. The left-most X-Forwarded-For entry is
    // client-written, so it could satisfy a key's IP allow-list from anywhere.
    const ip = String(req.ip || req.socket?.remoteAddress || '');

    const key = await this.apiKeys.validate(String(raw).trim(), ip);

    // A key works only while its owner (and every account above it) is
    // active — suspending a company or reseller used to leave its API keys
    // fully working.
    const status = key?.ownerId ? await accountStatus(this.prisma, Number(key.ownerId)) : null;
    if (!status || !status.active) {
      throw new ForbiddenException('The account that owns this API key is suspended or no longer exists.');
    }

    const required = this.reflector.get<string>('apiScope', context.getHandler());
    if (required && !this.apiKeys.hasScope(key, required)) {
      throw new ForbiddenException(`This API key lacks the "${required}" scope.`);
    }

    // Downstream code sees the key's owner as the acting user, so all the
    // existing subtree scoping applies unchanged to API traffic.
    req.apiKey = key;
    req.user = { id: key.ownerId, sub: key.ownerId, role: 'API' };
    return true;
  }
}
