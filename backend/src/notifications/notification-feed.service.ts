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

  /**
   * Plain-language label + icon for the actions that ACTUALLY land in
   * ActivityLog. The global audit interceptor records `action` as the uppercased
   * permission key (e.g. SUBSCRIBERS.ACTIVATION, USERS.TOPUP) or, when no route
   * mapping exists, the generic CREATE / UPDATE / DELETE. The feed previously
   * looked for names like CREATE_SUBSCRIBER that are never written, so it was
   * always empty. These keys match the real log.
   */
  private static readonly VERBS: Record<string, { verb: string; icon: string }> = {
    'SUBSCRIBERS.WRITE':            { verb: 'added / edited a subscriber', icon: 'user-plus' },
    'SUBSCRIBERS.ACTIVATION':       { verb: 'activated / renewed', icon: 'check' },
    'SUBSCRIBERS.DISCONNECT':       { verb: 'disconnected', icon: 'pause' },
    'SUBSCRIBERS.DELETE':           { verb: 'deleted a subscriber', icon: 'trash' },
    'SUBSCRIBERS.MASSDELETE':       { verb: 'bulk-deleted subscribers', icon: 'trash' },
    'SUBSCRIBERS.GRACEPERIOD':      { verb: 'granted grace to', icon: 'clock' },
    'SUBSCRIBERS.CHANGEBANDWIDTH':  { verb: 'changed bandwidth for', icon: 'gauge' },
    'GRACE_PERIOD_GRANTED':         { verb: 'granted grace to', icon: 'clock' },
    'PAYMENTS.WRITE':               { verb: 'recorded a payment', icon: 'cash' },
    'USERS.WRITE':                  { verb: 'added / edited an account', icon: 'user-plus' },
    'USERS.DELETE':                 { verb: 'deleted an account', icon: 'trash' },
    'USERS.TOPUP':                  { verb: 'topped up a wallet', icon: 'wallet' },
    'USERS.TRANSFERSUBSCRIBERS':    { verb: 'moved subscribers', icon: 'refresh' },
    'NAS.WRITE':                    { verb: 'added / edited a router', icon: 'router' },
    'NAS.DELETE':                   { verb: 'removed a router', icon: 'router-off' },
    'INVOICES.WRITE':               { verb: 'raised an invoice', icon: 'file' },
    'AREAS.WRITE':                  { verb: 'changed an area', icon: 'map' },
    CRM_LEAD_CREATED:               { verb: 'created a lead', icon: 'user-plus' },
    CRM_LEAD_UPDATED:               { verb: 'updated a lead', icon: 'edit' },
    CRM_LEAD_CONVERSION:            { verb: 'converted a lead', icon: 'check' },
    CRM_LEAD_ARCHIVED:              { verb: 'archived a lead', icon: 'archive' },
    CRM_LEAD_RESTORED:              { verb: 'restored a lead', icon: 'refresh' },
    'CRM.LEAD.FOLLOW_UP_DUE':       { verb: 'has a lead follow-up due', icon: 'clock' },
    TASK_CREATED:                   { verb: 'created a task', icon: 'plus' },
    TASK_UPDATED:                   { verb: 'updated a task', icon: 'edit' },
    TASK_ASSIGNED:                  { verb: 'changed a task assignment', icon: 'users' },
    TASK_STATUS_CHANGED:            { verb: 'updated task progress', icon: 'check' },
    TASK_COMMENT:                   { verb: 'commented on a task', icon: 'message' },
    TASK_REMINDER_QUEUED:           { verb: 'received a task reminder', icon: 'clock' },
    'FIELD_JOB.CREATED':            { verb: 'created a field job', icon: 'plus' },
    'FIELD_JOB.ASSIGNED':           { verb: 'assigned a field job', icon: 'users' },
    'FIELD_JOB.SCHEDULED':          { verb: 'scheduled a field visit', icon: 'calendar' },
    'FIELD_JOB.ARRIVED':            { verb: 'recorded arrival for a field job', icon: 'map' },
    'FIELD_JOB.STARTED':            { verb: 'started a field job', icon: 'play' },
    'FIELD_JOB.COMPLETION_SUBMITTED': { verb: 'submitted a field job for review', icon: 'check' },
    'FIELD_JOB.COMPLETION_APPROVED': { verb: 'approved field job completion', icon: 'check' },
    'FIELD_JOB.COMPLETION_REJECTED': { verb: 'rejected field job completion', icon: 'alert' },
    'FIELD_JOB.CANCELLED':          { verb: 'cancelled a field job', icon: 'x' },
    'FIELD_JOB.MATERIAL_RESERVE':   { verb: 'reserved job materials', icon: 'box' },
    'FIELD_JOB.MATERIAL_ISSUE':     { verb: 'issued job materials', icon: 'box' },
    'FIELD_JOB.MATERIAL_CONSUME':   { verb: 'recorded consumed job materials', icon: 'box' },
    'FIELD_JOB.MATERIAL_RETURN':    { verb: 'returned unused job materials', icon: 'box' },
    'FIELD_JOB.MATERIAL_DAMAGED':   { verb: 'reported damaged job materials', icon: 'alert' },
    'FIELD_JOB.MATERIAL_LOST':      { verb: 'reported missing job materials', icon: 'alert' },
    // generic fallbacks the interceptor writes for unmapped routes
    CREATE: { verb: 'created', icon: 'plus' },
    UPDATE: { verb: 'updated', icon: 'edit' },
    DELETE: { verb: 'deleted', icon: 'trash' },
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
    const where: any = { action: { in: Object.keys(NotificationFeedService.VERBS) } };

    /**
     * Non-admins see only their own subtree's activity.
     *
     * The id MUST come from scope.rootId(), not from a hand-read property.
     * The JWT puts the user id on `sub`, so an earlier version of this reading
     * `actor.userId ?? actor.id` produced NaN, which made descendantIds()
     * return nothing and the feed silently empty for every reseller. rootId()
     * also handles the SALES role, whose activity belongs to its parent.
     */
    // The platform account's bell shows its own actions (companies created,
    // suspended, opened) — never what happens inside a company.
    if (actor?.role === 'SUPER_ADMIN') {
      where.userId = this.scope.actorId(actor);
    } else if (!this.scope.isAdmin(actor?.role)) {
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
      const meta = NotificationFeedService.VERBS[r.action] || { verb: r.action.replace(/[._]/g, ' ').toLowerCase(), icon: 'bell' };
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
