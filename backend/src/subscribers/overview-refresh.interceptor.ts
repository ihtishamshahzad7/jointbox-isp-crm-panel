import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { CacheService } from '../common/cache.service';

/**
 * The subscriber counters (total, active, today's signups…) are cached for 30
 * seconds per account. After adding, deleting or activating a customer the
 * list showed the new row while the cards above it still said the old
 * numbers. Any successful change on this controller drops those counters.
 */
@Injectable()
export class OverviewRefreshInterceptor implements NestInterceptor {
  constructor(private readonly cache: CacheService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const method = ctx.switchToHttp().getRequest()?.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next.handle();
    return next.handle().pipe(
      tap(() => {
        void this.cache.delPrefix('subscribers:overview').catch(() => undefined);
      }),
    );
  }
}
