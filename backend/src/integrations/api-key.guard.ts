import {
  CanActivate, ExecutionContext, Injectable, ForbiddenException, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeysService } from './api-keys.service';

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const header = req.headers['x-api-key'] || '';
    const auth = req.headers['authorization'] || '';
    const raw = header || (auth.startsWith('ApiKey ') ? auth.slice(7) : '');

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
      .toString()
      .split(',')[0];

    const key = await this.apiKeys.validate(String(raw).trim(), ip);

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
