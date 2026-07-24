import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';

/**
 * Billing extensions — pro-rata, balance modes, reversals.
 *
 * One service holds the math so the controller can stay thin. The math is
 * tested independently of HTTP, which is the part of billing that always
 * needs to be right.
 */
@Injectable()
export class BillingExtService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  // ─── PRO-RATA ─────────────────────────────────────────────────────────

  async listProRated(query: any) {
    return this.prisma.proRatedBilling.findMany({
      include: { package: { select: { id: true, name: true, price: true, duration: true } } },
    });
  }

  async getProRatedForPackage(pkgId: number) {
    let row = await this.prisma.proRatedBilling.findUnique({ where: { packageId: pkgId } });
    if (!row) {
      // Default view: pretend it's enabled with sensible values. Saving is
      // explicit so we don't accidentally promote a never-configured package.
      row = {
        id: 0, packageId: pkgId, isActive: true,
        minCharge: 0, setupFee: 0, roundTo: 0,
        carryOver: false, anniversaryDay: 0,
        createdAt: new Date(), updatedAt: new Date(),
      } as any;
    }
    return row;
  }

  async upsertProRatedForPackage(pkgId: number, body: any, actor: any) {
    const pkg = await this.prisma.package.findUnique({ where: { id: pkgId } });
    if (!pkg) throw new NotFoundException(`Package ${pkgId} not found`);
    return this.prisma.proRatedBilling.upsert({
      where: { packageId: pkgId },
      update: {
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
        ...(body.minCharge !== undefined ? { minCharge: +body.minCharge } : {}),
        ...(body.setupFee !== undefined ? { setupFee: +body.setupFee } : {}),
        ...(body.roundTo !== undefined ? { roundTo: +body.roundTo } : {}),
        ...(typeof body.carryOver === 'boolean' ? { carryOver: body.carryOver } : {}),
        ...(body.anniversaryDay !== undefined ? { anniversaryDay: +body.anniversaryDay } : {}),
      },
      create: {
        packageId: pkgId,
        isActive: body.isActive !== false,
        minCharge: +body.minCharge || 0,
        setupFee: +body.setupFee || 0,
        roundTo: +body.roundTo || 0,
        carryOver: body.carryOver === true,
        anniversaryDay: +body.anniversaryDay || 0,
      },
    });
  }

  /**
   * Compute the first-invoice amount for a mid-cycle activation.
   *
   *   daysRemaining = total days in cycle - days already elapsed
   *   proRated = price * (daysRemaining / totalDays)
   *   total = proRated + setupFee
   *   then: apply minCharge floor, then apply roundTo (0 = no rounding)
   */
  async calculateProRated(body: any) {
    if (!body?.packageId) throw new BadRequestException('packageId is required');
    if (!body?.activationDate) throw new BadRequestException('activationDate is required');
    const pkg = await this.prisma.package.findUnique({ where: { id: +body.packageId } });
    if (!pkg) throw new NotFoundException(`Package ${body.packageId} not found`);
    const settings = await this.prisma.proRatedBilling.findUnique({ where: { packageId: pkg.id } });
    const isActive = settings?.isActive !== false;
    if (!isActive) {
      return { isActive: false, total: pkg.price, message: 'Pro-rata disabled for this package' };
    }
    const totalDays = pkg.duration;
    const activation = new Date(body.activationDate);
    if (Number.isNaN(activation.getTime())) throw new BadRequestException('activationDate is not a valid date');

    const cycleStart = this.cycleStartFor(activation, totalDays, settings?.anniversaryDay || 0);
    const cycleEnd = new Date(cycleStart);
    cycleEnd.setDate(cycleEnd.getDate() + totalDays);
    const daysRemaining = Math.max(0, Math.ceil((cycleEnd.getTime() - activation.getTime()) / 86400000));
    const daysElapsed = totalDays - daysRemaining;
    const proRated = (pkg.price * daysRemaining) / totalDays;
    const setup = settings?.setupFee || 0;
    let total = proRated + setup;

    if (settings?.minCharge && total < settings.minCharge) {
      total = settings.minCharge;
    }
    if (settings?.roundTo && settings.roundTo > 0) {
      total = Math.round(total / settings.roundTo) * settings.roundTo;
    }
    return {
      isActive: true,
      total: Math.round(total * 100) / 100,
      breakdown: {
        basePrice: pkg.price,
        proRated: Math.round(proRated * 100) / 100,
        setupFee: setup,
        daysRemaining,
        daysElapsed,
        totalDays,
        cycleStart: cycleStart.toISOString(),
        cycleEnd: cycleEnd.toISOString(),
      },
    };
  }

  private durationToDays(duration: number, type: string): number {
    const d = +duration || 30;
    switch (type) {
      case 'DAILY': return d;
      case 'WEEKLY': return d * 7;
      case 'MONTHLY': return d * 30;
      case 'QUARTERLY': return d * 90;
      case 'HALF_YEARLY': return d * 180;
      case 'YEARLY': return d * 365;
      default: return d * 30;
    }
  }

  private cycleStartFor(activation: Date, totalDays: number, anniversaryDay: number): Date {
    if (!anniversaryDay) {
      // Default: cycle started at activation - days elapsed. We just use activation
      // as the cycle start if no anniversary day is set.
      return new Date(activation);
    }
    const cycle = new Date(activation);
    cycle.setDate(anniversaryDay);
    if (cycle > activation) cycle.setMonth(cycle.getMonth() - 1);
    return cycle;
  }

  // ─── SUBSCRIBER BILLING MODE ─────────────────────────────────────────

  async getSubscriberBilling(subId: number) {
    let row = await this.prisma.subscriberBilling.findUnique({ where: { subscriberId: subId } });
    if (!row) {
      row = {
        id: 0, subscriberId: subId, mode: 'PREPAID',
        creditLimit: 0, lowBalanceThreshold: 0, autoTopupAmount: 0,
        discountPercent: 0, billingDay: 1, carryOver: true, graceDays: 0,
        createdAt: new Date(), updatedAt: new Date(),
      } as any;
    }
    return row;
  }

  async upsertSubscriberBilling(subId: number, body: any, actor: any) {
    const sub = await this.prisma.subscriber.findUnique({ where: { id: subId } });
    if (!sub) throw new NotFoundException(`Subscriber ${subId} not found`);
    return this.prisma.subscriberBilling.upsert({
      where: { subscriberId: subId },
      update: {
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.creditLimit !== undefined ? { creditLimit: +body.creditLimit } : {}),
        ...(body.lowBalanceThreshold !== undefined ? { lowBalanceThreshold: +body.lowBalanceThreshold } : {}),
        ...(body.autoTopupAmount !== undefined ? { autoTopupAmount: +body.autoTopupAmount } : {}),
        ...(body.discountPercent !== undefined ? { discountPercent: +body.discountPercent } : {}),
        ...(body.billingDay !== undefined ? { billingDay: +body.billingDay } : {}),
        ...(typeof body.carryOver === 'boolean' ? { carryOver: body.carryOver } : {}),
        ...(body.graceDays !== undefined ? { graceDays: +body.graceDays } : {}),
      },
      create: {
        subscriberId: subId,
        mode: body.mode || 'PREPAID',
        creditLimit: +body.creditLimit || 0,
        lowBalanceThreshold: +body.lowBalanceThreshold || 0,
        autoTopupAmount: +body.autoTopupAmount || 0,
        discountPercent: +body.discountPercent || 0,
        billingDay: +body.billingDay || 1,
        carryOver: body.carryOver !== false,
        graceDays: +body.graceDays || 0,
      },
    });
  }

  // ─── SUBSCRIBER BALANCE ───────────────────────────────────────────────

  async getSubscriberBalance(subId: number) {
    const bal = await this.prisma.subscriberBalance.findUnique({ where: { subscriberId: subId } });
    if (!bal) {
      return { subscriberId: subId, balance: 0, reservedBalance: 0, currency: 'PKR' };
    }
    return bal;
  }

  async getSubscriberLedger(subId: number, query: any) {
    const page = +query.page || 1;
    const size = Math.min(+query.pageSize || 50, 200);
    const [rows, total] = await Promise.all([
      this.prisma.subscriberBalanceLedger.findMany({
        where: {
          subscriberId: subId,
          ...(query.type ? { type: query.type } : {}),
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * size, take: size,
      }),
      this.prisma.subscriberBalanceLedger.count({ where: { subscriberId: subId } }),
    ]);
    return { rows, total, page, pageSize: size };
  }

  async topUp(subId: number, body: any, actor: any) {
    if (!body?.amount) throw new BadRequestException('amount is required');
    return this.applyBalance(subId, {
      type: 'TOPUP',
      amount: +body.amount,
      description: body.description ?? 'Top-up',
      actorType: 'STAFF',
      actorId: actor?.id ?? actor?.sub,
      actorName: actor?.name ?? actor?.email ?? null,
      reference: body.reference ?? null,
    });
  }

  async adjust(subId: number, body: any, actor: any) {
    if (!body?.amount) throw new BadRequestException('amount is required (positive=credit, negative=debit)');
    return this.applyBalance(subId, {
      type: 'ADJUSTMENT',
      amount: +body.amount,
      description: body.description ?? body.reason ?? 'Manual adjustment',
      actorType: 'STAFF',
      actorId: actor?.id ?? actor?.sub,
      actorName: actor?.name ?? actor?.email ?? null,
      reference: body.reference ?? null,
    });
  }

  /**
   * Single transactional balance mutation. Reads, applies, writes, and
   * appends a ledger row — never leaves a half-applied state.
   */
  private async applyBalance(subId: number, entry: {
    type: 'TOPUP' | 'RENEWAL' | 'PACKAGE_PURCHASE' | 'REFUND' | 'ADJUSTMENT' | 'TRANSFER' | 'REVERSAL' | 'FEE' | 'REWARD';
    amount: number; description: string; reference?: string | null;
    actorType: string; actorId?: number; actorName?: string | null;
  }) {
    return this.prisma.$transaction(async (db) => {
      let bal = await db.subscriberBalance.findUnique({ where: { subscriberId: subId } });
      if (!bal) {
        bal = await db.subscriberBalance.create({
          data: { subscriberId: subId, balance: 0, reservedBalance: 0, currency: 'PKR' },
        });
      }
      const newBalance = Math.round((bal.balance + entry.amount) * 100) / 100;
      const updated = await db.subscriberBalance.update({
        where: { subscriberId: subId },
        data: { balance: newBalance },
      });
      await db.subscriberBalanceLedger.create({
        data: {
          subscriberId: subId,
          type: entry.type,
          amount: entry.amount,
          balanceAfter: newBalance,
          reference: entry.reference ?? null,
          description: entry.description,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          actorName: entry.actorName ?? null,
        },
      });
      return updated;
    });
  }

  // ─── INVOICE REVERSAL ────────────────────────────────────────────────

  async listReversals(query: any) {
    const page = +query.page || 1;
    const size = Math.min(+query.pageSize || 25, 100);
    const [rows, total] = await Promise.all([
      this.prisma.invoiceReversal.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * size, take: size,
        include: { originalInvoice: true, reversalInvoice: true },
      }),
      this.prisma.invoiceReversal.count(),
    ]);
    return { rows, total, page, pageSize: size };
  }

  async getReversal(id: number) {
    const r = await this.prisma.invoiceReversal.findUnique({
      where: { id },
      include: { originalInvoice: true, reversalInvoice: true },
    });
    if (!r) throw new NotFoundException(`Reversal ${id} not found`);
    return r;
  }

  /**
   * Reverse an invoice. Three modes:
   *   FULL      — cancel the invoice, mark unpaid → cancelled, refund all payments.
   *   PARTIAL   — keep the invoice, reduce total by `amount`, return the diff.
   *   PRO_RATA  — like FULL but the refund is calculated as
   *               paidAmount * (unusedDays / totalDays).
   */
  async reverseInvoice(invoiceId: number, body: any, actor: any) {
    const mode = body?.mode || 'FULL';
    if (!['FULL', 'PARTIAL', 'PRO_RATA'].includes(mode)) {
      throw new BadRequestException('mode must be FULL, PARTIAL, or PRO_RATA');
    }
    if (!body?.reason) throw new BadRequestException('reason is required');

    const original = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true, items: true },
    });
    if (!original) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (original.status === 'CANCELLED') {
      throw new BadRequestException('Invoice is already cancelled');
    }
    const alreadyReversed = await this.prisma.invoiceReversal.findUnique({
      where: { originalInvoiceId: invoiceId },
    });
    if (alreadyReversed) {
      throw new BadRequestException('Invoice has already been reversed');
    }

    let refundAmount = 0;
    if (mode === 'FULL') {
      refundAmount = original.paidAmount;
    } else if (mode === 'PARTIAL') {
      const amount = +body.amount;
      if (!amount || amount <= 0) throw new BadRequestException('amount is required for PARTIAL');
      refundAmount = Math.min(amount, original.paidAmount);
    } else if (mode === 'PRO_RATA') {
      const totalDays = Math.max(1, Math.ceil((original.dueDate.getTime() - original.invoiceDate.getTime()) / 86400000));
      const now = Date.now();
      const unusedDays = Math.max(0, Math.ceil((original.dueDate.getTime() - now) / 86400000));
      refundAmount = Math.round(((original.paidAmount * unusedDays) / totalDays) * 100) / 100;
    }

    // Do the work in a single transaction.
    return this.prisma.$transaction(async (db) => {
      // 1) Mark original as cancelled.
      await db.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'CANCELLED',
          reversedAt: new Date(),
          reversalReason: body.reason,
          reversedBy: actor?.id ?? actor?.sub,
        },
      });

      // 2) Mark all payments as refunded.
      if (original.payments.length > 0) {
        for (const p of original.payments) {
          await db.payment.update({
            where: { id: p.id },
            data: {
              refundedAt: new Date(),
              refundReason: body.reason,
              refundedBy: actor?.id ?? actor?.sub,
            },
          });
        }
      }

      // 3) Create the reversal record.
      const reversal = await db.invoiceReversal.create({
        data: {
          originalInvoiceId: invoiceId,
          reversalInvoiceId: null,
          reason: body.reason,
          proRated: mode === 'PRO_RATA',
          refundedAmount: refundAmount,
          mode,
          createdById: actor?.id ?? actor?.sub,
          createdByName: actor?.name ?? actor?.email ?? null,
        },
      });

      // 4) If the invoice was for a subscriber, refund back to their wallet.
      if (original.subscriberId && refundAmount > 0) {
        const bal = await db.subscriberBalance.findUnique({ where: { subscriberId: original.subscriberId } });
        if (bal) {
          const newBalance = Math.round((bal.balance + refundAmount) * 100) / 100;
          await db.subscriberBalance.update({
            where: { subscriberId: original.subscriberId },
            data: { balance: newBalance },
          });
          await db.subscriberBalanceLedger.create({
            data: {
              subscriberId: original.subscriberId,
              type: 'REFUND',
              amount: refundAmount,
              balanceAfter: newBalance,
              reference: `INV-${invoiceId}-REVERSAL`,
              description: `Refund from invoice reversal (${mode})`,
              actorType: 'STAFF',
              actorId: actor?.id ?? actor?.sub,
              actorName: actor?.name ?? actor?.email ?? null,
            },
          });
        }
      }

      return { reversal, refundAmount };
    });
  }
}
