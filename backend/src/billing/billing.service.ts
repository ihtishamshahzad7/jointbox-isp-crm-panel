import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingService } from '../accounting/accounting.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { QueueService } from '../common/queue.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NetworkService } from '../network/network.service';
import { WebhooksService } from '../integrations/webhooks.service';

/**
 * Phase 1 billing automation.
 * Nightly jobs (all skipped when BILLING_AUTOMATION=off):
 *  00:30 auto-invoice   — invoice subscribers whose expiry is within INVOICE_LEAD_DAYS
 *  01:00 auto-renewal   — renew from wallet balance when expiry reached
 *  02:00 suspension     — block expired subscribers (after BILLING_GRACE_DAYS)
 * Every run writes a BillingRun row (🔍 traceable, dry-run supported).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private prisma: PrismaService,
    private accounting: AccountingService,
    private radiusSync: RadiusSyncService,
    private queue: QueueService,
    private notifications: NotificationsService,
    // Used to kick live sessions the moment a subscriber is suspended.
    private network: NetworkService,
    // Outbound event notifications for third-party integrations.
    private webhooks: WebhooksService,
  ) {
    this.queue.registerProcessor('billing-auto-invoice', (d) => this.runAutoInvoice(d?.dryRun === true));
    this.queue.registerProcessor('billing-auto-renewal', (d) => this.runAutoRenewal(d?.dryRun === true));
    this.queue.registerProcessor('billing-suspension', (d) => this.runSuspension(d?.dryRun === true));
  }

  private get enabled() {
    return (process.env.BILLING_AUTOMATION || 'on').toLowerCase() !== 'off';
  }
  private get leadDays() {
    return Number(process.env.INVOICE_LEAD_DAYS) || 3;
  }
  private get graceDays() {
    return Number(process.env.BILLING_GRACE_DAYS) || 0;
  }

  // ── Cron triggers ─────────────────────────────────────────────
  @Cron('30 0 * * *')
  cronAutoInvoice() {
    if (this.enabled) void this.queue.add('billing-auto-invoice');
  }
  @Cron('0 1 * * *')
  cronAutoRenewal() {
    if (this.enabled) void this.queue.add('billing-auto-renewal');
  }
  @Cron('0 2 * * *')
  cronSuspension() {
    if (this.enabled) void this.queue.add('billing-suspension');
  }

  // ── Manual/queued triggers ────────────────────────────────────
  async trigger(type: 'auto-invoice' | 'auto-renewal' | 'suspension', dryRun: boolean) {
    const jobId = await this.queue.add(`billing-${type}`, { dryRun });
    return { jobId, dryRun };
  }

  async getRuns() {
    return this.prisma.billingRun.findMany({ orderBy: { id: 'desc' }, take: 100 });
  }

  // ─────────────────────────────────────────────────────────────
  // JOB 1: AUTO-INVOICE
  // ─────────────────────────────────────────────────────────────
  async runAutoInvoice(dryRun = false) {
    const run = await this.prisma.billingRun.create({ data: { type: 'AUTO_INVOICE', dryRun } });
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + this.leadDays);

    const candidates = await this.prisma.subscriber.findMany({
      where: {
        status: 'ACTIVE',
        packageId: { not: null },
        serviceSettings: { is: { expiryDate: { not: null, lte: horizon } } },
      },
      include: { package: true, serviceSettings: true },
    });

    let succeeded = 0;
    let failed = 0;
    const lines: string[] = [];

    for (const sub of candidates) {
      try {
        const expiry = sub.serviceSettings!.expiryDate!;
        // already invoiced for this cycle?
        const open = await this.prisma.invoice.findFirst({
          where: { subscriberId: sub.id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, dueDate: { gte: expiry } },
          select: { id: true },
        });
        if (open) continue;

        const amount = sub.serviceSettings?.customPrice ?? sub.package!.price;
        if (dryRun) {
          lines.push(`DRY: would invoice #${sub.id} ${sub.username} ${amount}`);
          succeeded++;
          continue;
        }
        const invoiceNo = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}-${sub.id}`;
        const invoice = await this.prisma.invoice.create({
          data: {
            invoiceNo,
            subscriberId: sub.id,
            amount,
            total: amount,
            dueAmount: amount,
            dueDate: expiry,
            status: 'UNPAID',
            notes: 'Auto-generated (billing automation)',
            items: { create: [{ description: `Renewal - ${sub.package!.name}`, quantity: 1, unitPrice: amount, total: amount }] },
          },
        });
        await this.accounting.postInvoiceCreated({ id: invoice.id, invoiceNo, total: amount, subscriberId: sub.id });
        void this.notifications.fireEvent('INVOICE_CREATED', sub, { amount, dueAmount: amount, invoiceNo });
        lines.push(`invoiced #${sub.id} ${sub.username} ${amount}`);
        succeeded++;
      } catch (e: any) {
        failed++;
        lines.push(`FAIL #${sub.id} ${sub.username}: ${e.message}`);
      }
    }

    return this.finishRun(run.id, candidates.length, succeeded, failed, lines);
  }

  // ─────────────────────────────────────────────────────────────
  // JOB 2: AUTO-RENEWAL from wallet balance
  // ─────────────────────────────────────────────────────────────
  async runAutoRenewal(dryRun = false) {
    const run = await this.prisma.billingRun.create({ data: { type: 'AUTO_RENEWAL', dryRun } });
    const now = new Date();

    const candidates = await this.prisma.subscriber.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRED', 'SUSPENDED'] },
        packageId: { not: null },
        balance: { gt: 0 },
        serviceSettings: { is: { expiryDate: { not: null, lte: now } } },
      },
      include: { package: { include: { pool: true } }, serviceSettings: true },
    });

    let succeeded = 0;
    let failed = 0;
    const lines: string[] = [];

    for (const sub of candidates) {
      try {
        const price = sub.serviceSettings?.customPrice ?? sub.package!.price;
        if (sub.balance < price) continue;

        if (dryRun) {
          lines.push(`DRY: would renew #${sub.id} ${sub.username} for ${price}`);
          succeeded++;
          continue;
        }

        // 1. deduct wallet (posts ledger + balance tx)
        await this.accounting.deductBalance(sub.id, price, `Auto-renewal ${sub.package!.name}`);

        // 2. paid invoice + payment
        const invoiceNo = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}-${sub.id}`;
        const newExpiry = new Date();
        newExpiry.setDate(newExpiry.getDate() + (sub.package!.duration || 30));
        const invoice = await this.prisma.invoice.create({
          data: {
            invoiceNo,
            subscriberId: sub.id,
            amount: price,
            total: price,
            paidAmount: price,
            dueAmount: 0,
            dueDate: newExpiry,
            paidDate: new Date(),
            status: 'PAID',
            notes: 'Auto-renewal (wallet balance)',
            items: { create: [{ description: `Auto-renewal - ${sub.package!.name}`, quantity: 1, unitPrice: price, total: price }] },
          },
        });
        await this.prisma.payment.create({
          data: {
            paymentNo: `PAY-${Date.now()}-${sub.id}`,
            invoiceId: invoice.id,
            subscriberId: sub.id,
            amount: price,
            method: 'BALANCE',
            notes: 'Auto-renewal from wallet',
          },
        });

        // 3. extend service + reactivate
        await this.prisma.serviceSettings.update({ where: { subscriberId: sub.id }, data: { expiryDate: newExpiry, isBlocked: false } });
        // A new period means a fresh data allowance, so any FUP throttle from
        // the last cycle is lifted here. The profile re-sync below writes the
        // full package speed back, which is what actually restores it.
        await this.prisma.subscriber.update({
          where: { id: sub.id },
          data: { status: 'ACTIVE', fupApplied: false, fupAppliedAt: null },
        });

        // 4. make sure RADIUS lets them in again
        await this.radiusSync.syncSubscriberProfile(sub.username, sub.password, sub.package as any);

        void this.notifications.fireEvent('RENEWAL', sub, { amount: price, invoiceNo, expiry: newExpiry });
        this.webhooks.emit('subscriber.renewed', {
          subscriberId: sub.id,
          username: sub.username,
          amount: price,
          invoiceNo,
          expiryDate: newExpiry,
        });
        lines.push(`renewed #${sub.id} ${sub.username} until ${newExpiry.toISOString().slice(0, 10)}`);
        succeeded++;
      } catch (e: any) {
        failed++;
        lines.push(`FAIL #${sub.id} ${sub.username}: ${e.message}`);
      }
    }

    return this.finishRun(run.id, candidates.length, succeeded, failed, lines);
  }

  // ─────────────────────────────────────────────────────────────
  // JOB 3: SUSPEND EXPIRED
  // ─────────────────────────────────────────────────────────────
  async runSuspension(dryRun = false) {
    const run = await this.prisma.billingRun.create({ data: { type: 'SUSPENSION', dryRun } });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.graceDays);

    const candidates = await this.prisma.subscriber.findMany({
      where: {
        status: 'ACTIVE',
        serviceSettings: { is: { expiryDate: { not: null, lt: cutoff } } },
      },
      include: { serviceSettings: true },
    });

    let succeeded = 0;
    let failed = 0;
    const lines: string[] = [];

    for (const sub of candidates) {
      try {
        if (dryRun) {
          lines.push(`DRY: would suspend #${sub.id} ${sub.username}`);
          succeeded++;
          continue;
        }
        await this.prisma.subscriber.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
        await this.prisma.serviceSettings.update({ where: { subscriberId: sub.id }, data: { isBlocked: true } });
        await this.radiusSync.removeSubscriberFromRadius(sub.username);

        // CRITICAL: removing the RADIUS credentials only blocks the NEXT login.
        // A customer already online stays connected until they happen to drop —
        // which on PPPoE can be days of free service. Kick the live session so
        // suspension takes effect immediately.
        let kicked = 'no active session';
        try {
          const res = await this.network.disconnect(sub.username);
          kicked = res?.method ? `disconnected via ${res.method}` : 'disconnect sent';
        } catch (e: any) {
          // Never let a failed kick abort the suspension — the credentials are
          // already gone, so they cannot reconnect either way.
          kicked = `disconnect failed: ${e?.message || e}`;
          this.logger.warn(`Suspend ${sub.username}: ${kicked}`);
        }

        void this.notifications.fireEvent('SUSPENSION', sub);
        // Fire-and-forget so a slow webhook receiver can't stall the run.
        this.webhooks.emit('subscriber.suspended', {
          subscriberId: sub.id,
          username: sub.username,
          fullName: sub.fullName,
          expiryDate: sub.serviceSettings?.expiryDate ?? null,
        });
        lines.push(`suspended #${sub.id} ${sub.username} (${kicked})`);
        succeeded++;
      } catch (e: any) {
        failed++;
        lines.push(`FAIL #${sub.id} ${sub.username}: ${e.message}`);
      }
    }

    return this.finishRun(run.id, candidates.length, succeeded, failed, lines);
  }

  // ─────────────────────────────────────────────────────────────
  private async finishRun(runId: number, processed: number, succeeded: number, failed: number, lines: string[]) {
    const result = await this.prisma.billingRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(),
        processed,
        succeeded,
        failed,
        details: lines.slice(0, 500).join('\n') || null,
      },
    });
    this.logger.log(`BillingRun#${runId} ${result.type}${result.dryRun ? ' (dry)' : ''}: ${succeeded}/${processed} ok, ${failed} failed`);
    return result;
  }
}
