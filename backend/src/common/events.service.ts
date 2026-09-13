import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * A1: THE LIVE EVENT BUS, WHICH USED TO REACH ONE CLIENT IN TWELVE.
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * This was a bare in-process `EventEmitter`. Under PM2 cluster mode with
 * `BACKEND_INSTANCES=12`, a payment recorded on worker 3 emitted into worker
 * 3's listener array — and an operator whose SSE connection had been balanced
 * onto worker 7 had subscribed to worker 7's. They never met.
 *
 * So a dashboard saw an event only when the same worker happened to handle
 * both the long-lived stream and the action that caused it: roughly one in
 * twelve. There was no error, no reconnect and no gap in the UI. The panel
 * simply showed less than was happening, and an operator watching a live
 * outage feed believed the network was quieter than it was.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * `broadcast()` publishes to a Redis channel. Every worker holds a subscriber
 * connection on that channel and re-emits what arrives into its own local
 * emitter, where the SSE controller is listening. Redis delivers to every
 * subscriber INCLUDING the publisher's own process, so the originating worker
 * is served by the same path as the others — there is no special case to get
 * wrong, and no double-delivery.
 *
 * ── Redis being down must not take the API down ──────────────────────────
 * It is a live feed, not a ledger. If the publish fails the event is emitted
 * locally instead: the operator on the originating worker still sees it, the
 * others do not, and the panel degrades to exactly the behaviour it had
 * before this fix rather than throwing inside whatever request triggered it.
 * The failure is logged once per outage, not once per event.
 *
 * ── Why a dedicated connection ───────────────────────────────────────────
 * A Redis connection in subscriber mode may not run ordinary commands, so
 * this cannot share `CacheService`'s client. Two connections per process —
 * one publisher, one subscriber — is the minimum the protocol allows.
 */
const CHANNEL = 'jointbox:events';

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly emitter = new EventEmitter();

  private pub: any = null;
  private sub: any = null;
  /** Latched so a Redis outage logs once, not once per broadcast. */
  private degraded = false;

  /** Approximate counter, reset on server restart. Used for diagnostics. */
  private _broadcastCount = 0;
  private _receivedCount = 0;

  constructor() {
    /**
     * The SSE controller adds one listener per connected dashboard, and
     * EventEmitter warns at ten — a MaxListenersExceededWarning in the log of
     * any panel with more than ten tabs open, which is normal operation for an
     * ISP NOC. Raised deliberately rather than disabled entirely: zero means
     * "never warn about a leak", and a leak here is a real risk.
     */
    this.emitter.setMaxListeners(1000);

    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn(
        'REDIS_URL is not set — live events stay inside this process. ' +
          'With more than one backend instance, dashboards will see only the events ' +
          'their own worker produced.',
      );
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      const opts = { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false };
      this.pub = new Redis(url, opts);
      this.sub = new Redis(url, opts);

      // Errors are logged and swallowed. An unhandled 'error' event on an
      // ioredis client is an uncaught exception, which would take the whole
      // worker down because a live feed lost its connection.
      this.pub.on('error', (e: Error) => this.markDegraded(`publisher: ${e.message}`));
      this.sub.on('error', (e: Error) => this.markDegraded(`subscriber: ${e.message}`));

      this.sub.on('message', (_ch: string, raw: string) => {
        try {
          const { event, payload } = JSON.parse(raw);
          this._receivedCount++;
          this.emitter.emit('sse', event, payload);
        } catch {
          // A malformed message is one bad event, not a reason to stop
          // serving the ones that follow it.
        }
      });

      Promise.all([this.pub.connect(), this.sub.connect()])
        .then(() => this.sub.subscribe(CHANNEL))
        .then(() => {
          this.degraded = false;
          this.logger.log(`Live events on Redis channel ${CHANNEL} — cluster-wide`);
        })
        .catch((e: Error) => this.markDegraded(e.message));
    } catch (e: any) {
      this.markDegraded(`ioredis unavailable: ${e?.message || e}`);
      this.pub = this.sub = null;
    }
  }

  private markDegraded(why: string) {
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      `Live events degraded to this process only (${why}). ` +
        'Dashboards on other workers will not see events until Redis recovers.',
    );
  }

  /**
   * Subscribe to all SSE events. Returns an unsubscribe function.
   *
   * @param callback — receives (eventName, payload) on every broadcast
   */
  subscribe(callback: (event: string, payload: any) => void): () => void {
    const handler = (event: string, payload: any) => callback(event, payload);
    this.emitter.on('sse', handler);
    return () => {
      this.emitter.off('sse', handler);
    };
  }

  /** How many dashboards this worker is currently streaming to. */
  listenerCount(): number {
    return this.emitter.listenerCount('sse');
  }

  /**
   * Push a named event + payload to every connected SSE client, on every
   * worker.
   *
   * Deliberately not awaited by callers: a payment must not become slower, or
   * fail, because a live feed is having a bad day.
   *
   * @example
   *   this.events.broadcast('payment', { amount: 1500, invoiceNo: 'INV-001' });
   */
  broadcast(event: string, payload: any) {
    this._broadcastCount++;

    if (!this.pub || this.degraded) {
      // No Redis, or Redis is unwell. Serve the operators on this worker
      // rather than nobody.
      this.emitter.emit('sse', event, payload);
      return;
    }

    // NOT emitted locally here. Redis echoes the message back to this
    // process's own subscriber, which emits it — so every worker, including
    // this one, receives it by exactly one path. Emitting here as well would
    // show the originating worker's dashboards every event twice.
    this.pub.publish(CHANNEL, JSON.stringify({ event, payload })).catch((e: Error) => {
      this.markDegraded(e.message);
      this.emitter.emit('sse', event, payload);
    });
  }

  /** Stats for /events/status endpoint. */
  getStats() {
    return {
      broadcastCount: this._broadcastCount,
      receivedCount: this._receivedCount,
      clients: this.listenerCount(),
      clustered: !!this.pub && !this.degraded,
      degraded: this.degraded,
    };
  }

  async onModuleDestroy() {
    // PM2 gives the process 30s to shut down cleanly (see ecosystem.config.js).
    // Closing these avoids a socket left half-open through a deploy.
    await Promise.all([
      this.sub?.quit().catch(() => undefined),
      this.pub?.quit().catch(() => undefined),
    ]);
  }
}
