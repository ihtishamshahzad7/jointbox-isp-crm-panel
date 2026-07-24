import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private store = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxRequests: number = 60,
    private readonly windowMs: number = 60_000,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.store.set(key, entry);
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      throw new HttpException(
        { message: 'Too many requests. Please try again later.', statusCode: HttpStatus.TOO_MANY_REQUESTS },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
