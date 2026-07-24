import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProrationResult {
  daysUsed: number;
  daysRemaining: number;
  dailyRate: number;
  usedAmount: number;
  refundAmount: number;
  newExpiry: Date;
}

/**
 * ProrationService — daily-rate calculations for partial billing cycles.
 *
 * The ISP business runs on pre-paid billing: a customer pays for a month and
 * gets 30 days of service. When they change package, get suspended mid-cycle,
 * or are activated part-way through a billing period, the financial settlement
 * needs to be fair to both the operator and the customer.
 *
 * This service answers two questions:
 *   1. "How much of the current period was consumed?" — for refunds/settlements
 *   2. "How much does N days of a package cost?" — for pro-rated activations
 *
 * It is deliberately stateless — every method takes the inputs it needs and
 * returns a calculation. No writes, no side effects.
 */
@Injectable()
export class ProrationService {
  private readonly logger = new Logger(ProrationService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Calculate proration for a mid-cycle package change.
   *
   * Given a subscriber's current expiry and their old/new packages, this
   * computes:
   *   - How many days of the old package were consumed
   *   - What those consumed days cost
   *   - What the unused portion is worth (to credit back)
   *   - A new daily rate for go-forward billing
   */
  async calculateChange(
    currentExpiry: Date,
    oldPackage: { price: number; duration: number },
    newPackage: { price: number; duration: number },
  ): Promise<ProrationResult> {
    const now = new Date();
    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - (oldPackage.duration || 30));

    const periodDays = oldPackage.duration || 30;
    const dailyRate = periodDays > 0 ? oldPackage.price / periodDays : oldPackage.price / 30;

    // Days used in the current period
    const daysUsed = Math.ceil(
      Math.max(0, (now.getTime() - periodStart.getTime()) / 86_400_000),
    );
    const daysRemaining = Math.max(0, periodDays - daysUsed);
    const usedAmount = Math.round(dailyRate * daysUsed);
    const refundAmount = Math.round(dailyRate * daysRemaining);

    // New expiry: remaining days of old period + full new period
    const newExpiry = new Date(now);
    newExpiry.setDate(newExpiry.getDate() + daysRemaining + (newPackage.duration || 30));

    return {
      daysUsed,
      daysRemaining,
      dailyRate: Math.round(dailyRate),
      usedAmount,
      refundAmount,
      newExpiry,
    };
  }

  /**
   * Calculate the cost for a partial-period activation.
   *
   * When a subscriber is activated partway through a billing cycle (or
   * activates for a custom number of days), this returns what to charge.
   */
  async calculateActivation(
    packagePrice: number,
    packageDuration: number,
    days: number,
  ): Promise<{ amount: number; dailyRate: number; expiryDate: Date }> {
    const duration = packageDuration || 30;
    const dailyRate = duration > 0 ? packagePrice / duration : packagePrice / 30;
    const amount = Math.round(dailyRate * days);
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);

    return { amount, dailyRate: Math.round(dailyRate), expiryDate };
  }

  /**
   * Calculate refund value for unused days when a subscriber is suspended or
   * downgrades mid-cycle. Returns what should be credited to the wallet.
   */
  async calculateRefund(
    currentExpiry: Date,
    packagePrice: number,
    packageDuration: number,
  ): Promise<{ refundAmount: number; daysRemaining: number; dailyRate: number }> {
    const now = new Date();
    if (currentExpiry <= now) {
      return { refundAmount: 0, daysRemaining: 0, dailyRate: 0 };
    }

    const msRemaining = currentExpiry.getTime() - now.getTime();
    const daysRemaining = Math.ceil(msRemaining / 86_400_000);
    const duration = packageDuration || 30;
    const dailyRate = duration > 0 ? packagePrice / duration : packagePrice / 30;
    const refundAmount = Math.round(dailyRate * daysRemaining);

    return { refundAmount, daysRemaining, dailyRate: Math.round(dailyRate) };
  }

  /**
   * Get the daily rate for a package (price / duration).
   */
  getDailyRate(price: number, duration: number): number {
    duration = duration || 30;
    return duration > 0 ? Math.round((price / duration) * 100) / 100 : price / 30;
  }
}