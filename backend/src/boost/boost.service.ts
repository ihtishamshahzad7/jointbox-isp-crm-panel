import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CoaService } from '../network/coa.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Temporary speed boost / change.
 *
 * TWO OPTIONS in one call:
 *  1) A **permanent** live speed change — durationHours = 0/absent. Applied via
 *     CoA now, persisted to radcheck, stays until changed again.
 *  2) A **temporary** boost — durationHours > 0. Same live apply, plus a stored
 *     record with an expiry; a background job restores the plan's normal speed
 *     automatically when it expires, so nobody has to remember to revert it.
 */
@Injectable()
export class BoostService {
  private readonly log = new Logger('Boost');

  constructor(private prisma: PrismaService, private coa: CoaService) {}

  /** The plan's normal speed, used as the restore target. */
  private async planSpeed(subscriberId: number): Promise<{ down: number; up: number }> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { package: { select: { downloadSpeed: true, uploadSpeed: true } } },
    });
    return { down: sub?.package?.downloadSpeed ?? 10, up: sub?.package?.uploadSpeed ?? 5 };
  }

  async apply(input: {
    subscriberId: number; downMbps: number; upMbps: number;
    durationHours?: number; reason?: string; charge?: number; createdById?: number;
  }) {
    const { subscriberId } = input;
    const down = Math.round(Number(input.downMbps));
    const up = Math.round(Number(input.upMbps));
    if (!subscriberId || !(down > 0) || !(up > 0)) throw new BadRequestException('Valid subscriber and speeds are required.');

    const original = await this.planSpeed(subscriberId);

    // Apply live now (CoA + radcheck persist).
    const res = await this.coa.changeBandwidth(subscriberId, down, up);
    if (!res.success) throw new BadRequestException(res.message || 'Could not apply the new speed.');

    const hours = Number(input.durationHours) || 0;
    const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3600_000) : null;

    const rec = await this.prisma.temporaryBoost.create({
      data: {
        subscriberId, boostDown: down, boostUp: up,
        originalDown: original.down, originalUp: original.up,
        reason: input.reason, charge: input.charge ?? 0,
        expiresAt, createdById: input.createdById ?? null,
        reverted: expiresAt ? false : true, // a permanent change needs no revert
        revertedAt: expiresAt ? null : new Date(),
      },
    });

    return {
      ok: true,
      live: res.live,
      mode: expiresAt ? 'temporary' : 'permanent',
      applied: `${down}M/${up}M`,
      restoresTo: expiresAt ? `${original.down}M/${original.up}M` : null,
      expiresAt,
      message: expiresAt
        ? `Boosted to ${down}M/${up}M — reverts to ${original.down}M/${original.up}M automatically at ${expiresAt.toLocaleString()}.`
        : `Speed changed to ${down}M/${up}M (permanent until changed).`,
      id: rec.id,
    };
  }

  /** Active (not-yet-reverted, still-timed) boosts, optionally for one subscriber. */
  async active(subscriberId?: number) {
    return this.prisma.temporaryBoost.findMany({
      where: { reverted: false, expiresAt: { not: null }, ...(subscriberId ? { subscriberId } : {}) },
      orderBy: { expiresAt: 'asc' },
      include: { subscriber: { select: { fullName: true, username: true } } },
    });
  }

  /** Revert one boost now (manual "cancel boost"). */
  async revert(id: number) {
    const b = await this.prisma.temporaryBoost.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Boost not found');
    if (b.reverted) return { ok: true, alreadyReverted: true };
    await this.coa.changeBandwidth(b.subscriberId, b.originalDown, b.originalUp).catch(() => undefined);
    await this.prisma.temporaryBoost.update({ where: { id }, data: { reverted: true, revertedAt: new Date() } });
    return { ok: true, restoredTo: `${b.originalDown}M/${b.originalUp}M` };
  }

  /** Every 5 min: restore any expired boost to the plan's normal speed. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async revertExpired() {
    if (!isPrimaryInstance()) return;
    const due = await this.prisma.temporaryBoost.findMany({
      where: { reverted: false, expiresAt: { lte: new Date() } },
    });
    for (const b of due) {
      try {
        await this.coa.changeBandwidth(b.subscriberId, b.originalDown, b.originalUp);
        await this.prisma.temporaryBoost.update({ where: { id: b.id }, data: { reverted: true, revertedAt: new Date() } });
        this.log.log(`Boost #${b.id} expired → restored subscriber ${b.subscriberId} to ${b.originalDown}M/${b.originalUp}M`);
      } catch (e: any) {
        this.log.warn(`Failed to auto-revert boost #${b.id}: ${e?.message || e}`);
      }
    }
  }
}
