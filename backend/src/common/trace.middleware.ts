import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Request ID middleware (Phase 0 traceability).
 * Attaches a unique trace ID to every request, returned in the response
 * header so the frontend or an API consumer can correlate logs.
 *
 * Access in controllers/interceptors via: req.traceId
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const traceId =
      (req.headers['x-trace-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      uuidv4().slice(0, 12);
    (req as any).traceId = traceId;
    _res.setHeader('X-Trace-Id', traceId);
    next();
  }
}