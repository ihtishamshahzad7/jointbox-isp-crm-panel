import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { AccountingService } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';

export type RenewMode = 'FULL' | 'DAYS' | 'DATE' | 'BALANCE' | 'CREDIT';

/**
 * RenewalService — how long to activate for, and who pays for it.
 *
 * A single "renew for one month" button does not survive contact with a real
 * ISP. Months are 28 to 31 days, customers pay part of a bill, and a regular
 * turns up saying "switch me on, I'll pay Friday". Handling those by manually
 * editing an expiry date loses the money owed and the fact that somebody
 * authorised it.
 *
 * Five modes, all landing on one place — an expiry date and an honest record
 * of whether it was paid for:
 *
 *   FULL    the package period, calendar-aware
 *   DAYS    an explicit number of days, priced pro-rata
 *   DATE    an exact expiry date — for aligning everyone to month end
 *   BALANCE spend whatever balance exists and grant the days it buys
 *   CREDIT  activate now on trust, recorded as a debt against whoever allowed it
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private accounting: AccountingService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Price for one day of a package.
   *
   * Deliberately divided by the package's own duration rather than a flat 30.
   * A 7-day package at 200 is 28.57/day, not 6.67/day — using 30 everywhere
   * would badly misprice every non-monthly plan.
   */
  private dailyRate(price: number, duration: number) {
    return duration > 0 ? price / duration : price / 30;
  }

  /**
   * Renewals extend from the existing expiry when it is still in the future,
   * so a customer who pays early is not robbed of the days they already own.
   * Once expired, the clock starts today.
   */
  private baseDate(currentExpiry?: Date | null) {
    const now = new Date();
    return currentExpiry && new Date(currentExpiry) > now ? new Date(currentExpiry) : now;
  }

  /**
   * What a given request would cost and when it would end — no writes.
   *
   * SECURITY: the actor check is not optional in practice. Without it any
   * authenticated user could quote ANY subscriber id and read back their
   * package, price, expiry and wallet balance — an enumerable data leak
   * across the whole tenant tree. The parameter stays optional only so
   * internal callers (activateRenewal, which has already checked) can skip it.
   */
  async quote(subscriberId: number, opts: {
    mode: RenewMode; packageId?: number; days?: number; expiryDate?: string; extraFee?: number;
    /** First activation: bill from the activation date (now), ignoring any
     *  placeholder expiry set at creation. So a subscriber created on the 1st
     *  but activated on the 6th runs 6th → 6th next month, not from the 1st. */
    fromActivation?: boolean;
  }, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: true, serviceSettings: true },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');

    const pkg = opts.packageId
      ? await this.prisma.package.findUnique({ where: { id: opts.packageId } })
      : sub.package;
    if (!pkg) throw new BadRequestException('No package selected for this renewal.');

    /**
     * Three-step fallback: this subscriber's own stored price, then the owning
     * account's retail price for THIS package, then the package base price.
     *
     * CRITICAL: the stored `sellPrice` is only trusted when we are pricing the
     * package it was actually set for. When the operator picks a DIFFERENT
     * package in the activation dialog (or the subscriber has no package yet),
     * the old sellPrice belongs to the old plan — reusing it billed the new 4mb
     * activation at a stale figure (e.g. 250) instead of the owner's real retail
     * (1000). So a package change forces a fresh resolve from the owner's retail.
     */
    const pricingSamePackage = pkg.id === (sub.packageId ?? pkg.id);
    let resolved = (pricingSamePackage && sub.sellPrice != null) ? Number(sub.sellPrice) : null;
    if (resolved == null && sub.userId) {
      const own = await this.prisma.resellerPackagePrice.findUnique({
        where: { userId_packageId: { userId: sub.userId, packageId: pkg.id } },
        select: { retailPrice: true },
      });
      if (own?.retailPrice != null && own.retailPrice > 0) resolved = own.retailPrice;
    }
    const price = Number(resolved ?? pkg.price ?? 0);
    const duration = pkg.duration || 30;
    const rate = this.dailyRate(price, duration);
    // On a first activation the customer starts fresh from today; on a renewal
    // of a still-active subscriber we extend from their current expiry so paid
    // days are never lost. Auto-detect when the caller didn't say: a non-ACTIVE
    // subscriber being given a full/day period is a first activation, so the
    // preview and the real activation date the period identically.
    const firstActivation = opts.fromActivation ?? ((sub as any).status !== 'ACTIVE' && opts.mode !== 'DATE');
    const base = firstActivation ? new Date() : this.baseDate(sub.serviceSettings?.expiryDate);
    const balance = Number(sub.balance ?? 0);

    let days = duration;
    let amount = price;
    let note = '';

    switch (opts.mode) {
      case 'DAYS': {
        days = Math.max(1, Math.floor(Number(opts.days) || 0));
        amount = Math.round(rate * days);
        note = `${days} day(s) at ${Math.round(rate)}/day`;
        break;
      }
      case 'DATE': {
        if (!opts.expiryDate) throw new BadRequestException('Choose an expiry date.');
        const target = new Date(opts.expiryDate);
        if (target <= base) throw new BadRequestException('That date is not after the current expiry.');
        days = Math.ceil((target.getTime() - base.getTime()) / 86400_000);
        amount = Math.round(rate * days);
        note = `Until ${target.toLocaleDateString()} — ${days} day(s)`;
        break;
      }
      case 'BALANCE': {
        if (balance <= 0) throw new BadRequestException('This subscriber has no balance to spend.');
        // Whole days only. Selling a fraction of a day is meaningless to the
        // customer and leaves an awkward remainder in the wallet.
        days = Math.floor(balance / rate);
        if (days < 1) {
          throw new BadRequestException(
            `Balance of ${Math.round(balance)} is less than one day (${Math.round(rate)}). Top up first.`,
          );
        }
        amount = Math.round(rate * days);
        note = `Balance ${Math.round(balance)} buys ${days} day(s); ${Math.round(balance - amount)} left over`;
        break;
      }
      case 'CREDIT': {
        days = Math.max(1, Math.floor(Number(opts.days) || 0));
        amount = Math.round(rate * days);
        note = `${days} day(s) on credit — ${amount} owed`;
        break;
      }
      default: {
        // FULL. Adding months rather than a fixed day count keeps monthly
        // customers on the same date each month regardless of month length,
        // which is what "monthly" means to the person paying.
        const end = new Date(base);
        if (duration === 30 || duration === 31) end.setMonth(end.getMonth() + 1);
        else end.setDate(end.getDate() + duration);
        days = Math.ceil((end.getTime() - base.getTime()) / 86400_000);
        amount = price;
        note = `Full period — ${days} day(s)`;
        break;
      }
    }

    const expiry = new Date(base);
    expiry.setDate(expiry.getDate() + days);

    const extra = Number(opts.extraFee || 0);
    const total = Math.round(amount + extra);

    return {
      subscriberId,
      packageId: pkg.id,
      packageName: pkg.name,
      mode: opts.mode,
      days,
      dailyRate: Math.round(rate),
      amount: Math.round(amount),
      extraFee: extra,
      total,
      currentExpiry: sub.serviceSettings?.expiryDate ?? null,
      newExpiry: expiry,
      balance,
      balanceAfter: opts.mode === 'BALANCE' ? Math.round(balance - amount) : balance,
      // A credit records a debt instead of taking money now.
      creates: opts.mode === 'CREDIT' ? 'credit' : 'payment',
      note,
    };
  }

  /** Grant service on trust, recorded so the debt cannot quietly disappear. */
  async grantCredit(
    subscriberId: number,
    body: { days: number; packageId?: number; reason?: string; payBy?: string },
    actor?: Actor,
  ) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const outstanding = await this.prisma.creditExtension.count({
      where: { subscriberId, status: 'OUTSTANDING' },
    });
    // One unpaid promise is a favour; a stack of them is an unmanaged debt.
    if (outstanding >= 2) {
      throw new BadRequestException(
        'This subscriber already has 2 unsettled credit extensions. Settle those before granting another.',
      );
    }

    // Scope already asserted at the top of this method, so the quote does not
    // need to repeat the lookup.
    const q = await this.quote(subscriberId, { mode: 'CREDIT', days: body.days, packageId: body.packageId });

    const payBy = body.payBy ? new Date(body.payBy) : new Date(q.newExpiry);

    const credit = await this.prisma.creditExtension.create({
      data: {
        subscriberId,
        days: q.days,
        expirySet: q.newExpiry,
        amountDue: q.total,
        grantedBy: actor ? this.scope.actorId(actor) : null,
        reason: body.reason || null,
        dueDate: payBy,
        status: 'OUTSTANDING',
      },
    });

    this.logger.log(
      `Credit granted: subscriber #${subscriberId}, ${q.days} day(s), ${q.total} due by ${payBy.toDateString()}`,
    );
    return { credit, quote: q };
  }

  /** Mark a credit paid, recording the money properly rather than just clearing a flag. */
  async settleCredit(creditId: number, body: { method?: string; notes?: string }, actor?: Actor) {
    const credit = await this.prisma.creditExtension.findUnique({
      where: { id: creditId },
      include: { subscriber: { select: { id: true, fullName: true } } },
    });
    if (!credit) throw new NotFoundException('Credit not found');
    if (credit.status === 'SETTLED') return credit;
    if (actor) await this.scope.assertSubscriber(actor, credit.subscriberId);

    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNo: `CR-${Date.now()}-${credit.id}`,
        subscriberId: credit.subscriberId,
        amount: credit.amountDue,
        total: credit.amountDue,
        paidAmount: credit.amountDue,
        dueAmount: 0,
        dueDate: credit.dueDate,
        paidDate: new Date(),
        status: 'PAID',
        notes: `Settlement of ${credit.days}-day credit extension`,
        items: {
          create: [{
            description: `Credit extension — ${credit.days} day(s)`,
            quantity: 1, unitPrice: credit.amountDue, total: credit.amountDue,
          }],
        },
      },
    });

    const payment = await this.prisma.payment.create({
      data: {
        paymentNo: `PAY-${Date.now()}`,
        invoiceId: invoice.id,
        subscriberId: credit.subscriberId,
        amount: credit.amountDue,
        method: (body.method || 'CASH') as any,
        notes: body.notes || 'Credit extension settled',
      },
    });

    await this.accounting.postInvoiceCreated(invoice).catch(() => null);
    await this.accounting.postPaymentReceived(payment).catch(() => null);

    return this.prisma.creditExtension.update({
      where: { id: creditId },
      data: {
        status: 'SETTLED',
        settledAt: new Date(),
        settledBy: actor ? this.scope.actorId(actor) : null,
        invoiceId: invoice.id,
      },
    });
  }

  /** Outstanding trust, worst first. */
  async listCredits(actor?: Actor, status = 'OUTSTANDING') {
    const where: any = {};
    if (status !== 'ALL') where.status = status;
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.subscriber = {
        userId: { in: await this.scope.descendantIds(await this.scope.rootId(actor)) },
      };
    }

    const rows = await this.prisma.creditExtension.findMany({
      where,
      include: { subscriber: { select: { id: true, fullName: true, username: true, phone: true } } },
      orderBy: { dueDate: 'asc' },
      take: 300,
    });

    const now = Date.now();
    return rows.map((c) => ({
      ...c,
      daysOverdue: c.status === 'OUTSTANDING'
        ? Math.max(0, Math.floor((now - new Date(c.dueDate).getTime()) / 86400_000))
        : 0,
    }));
  }

  /**
   * Daily: a promise that has passed its date is marked DEFAULTED.
   *
   * The service is intentionally left running — cutting someone off is a
   * commercial decision for the operator, not something a background job
   * should do on its own. The panel flags it and a human decides.
   */
  @Cron('30 6 * * *')
  async flagDefaults() {
    try {
      const overdue = await this.prisma.creditExtension.findMany({
        where: { status: 'OUTSTANDING', dueDate: { lt: new Date() } },
        include: { subscriber: { select: { id: true, fullName: true, phone: true } } },
      });
      if (!overdue.length) return { defaulted: 0 };

      await this.prisma.creditExtension.updateMany({
        where: { id: { in: overdue.map((c) => c.id) } },
        data: { status: 'DEFAULTED' },
      });

      for (const c of overdue) {
        if (!c.subscriber?.phone) continue;
        void this.notifications.send({
          channel: 'SMS',
          recipient: c.subscriber.phone,
          body: `Your payment of ${Math.round(c.amountDue)} was due on ${new Date(c.dueDate).toLocaleDateString()}. Please settle it to keep your connection active.`,
          subscriberId: c.subscriberId,
          event: 'CREDIT_OVERDUE',
        }).catch((e) => { this.logger?.warn?.('sendCreditOverdueNotification: ' + (e?.message || e)); });
      }

      this.logger.warn(`${overdue.length} credit extension(s) passed their payment date`);
      return { defaulted: overdue.length };
    } catch (e: any) {
      this.logger.warn(`Credit default sweep failed: ${e?.message || e}`);
      return { defaulted: 0 };
    }
  }
}
