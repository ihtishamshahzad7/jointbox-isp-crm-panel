import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ThrottleRule {
  subscriberId: number;
  downloadSpeed: number;  // Mbps
  uploadSpeed: number;    // Mbps
  reason: string;
  appliedAt: Date;
  expiresAt?: Date;
}

@Injectable()
export class ThrottleService {
  private readonly logger = new Logger(ThrottleService.name);
  private activeThrottles = new Map<number, ThrottleRule>();

  constructor(private prisma: PrismaService) {}

  /**
   * Apply a throttle to a subscriber (reduce speed to FUP or custom limits).
   */
  async applyThrottle(subscriberId: number, dlSpeed: number, ulSpeed: number, reason: string, expiresInMinutes?: number): Promise<void> {
    const rule: ThrottleRule = {
      subscriberId,
      downloadSpeed: dlSpeed,
      uploadSpeed: ulSpeed,
      reason,
      appliedAt: new Date(),
      expiresAt: expiresInMinutes ? new Date(Date.now() + expiresInMinutes * 60_000) : undefined,
    };
    this.activeThrottles.set(subscriberId, rule);

    // Apply via RADIUS
    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { username: true } });
    if (sub?.username) {
      const rateLimit = `${dlSpeed}M/${ulSpeed}M`;
      // Delete-then-insert, NOT `ON CONFLICT (username, attribute)`: that
      // requires a UNIQUE index on radcheck(username, attribute) which the
      // stock FreeRADIUS schema does not create, so it throws on a default
      // install and the throttle is never actually applied.
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM radcheck WHERE username = $1 AND attribute = 'MikroTik-Rate-Limit'`,
        sub.username,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, 'MikroTik-Rate-Limit', ':=', $2)`,
        sub.username, rateLimit,
      );
      this.logger.log(`⚡ Throttled ${sub.username} → ${rateLimit} (${reason})`);
    }

    // Schedule removal if temporary
    if (expiresInMinutes) {
      setTimeout(() => this.removeThrottle(subscriberId), expiresInMinutes * 60_000);
    }
  }

  /**
   * Remove a throttle, restoring normal speed.
   */
  async removeThrottle(subscriberId: number): Promise<void> {
    this.activeThrottles.delete(subscriberId);
    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { username: true, package: { select: { downloadSpeed: true, uploadSpeed: true } } } });
    if (sub?.username && sub.package) {
      const rateLimit = `${sub.package.downloadSpeed}M/${sub.package.uploadSpeed}M`;
      // See applyThrottle above — ON CONFLICT needs an index the stock
      // FreeRADIUS schema lacks, and its failure here would leave the customer
      // throttled with no way back to full speed.
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM radcheck WHERE username = $1 AND attribute = 'MikroTik-Rate-Limit'`,
        sub.username,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES ($1, 'MikroTik-Rate-Limit', ':=', $2)`,
        sub.username, rateLimit,
      );
      this.logger.log(`⚡ Un-throttled ${sub.username} → ${rateLimit}`);
    }
  }

  /**
   * Check if a subscriber is currently throttled.
   */
  isThrottled(subscriberId: number): ThrottleRule | null {
    const rule = this.activeThrottles.get(subscriberId);
    if (!rule) return null;
    if (rule.expiresAt && rule.expiresAt < new Date()) {
      this.activeThrottles.delete(subscriberId);
      return null;
    }
    return rule;
  }

  /**
   * Get all active throttles.
   */
  getActiveThrottles(): ThrottleRule[] {
    return Array.from(this.activeThrottles.values()).filter((r) => !r.expiresAt || r.expiresAt >= new Date());
  }
}
