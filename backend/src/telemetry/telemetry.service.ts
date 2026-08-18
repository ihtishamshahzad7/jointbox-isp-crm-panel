import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { ScopeService } from '../common/scope.service';

/**
 * Read-side of link tracing: the live feed (from the aggregator's ring buffer
 * plus recent persisted events) and the per-subscriber link path used on the
 * subscriber profile.
 */
@Injectable()
export class TelemetryService {
  constructor(
    private prisma: PrismaService,
    private aggregator: LinkAggregatorService,
    private scope: ScopeService,
  ) {}

  /** Live sidebar feed — in-memory recent events (newest first). */
  liveFeed(limit = 50) {
    return this.aggregator.getFeed(limit);
  }

  /** All network events for a NAS or globally, from the durable log. */
  async events(opts: { nasId?: number; limit?: number; actor?: any } = {}) {
    /**
     * Events are per-device data, so the list must be limited to the devices the
     * caller may see. Unscoped, a reseller could read every tenant's link-down,
     * ONU-LOS and auth-failure events straight from this endpoint.
     */
    let where: any = opts.nasId ? { nasId: opts.nasId } : undefined;
    if (opts.actor && !this.scope.isAdmin(opts.actor.role)) {
      const allowed = await this.prisma.nas.findMany({
        where: await this.scope.nasWhere(opts.actor),
        select: { id: true },
      });
      const ids = allowed.map((n) => n.id);
      where = opts.nasId
        ? { nasId: ids.includes(opts.nasId) ? opts.nasId : -1 }
        : { nasId: { in: ids.length ? ids : [-1] } };
    }
    return this.prisma.networkLog.findMany({
      where,
      orderBy: { loggedAt: 'desc' },
      take: Math.min(opts.limit || 100, 500),
      select: {
        id: true, nasId: true, eventType: true, severity: true, message: true,
        username: true, eventReason: true, loggedAt: true,
      },
    });
  }

  /**
   * Reconstruct a subscriber's live connection path:
   *   PPPoE session → NAS → (OLT/PON if fibre) → latest optical signals,
   * plus the last events and a 24h signal series for the chart.
   */
  async subscriberPath(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      // `fullName`, not `name` — Subscriber has no `name` column, so this
      // threw PrismaClientValidationError and the whole endpoint 500'd.
      select: { id: true, username: true, fullName: true, nasId: true },
    });
    if (!sub) return { found: false };

    const session = await this.prisma.pppoeSession.findFirst({
      where: { subscriberId, isActive: true },
      orderBy: { lastSeenAt: 'desc' },
    });

    const nas = sub.nasId
      ? await this.prisma.nas.findUnique({
          where: { id: sub.nasId },
          select: { id: true, nasname: true, deviceType: true, snmpEnabled: true, syslogEnabled: true, apiEnabled: true },
        })
      : null;

    const since = new Date(Date.now() - 24 * 3600_000);
    const [latestSignals, signalSeries, recentEvents] = await Promise.all([
      // newest reading per kind
      this.prisma.linkSignal.findMany({
        where: { OR: [{ subscriberId }, { username: sub.username }] },
        orderBy: { readAt: 'desc' },
        take: 8,
      }),
      this.prisma.linkSignal.findMany({
        where: { OR: [{ subscriberId }, { username: sub.username }], readAt: { gte: since } },
        orderBy: { readAt: 'asc' },
        select: { dbm: true, kind: true, status: true, readAt: true },
        take: 500,
      }),
      this.prisma.networkLog.findMany({
        where: { OR: [{ subscriberId }, { username: sub.username }] },
        orderBy: { loggedAt: 'desc' },
        take: 10,
        select: { id: true, eventType: true, severity: true, message: true, loggedAt: true, eventReason: true },
      }),
    ]);

    // Deduplicate latest signal per kind.
    const byKind: Record<string, any> = {};
    for (const s of latestSignals) if (!byKind[s.kind]) byKind[s.kind] = s;

    return {
      found: true,
      // Keep the response key `name` so the frontend contract is unchanged.
      subscriber: { id: sub.id, username: sub.username, name: sub.fullName },
      online: !!session,
      session: session
        ? {
            framedIp: session.framedIp,
            framedIpv6: session.framedIpv6,
            callerId: session.callerId,
            sessionTime: session.sessionTime,
            startTime: session.startTime,
          }
        : null,
      nas,
      signals: Object.values(byKind),
      signalSeries,
      events: recentEvents,
    };
  }
}
