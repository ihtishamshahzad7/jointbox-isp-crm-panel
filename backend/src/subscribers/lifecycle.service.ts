import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * LifecycleService — the automated billing lifecycle (dunning).
 *
 * This is the revenue-protecting piece a manual system lacks: it reminds
 * customers before they expire, and when they DO expire it actually cuts the
 * service in RADIUS instead of leaving them online for free. Reactivation on
 * payment already happens in the renewal/gateway flow; this closes the other
 * half of the loop.
 *
 * One daily sweep, per subscriber, fully guarded so one failure never stops the
 * batch. Tunable by env:
 *   RENEW_REMINDER_DAYS   comma list, default "3,1"  — days-before-expiry to nudge
 *   RENEW_GRACE_DAYS      default 0                   — days past expiry before cut-off
 *   RENEW_AUTOSUSPEND     default "true"              — set false to remind only
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private prisma: PrismaService,
    private radius: RadiusSyncService,
    private notifications: NotificationsService,
  ) {}

  private get reminderDays(): number[] {
    return (process.env.RENEW_REMINDER_DAYS || '3,1')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private get graceDays(): number { return Math.max(0, parseInt(process.env.RENEW_GRACE_DAYS || '0', 10) || 0); }
  private get autoSuspend(): boolean { return String(process.env.RENEW_AUTOSUSPEND ?? 'true').toLowerCase() !== 'false'; }

  /** 07:10 daily — after the credit-default sweep at 06:30. */
  @Cron('10 7 * * *')
  async dailySweep() {
    try {
      const now = new Date();
      const reminders = this.reminderDays;
      const horizon = new Date(now.getTime() + (Math.max(...reminders, 1) + 1) * 86400_000);

      // Every active/soon-expiring subscriber with an expiry date in the window
      // we care about (already expired, or expiring within the largest reminder).
      const subs = await this.prisma.subscriber.findMany({
        where: {
          status: { in: ['ACTIVE', 'EXPIRED'] },
          serviceSettings: { is: { expiryDate: { not: null, lte: horizon } } },
        },
        select: {
          id: true, fullName: true, phone: true, username: true, status: true, onHold: true,
          serviceSettings: { select: { expiryDate: true, gracePeriodUntil: true } },
        },
      });

      let reminded = 0, suspended = 0;
      const cutoff = new Date(now.getTime() - this.graceDays * 86400_000);

      for (const s of subs) {
        const exp = s.serviceSettings?.expiryDate ? new Date(s.serviceSettings.expiryDate) : null;
        if (!exp) continue;
        const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86400_000);

        try {
          // 1. Pre-expiry reminder on the configured days.
          if (s.status === 'ACTIVE' && daysLeft > 0 && reminders.includes(daysLeft) && s.phone) {
            await this.notifications.send({
              channel: 'SMS', recipient: s.phone, subscriberId: s.id, event: 'RENEWAL_REMINDER',
              body: `Dear ${s.fullName}, your internet expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${exp.toLocaleDateString()}). Please renew to avoid disconnection.`,
            }).catch((e) => { this.logger?.warn?.('sendReminder: ' + (e?.message || e)); });
            reminded++;
          }

          // 2. Expiry cut-off: past expiry (+ grace) and still ACTIVE → suspend.
          //    A subscriber under dispute (onHold) is skipped — never cut while
          //    the disagreement is being reviewed.
          // A per-subscriber grace period, if still in the future, holds off the
          // cut-off — the customer stays online until the grace moment passes.
          const graceUntil = s.serviceSettings?.gracePeriodUntil
            ? new Date(s.serviceSettings.gracePeriodUntil) : null;
          const inGrace = graceUntil ? graceUntil > now : false;

          if (s.status === 'ACTIVE' && !s.onHold && !inGrace && exp < cutoff) {
            await this.prisma.subscriber.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
            if (this.autoSuspend && s.username) {
              await this.radius.removeSubscriberFromRadius(s.username).catch((e) =>
                this.logger.warn(`RADIUS cut-off failed for ${s.username}: ${e?.message || e}`));
            }
            if (s.phone) {
              await this.notifications.send({
                channel: 'SMS', recipient: s.phone, subscriberId: s.id, event: 'EXPIRED_SUSPENDED',
                body: `Dear ${s.fullName}, your internet has expired and been suspended. Please pay to reconnect.`,
              }).catch((e) => { this.logger?.warn?.('sendSuspensionNotification: ' + (e?.message || e)); });
            }
            suspended++;
          }
        } catch (e: any) {
          this.logger.warn(`Lifecycle sweep failed for subscriber #${s.id}: ${e?.message || e}`);
        }
      }

      if (reminded || suspended) this.logger.log(`Lifecycle sweep: ${reminded} reminded, ${suspended} suspended`);
      return { reminded, suspended };
    } catch (e: any) {
      this.logger.warn(`Lifecycle sweep aborted: ${e?.message || e}`);
      return { reminded: 0, suspended: 0 };
    }
  }

  /** Manual trigger for the console/admin (same logic as the cron). */
  async runNow() { return this.dailySweep(); }
}
