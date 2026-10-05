import {
  Controller,
  Get,
  Request,
  ServiceUnavailableException,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { EventsService } from './events.service';
import { SseAuthGuard } from './sse-auth.guard';
import { ScopeService } from './scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { accountStatus } from '../auth/account-status';

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
  constructor(
    private readonly events: EventsService,
    private readonly scope: ScopeService,
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * Who may see an event: the account it concerns and the accounts above it
   * (inside the same company). The bus used to deliver every company's logins
   * (emails), payments (customer names, amounts) and monitor alerts (hosts) to
   * every connected operator. An event with no owner is platform-level and
   * reaches the platform account only.
   */
  private async visibleOwners(user: any): Promise<Set<number> | 'platform' | null> {
    // A suspended account (or one under a suspended parent) gets nothing.
    if (this.prisma && user?.sub) {
      const st = await accountStatus(this.prisma, Number(user.sub));
      if (!st || !st.active) return null;
    }
    if (user?.role === 'SUPER_ADMIN') return 'platform';
    const root = await this.scope.rootId({ sub: user?.sub, role: user?.role } as any);
    return new Set(await this.scope.descendantIds(root));
  }

  /**
   * SSE stream — requires a valid JWT as a query parameter because the native
   * EventSource API does not support custom headers. Send:
   *   new EventSource(`${API}/events?token=${jwt}`)
   */
  @Get('events')
  @UseGuards(SseAuthGuard)
  @Sse()
  stream(@Request() req: any): Observable<MessageEvent> {
    /**
     * A1: A CEILING ON CONCURRENT STREAMS.
     *
     * Every SSE connection holds an open HTTP response, an emitter listener
     * and a 30-second heartbeat timer for as long as it lives. Nothing limited
     * how many a worker would accept, so a frontend stuck in a reconnect loop
     * — or anyone with the URL and a script — could accumulate them until the
     * process ran out of memory or sockets.
     *
     * The limit is per worker and generous: an ISP NOC with every operator on
     * three tabs is nowhere near it. Refusing with 503 rather than accepting
     * and dying keeps the panel serving requests, and tells a client that
     * retries something true.
     */
    const limit = Number(process.env.MAX_SSE_CLIENTS || 500);
    if (this.events.listenerCount() >= limit) {
      throw new ServiceUnavailableException(
        `This backend worker is already streaming to ${limit} clients.`,
      );
    }

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
      let visible: Set<number> | 'platform' | null = null;
      let loadedAt = 0;
      const refresh = async () => {
        visible = await this.visibleOwners(req.user).catch(() => null);
        loadedAt = Date.now();
      };
      void refresh();
      const unsub = this.events.subscribe((event, payload) => {
        if (Date.now() - loadedAt > 5 * 60_000) void refresh();
        const owner = payload?.ownerUserId;
        const ok = visible === 'platform'
          ? owner == null
          : visible instanceof Set && owner != null && visible.has(Number(owner));
        if (!ok) return;
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

  /**
   * Quick diagnostic. Guarded too: a broadcast counter is a low-grade
   * signal, but it is still a read of operational activity, and an
   * unauthenticated endpoint on this controller is precisely how the stream
   * above came to be unauthenticated for so long.
   *
   * Tenant-free by content: five counters about this worker's broadcast bus
   * (totals, open streams, Redis fan-out state) — no event payload, no user,
   * no company data — so the caller is taken only so the route is not blind
   * to who is asking, and the answer does not depend on it.
   */
  @Get('events/status')
  @UseGuards(SseAuthGuard)
  status(@Request() _req: any) {
    return this.events.getStats();
  }
}