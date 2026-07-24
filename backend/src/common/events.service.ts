import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * Lightweight in-process event bus for Server-Sent Events.
 *
 * Services call `broadcast(event, payload)` after any significant action
 * (payment received, login, session change). The EventsController exposes
 * a single SSE endpoint that any number of admin dashboard tabs can connect
 * to. When the backend has no connected clients the emit is a near-free no-op.
 *
 * NOT a replacement for BullMQ — this is fire-and-forget push, not a job queue.
 */
@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();
  /** Approximate counter, reset on server restart. Used for diagnostics. */
  private _broadcastCount = 0;

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

  /**
   * Push a named event + payload to every connected SSE client.
   *
   * @example
   *   this.events.broadcast('payment', { amount: 1500, invoiceNo: 'INV-001' });
   */
  broadcast(event: string, payload: any) {
    this._broadcastCount++;
    this.emitter.emit('sse', event, payload);
  }

  /** Stats for /events/status endpoint. */
  getStats() {
    return { broadcastCount: this._broadcastCount };
  }
}