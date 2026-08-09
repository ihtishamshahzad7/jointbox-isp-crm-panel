import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * The in-app notification feed — the bell in the header.
 *
 * WHY IT READS ActivityLog RATHER THAN A NEW TABLE
 * Every action worth being notified about is already written to ActivityLog by
 * the code that performs it. A separate `Notification` table would mean a
 * migration, a second write on every action, and two records that drift apart
 * the first time someone forgets to write the second one. Reading the log we
 * already keep means a new feature automatically appears in the feed the day
 * it ships.
 *
 * SCOPE IS NOT OPTIONAL HERE. A feed is a very easy way to leak the thing this
 * panel most needs to protect: a dealer must never learn that another dealer
 * signed up a customer. Every query below is filtered to the viewer's own
 * subtree using the same ScopeService the rest of the app uses, so the feed can
 * never show more than the screens already would.
 */
@Injectable()
export class NotificationFeedService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  /** Actions worth interrupting someone for, mapped to plain language. */
  private static readonly INTERESTING: Record<string, { verb: string; icon: string }> = {
    CREATE_SUBSCRIBER: { verb: 'added a new subscriber', icon: 'user-plus' },
    ACTIVATE_SUBSCRIBER: { verb: 'activated', icon: 'check' },
    RENEW_SUBSCRIBER: { verb: 'renewed', icon: 'refresh' },
    SUSPEND_SUBSCRIBER: { verb: 'suspended', icon: 'pause' },
    DELETE_SUBSCRIBER: { verb: 'deleted', icon: 'trash' },
    CREATE_PAYMENT: { verb: 'recorded a payment for', icon: 'cash' },
    REFUND_PAYMENT: { verb: 'refunded', icon: 'arrow-back' },
    CREATE_USER: { verb: 'created the account', icon: 'user-plus' },
    CREATE_NAS: { verb: 'added the router', icon: 'router' },
    DELETE_NAS: { verb: 'removed the router', icon: 'router-off' },
    TOPUP: { verb: 'topped up', icon: 'wallet' },
  };

  /**
   * Recent activity the viewer is allowed to see.
   *
   * `since` is the timestamp the user last opened the bell, kept client-side —
   * anything newer counts as unread. Storing read state per user would need a
   * table and a write on every open; the badge only has to answer "is there
   * something new", and a timestamp answers that exactly.
   */
  async feed(actor: Actor, since?: string, limit = 20) {
    const where: any = { action: { in: Object.keys(NotificationFeedService.INTERESTING) } };

    /**
     * Non-admins see only their own subtree's activity.
     *
     * The id MUST come from scope.rootId(), not from a hand-read property.
     * The JWT puts the user id on `sub`, so an earlier version of this reading
     * `actor.userId ?? actor.id` produced NaN, which made descendantIds()
     * return nothing and the feed silently empty for every reseller. rootId()
     * also handles the SALES role, whose activity belongs to its parent.
     */
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      // Fail CLOSED: an unresolvable actor sees nothing rather than everything.
      where.userId = { in: ids.length ? ids : [-1] };
    }

    const rows = await this.prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
      select: {
        id: true, action: true, entity: true, entityId: true,
        details: true, createdAt: true,
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });

    const sinceDate = since ? new Date(since) : null;
    const items = rows.map((r) => {
      const meta = NotificationFeedService.INTERESTING[r.action] || { verb: r.action.toLowerCase(), icon: 'bell' };
      const who = r.user?.name || r.user?.email || 'Someone';
      return {
        id: r.id,
        title: `${who} ${meta.verb}`,
        detail: r.details || r.entity,
        icon: meta.icon,
        entity: r.entity,
        entityId: r.entityId,
        // The avatar shown on the row is the ACTOR's — the person who did it.
        actor: {
          id: r.user?.id ?? null,
          name: who,
          photoUrl: r.user?.photoUrl ?? null,
        },
        createdAt: r.createdAt,
        unread: sinceDate ? r.createdAt > sinceDate : true,
      };
    });

    return { items, unread: items.filter((i) => i.unread).length };
  }
}
