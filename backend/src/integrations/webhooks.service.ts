import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import * as crypto from 'crypto';

/**
 * WebhooksService — outbound event notifications.
 *
 * Lets other software react to what happens here without polling: a mobile app
 * refreshing on payment, an accounting package pulling invoices, a WhatsApp bot
 * messaging a customer the moment they're suspended.
 *
 * Design points that matter in production:
 *   • Every payload is HMAC-SHA256 signed with the endpoint's own secret, so
 *     the receiver can prove it came from us and wasn't tampered with.
 *   • Delivery is recorded per attempt — a failed webhook is visible and
 *     retryable, never silently dropped.
 *   • Retries use exponential backoff, and an endpoint that keeps failing is
 *     auto-disabled rather than retried forever.
 *   • Emitting is fire-and-forget: a slow or dead endpoint must never delay
 *     the business operation that triggered it.
 */
export const WEBHOOK_EVENTS = [
  'subscriber.created',
  'subscriber.updated',
  'subscriber.suspended',
  'subscriber.renewed',
  'subscriber.transferred',
  'payment.received',
  'invoice.created',
  'ticket.created',
  'ticket.resolved',
  'ticket.sla_breached',
  'session.started',
  'session.ended',
  'nas.offline',
  'nas.online',
  'wallet.topup',
  'fieldjob.completed',
] as const;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  // ── Management ───────────────────────────────────────────────
  async list(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.ownerId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    const hooks = await this.prisma.webhook.findMany({
      where,
      orderBy: { id: 'desc' },
      include: { _count: { select: { deliveries: true } } },
    });
    // Never return the signing secret in a list response.
    return hooks.map(({ secret, ...h }) => ({ ...h, secretSet: !!secret }));
  }

  async create(data: { name: string; url: string; events?: string[] }, actor?: Actor) {
    if (!/^https?:\/\//i.test(data.url || '')) {
      throw new BadRequestException('A valid http(s) URL is required.');
    }
    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const hook = await this.prisma.webhook.create({
      data: {
        name: data.name?.trim() || 'Webhook',
        url: data.url.trim(),
        secret,
        events: data.events?.length ? data.events.join(',') : '*',
        ownerId: actor ? this.scope.actorId(actor) : null,
      },
    });
    // Shown once — the caller must store it to verify signatures.
    return { ...hook, secret };
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.assertOwned(id, actor);
    return this.prisma.webhook.update({
      where: { id },
      data: {
        name: data.name,
        url: data.url,
        isActive: data.isActive,
        events: Array.isArray(data.events) ? data.events.join(',') : data.events,
        // Re-enabling clears the failure counter so backoff starts fresh.
        ...(data.isActive === true ? { failureCount: 0, lastError: null } : {}),
      },
    });
  }

  async remove(id: number, actor?: Actor) {
    await this.assertOwned(id, actor);
    await this.prisma.webhook.delete({ where: { id } });
    return { deleted: true, id };
  }

  async deliveries(id: number, actor?: Actor, limit = 50) {
    await this.assertOwned(id, actor);
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  /** Send a sample payload so an integrator can verify their endpoint. */
  async test(id: number, actor?: Actor) {
    const hook = await this.assertOwned(id, actor);
    return this.deliver(hook, 'webhook.test', {
      message: 'This is a test event from Jointbox.',
      at: new Date().toISOString(),
    });
  }

  private async assertOwned(id: number, actor?: Actor) {
    const hook = await this.prisma.webhook.findUnique({ where: { id } });
    if (!hook) throw new NotFoundException(`Webhook ${id} not found`);
    if (actor && !this.scope.isAdmin(actor.role) && hook.ownerId) {
      await this.scope.assertUser(actor, hook.ownerId);
    }
    return hook;
  }

  // ── Emission ─────────────────────────────────────────────────
  /**
   * Fire an event to every subscribed endpoint.
   *
   * Deliberately fire-and-forget: callers should NOT await this. A webhook
   * receiver that hangs for 30 seconds must not hold up a subscriber signup.
   */
  emit(event: string, payload: Record<string, any>, ownerId?: number | null) {
    this.dispatch(event, payload, ownerId).catch((e) =>
      this.logger.warn(`Webhook emit failed for ${event}: ${e?.message || e}`),
    );
  }

  private async dispatch(event: string, payload: Record<string, any>, ownerId?: number | null) {
    const hooks = await this.prisma.webhook.findMany({ where: { isActive: true } });
    const targets = hooks.filter((h) => {
      if (h.events !== '*' && !h.events.split(',').map((s) => s.trim()).includes(event)) return false;
      // An owned webhook only receives events for its own subtree.
      if (h.ownerId && ownerId && h.ownerId !== ownerId) return false;
      return true;
    });
    if (!targets.length) return;

    await Promise.all(targets.map((h) => this.deliver(h, event, payload).catch(() => null)));
  }

  /**
   * One delivery attempt, recorded either way.
   *
   * `existingId` lets a retry update the ORIGINAL delivery row. Without it
   * every retry created a fresh record, so the log filled with duplicates and
   * the original attempt stayed FAILED forever even after it eventually
   * succeeded.
   */
  private async deliver(
    hook: any,
    event: string,
    payload: Record<string, any>,
    existingId?: number,
    attemptNo = 1,
  ) {
    const body = JSON.stringify({
      event,
      createdAt: new Date().toISOString(),
      data: payload,
    });

    // HMAC over the exact body the receiver will read, so they can verify it
    // byte-for-byte before trusting anything inside.
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

    const delivery = existingId
      ? { id: existingId }
      : await this.prisma.webhookDelivery.create({
          data: { webhookId: hook.id, event, payload: body.slice(0, 8000), status: 'PENDING' },
        });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Jointbox-Event': event,
          'X-Jointbox-Signature': `sha256=${signature}`,
          'X-Jointbox-Delivery': String(delivery.id),
          'User-Agent': 'Jointbox-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text().catch(() => '');
      const ok = res.status >= 200 && res.status < 300;

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: ok ? 'SUCCESS' : 'FAILED',
          attempts: attemptNo,
          responseCode: res.status,
          responseBody: text.slice(0, 1000),
          deliveredAt: ok ? new Date() : null,
          nextRetryAt: ok ? null : this.backoff(attemptNo),
        },
      });

      await this.prisma.webhook.update({
        where: { id: hook.id },
        data: ok
          ? { failureCount: 0, lastError: null, lastSuccess: new Date() }
          : { failureCount: { increment: 1 }, lastError: `HTTP ${res.status}` },
      });

      return { ok, status: res.status };
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'Timed out after 10s' : e?.message || String(e);
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED', attempts: attemptNo,
          responseBody: msg.slice(0, 1000), nextRetryAt: this.backoff(attemptNo),
        },
      });
      await this.prisma.webhook.update({
        where: { id: hook.id },
        data: { failureCount: { increment: 1 }, lastError: msg.slice(0, 500) },
      });
      return { ok: false, error: msg };
    }
  }

  /** 1m, 5m, 25m, 2h, 10h — spreads retries without hammering a broken host. */
  private backoff(attempt: number) {
    const minutes = Math.min(5 ** attempt, 600);
    return new Date(Date.now() + minutes * 60_000);
  }

  /**
   * Retry sweep. Runs every 5 minutes and picks up anything due.
   * An endpoint failing persistently is disabled so we stop wasting attempts
   * on a URL that no longer exists.
   */
  @Cron('*/5 * * * *')
  async retryFailed() {
    if (process.env.WEBHOOKS_ENABLED === 'false') return;
    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: {
          status: 'FAILED',
          attempts: { lt: this.maxAttempts },
          nextRetryAt: { lte: new Date() },
        },
        include: { webhook: true },
        take: 50,
      });

      for (const d of due) {
        if (!d.webhook?.isActive) continue;
        const attempt = d.attempts + 1;
        try {
          const parsed = JSON.parse(d.payload);
          // Pass the existing id so this updates the original row rather than
          // creating a new one — deliver() records the outcome itself.
          await this.deliver(d.webhook, d.event, parsed.data ?? {}, d.id, attempt);
        } catch {
          await this.prisma.webhookDelivery.update({
            where: { id: d.id },
            data: { attempts: attempt, nextRetryAt: this.backoff(attempt) },
          });
        }
      }

      // Disable endpoints that are clearly gone.
      const dead = await this.prisma.webhook.updateMany({
        where: { isActive: true, failureCount: { gte: 20 } },
        data: { isActive: false, lastError: 'Auto-disabled after 20 consecutive failures' },
      });
      if (dead.count) {
        this.logger.warn(`Auto-disabled ${dead.count} webhook(s) after repeated failures`);
      }
    } catch (e: any) {
      this.logger.warn(`Webhook retry sweep failed: ${e?.message || e}`);
    }
  }

  /** Housekeeping — delivery logs would otherwise grow without limit. */
  @Cron('0 4 * * *')
  async pruneDeliveries() {
    const days = Number(process.env.WEBHOOK_LOG_RETAIN_DAYS || 30);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const res = await this.prisma.webhookDelivery
      .deleteMany({ where: { createdAt: { lt: cutoff }, status: 'SUCCESS' } })
      .catch(() => ({ count: 0 }));
    if (res.count) this.logger.log(`Pruned ${res.count} old webhook deliveries`);
  }
}
