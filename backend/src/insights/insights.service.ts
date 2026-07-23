import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * Phase 6 — the differentiators.
 *
 * globalSearch(): paste any phone / username / invoice# / payment# / name / id
 * and get every matching entity across the whole system in one call.
 *
 * timeline(): one merged, chronological story for a subscriber — invoices,
 * payments, tickets, messages, sessions, balance moves, config changes — the
 * feature competitors don't have. 🔍
 */
@Injectable()
export class InsightsService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Search across everything the caller may see.
   *
   * SECURITY: this was completely unscoped — it searched every subscriber,
   * invoice, payment, user and ticket in the system. A dealer typing a common
   * name or "03" could read out the ISP's whole customer base, including
   * sibling dealers' customers, invoice amounts and staff accounts. Of every
   * unscoped query in this codebase this was the most exposed, because it is
   * the one built to return anything that matches.
   */
  async globalSearch(qRaw: string, actor?: Actor) {
    const q = (qRaw || '').trim();
    if (q.length < 2) return { query: q, subscribers: [], invoices: [], payments: [], users: [], tickets: [] };
    const asNum = Number(q);
    const isNum = Number.isFinite(asNum);

    // Restrict every branch of the search to the caller's own subtree.
    const isAdmin = !actor || this.scope.isAdmin(actor.role);
    const ids = isAdmin ? null : await this.scope.descendantIds(await this.scope.rootId(actor!));
    const subScope: any = ids ? { userId: { in: ids } } : {};
    const viaSub: any = ids ? { subscriber: { userId: { in: ids } } } : {};
    // Staff results are limited to accounts inside the tree — a dealer has no
    // business discovering the ISP's other users by searching their name.
    const userScope: any = ids ? { id: { in: ids } } : {};

    const [subscribers, invoices, payments, users, tickets] = await Promise.all([
      this.prisma.subscriber.findMany({
        where: {
          ...subScope,
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { username: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { email: { contains: q, mode: 'insensitive' } },
            { identity: { contains: q } },
            ...(isNum ? [{ id: asNum }] : []),
          ],
        },
        select: { id: true, fullName: true, username: true, phone: true, status: true, package: { select: { name: true } } },
        take: 15,
      }),
      this.prisma.invoice.findMany({
        where: {
          ...viaSub,
          OR: [
            { invoiceNo: { contains: q, mode: 'insensitive' } },
            ...(isNum ? [{ id: asNum }, { subscriberId: asNum }] : []),
          ],
        },
        select: { id: true, invoiceNo: true, total: true, status: true, subscriberId: true, invoiceDate: true },
        take: 15,
      }),
      this.prisma.payment.findMany({
        where: {
          ...viaSub,
          OR: [
            { paymentNo: { contains: q, mode: 'insensitive' } },
            { referenceNo: { contains: q, mode: 'insensitive' } },
            ...(isNum ? [{ id: asNum }] : []),
          ],
        },
        select: { id: true, paymentNo: true, amount: true, method: true, subscriberId: true, paymentDate: true },
        take: 15,
      }),
      this.prisma.user.findMany({
        where: {
          ...userScope,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
          ],
        },
        select: { id: true, name: true, email: true, role: true },
        take: 10,
      }),
      this.prisma.ticket.findMany({
        where: {
          ...viaSub,
          OR: [
            { ticketNo: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, ticketNo: true, subject: true, status: true, subscriberId: true },
        take: 10,
      }),
    ]);

    return { query: q, subscribers, invoices, payments, users, tickets };
  }

  /**
   * A subscriber's full history. Also previously unscoped — anyone could pass
   * any id and read another dealer's customer end to end.
   */
  async timeline(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: true, serviceSettings: true, area: true },
    });
    if (!sub) return null;

    const [invoices, payments, tickets, messages, balanceTxs, sessions, activity] = await Promise.all([
      this.prisma.invoice.findMany({ where: { subscriberId }, select: { id: true, invoiceNo: true, total: true, status: true, invoiceDate: true, createdAt: true }, orderBy: { id: 'desc' }, take: 100 }),
      this.prisma.payment.findMany({ where: { subscriberId }, select: { id: true, paymentNo: true, amount: true, method: true, paymentDate: true }, orderBy: { id: 'desc' }, take: 100 }),
      this.prisma.ticket.findMany({ where: { subscriberId }, select: { id: true, ticketNo: true, subject: true, status: true, createdAt: true }, orderBy: { id: 'desc' }, take: 50 }),
      this.prisma.message.findMany({ where: { subscriberId }, select: { id: true, channel: true, event: true, status: true, body: true, createdAt: true }, orderBy: { id: 'desc' }, take: 100 }),
      this.prisma.balanceTransaction.findMany({ where: { subscriberId }, select: { id: true, type: true, amount: true, balanceAfter: true, createdAt: true }, orderBy: { id: 'desc' }, take: 50 }),
      this.prisma.$queryRaw<Array<any>>`
        SELECT acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets, framedipaddress, callingstationid
        FROM radacct WHERE username = ${sub.username} ORDER BY acctstarttime DESC LIMIT 30`,
      this.prisma.activityLog.findMany({ where: { entity: 'Subscriber', entityId: subscriberId }, select: { id: true, action: true, details: true, createdAt: true }, orderBy: { id: 'desc' }, take: 50 }),
    ]);

    type Ev = { at: Date; type: string; icon: string; title: string; detail?: string; color: string };
    const events: Ev[] = [];

    events.push({ at: sub.createdAt, type: 'CREATED', icon: '🎉', title: 'Subscriber created', detail: `${sub.package?.name || 'no package'} · ${sub.area?.name || ''}`, color: 'accent' });
    for (const i of invoices) events.push({ at: i.createdAt, type: 'INVOICE', icon: '🧾', title: `Invoice ${i.invoiceNo}`, detail: `${i.total} · ${i.status}`, color: i.status === 'PAID' ? 'green' : 'amber' });
    for (const p of payments) events.push({ at: p.paymentDate, type: 'PAYMENT', icon: '💰', title: `Payment ${p.paymentNo}`, detail: `${p.amount} · ${p.method}`, color: 'green' });
    for (const t of tickets) events.push({ at: t.createdAt, type: 'TICKET', icon: '🎫', title: `Ticket ${t.ticketNo}`, detail: `${t.subject} · ${t.status}`, color: 'purple' });
    for (const m of messages) events.push({ at: m.createdAt, type: 'MESSAGE', icon: m.channel === 'EMAIL' ? '📧' : '💬', title: `${m.channel} · ${m.event}`, detail: `${m.status}: ${m.body.slice(0, 60)}`, color: 'muted' });
    for (const b of balanceTxs) events.push({ at: b.createdAt, type: 'BALANCE', icon: '👛', title: `Wallet ${b.type}`, detail: `${b.amount >= 0 ? '+' : ''}${b.amount} → ${b.balanceAfter}`, color: b.amount >= 0 ? 'green' : 'red' });
    for (const s of sessions) events.push({ at: s.acctstarttime, type: 'SESSION', icon: s.acctstoptime ? '🔌' : '🟢', title: s.acctstoptime ? 'Session ended' : 'Session (online)', detail: `${s.framedipaddress || ''} ${s.callingstationid || ''}`.trim(), color: s.acctstoptime ? 'muted' : 'green' });
    for (const a of activity) events.push({ at: a.createdAt, type: 'CONFIG', icon: '⚙️', title: a.action, detail: a.details || undefined, color: 'amber' });

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      subscriber: {
        id: sub.id, fullName: sub.fullName, username: sub.username, phone: sub.phone,
        status: sub.status, package: sub.package?.name, balance: sub.balance,
        expiryDate: sub.serviceSettings?.expiryDate,
      },
      counts: { invoices: invoices.length, payments: payments.length, tickets: tickets.length, messages: messages.length, sessions: sessions.length },
      events,
    };
  }
}
