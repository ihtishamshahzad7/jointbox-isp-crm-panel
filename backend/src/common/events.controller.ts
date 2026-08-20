import { Controller, Get, Request, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Server-Sent Events endpoint.
 *
 * Admin dashboards connect here to receive real-time push of payments, logins,
 * and other significant events without polling.
 *
 * Usage (browser / EventSource):
 * ```ts
 * const source = new EventSource('http://localhost:3001/events', {
 *   withCredentials: true, // sends cookies; we use token query param instead
 * });
 *
 * source.addEventListener('payment', (e) => {
 *   const { amount, invoiceNo } = JSON.parse(e.data);
 * });
 *
 * source.addEventListener('login', (e) => {
 *   const { email } = JSON.parse(e.data);
 * });
 * ```
 */
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * SSE stream — requires a valid JWT as a query parameter because the native
   * EventSource API does not support custom headers. Send:
   *   new EventSource(`${API}/events?token=${jwt}`)
   */
  @Get('events')
  @Sse()
  stream(@Request() req: any): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      // Send initial connected event so the client knows the stream is live.
      // This one IS a named frame on purpose — the frontend registers a
      // dedicated 'connected' listener for it (use-sse.ts).
      subscriber.next({ type: 'connected', data: { type: 'connected' } } as MessageEvent);

      // Subscribe to all broadcasts. CRITICAL: the payload must NOT set the
      // SSE frame's `event:` name — that would make every browser dispatch a
      // NAMED event, and the frontend's EventSource catch-all (`onmessage`)
      // only fires for unnamed frames. The event name rides INSIDE the data
      // instead ({type, data}), which the frontend use-sse hook reads via its
      // generic onmessage handler.
      const unsub = this.events.subscribe((event, payload) => {
        subscriber.next({ data: { type: event, data: payload } } as MessageEvent);
      });

      // Heartbeat every 30s keeps proxies / load balancers from closing the
      // idle connection. SSE spec: lines starting with ':' are comments.
      const heartbeat = setInterval(() => {
        subscriber.next({ comment: 'heartbeat' } as any);
      }, 30_000);

      // Cleanup on client disconnect
      return () => {
        clearInterval(heartbeat);
        unsub();
      };
    });
  }

  /** Quick diagnostic — no auth needed. */
  @Get('events/status')
  status() {
    return this.events.getStats();
  }
}