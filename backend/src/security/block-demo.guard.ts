import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * BlockDemoGuard — refuses demo/sandbox accounts. Applied to areas a demo user
 * must never see for security/data-leak reasons (system logs, console, RADIUS
 * admin). Demo users can do all franchise work, just not these.
 */
@Injectable()
export class BlockDemoGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (req?.user?.isDemo === true) {
      throw new ForbiddenException('Not available in demo accounts.');
    }
    return true;
  }
}
