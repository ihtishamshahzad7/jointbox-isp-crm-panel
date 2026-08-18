import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../common/queue.service';
import { ScopeService, Actor } from '../common/scope.service';
import { isPrimaryInstance } from '../common/cluster-util';

/**
 * Phase 2 communication engine.
 * - Pluggable gateways via env (no code change to swap providers):
 *     SMS_GATEWAY_URL   e.g. "https://sms.example.com/send?to={phone}&text={message}&key=XXX"
 *     SMS_GATEWAY_METHOD  GET (default) | POST
 *     SMS_GATEWAY_BODY    JSON template for POST, e.g. {"to":"{phone}","text":"{message}"}
 *     SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
 * - Nothing configured → messages are marked SIMULATED (safe to test everything).
 * - All sends run through the queue (⚡ never in the request path, retried on failure).
 * - Every message is stored in the Message table (🔍 per-subscriber communication log).
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private mailer: any = null;

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private scope: ScopeService,
  ) {
    this.queue.registerProcessor('send-message', (data) => this.processMessage(data.messageId));
  }

  async onModuleInit() {
    await this.seedDefaultTemplates();
  }

  /**
   * On a fresh install the event triggers fire but there are no templates, so
   * nothing is ever sent. Seed a sensible default per event so customer
   * notifications work the moment a gateway is configured. Only runs when the
   * table is empty — it never overwrites or fights an operator's own edits.
   */
  private async seedDefaultTemplates() {
    try {
      const existing = await this.prisma.messageTemplate.count();
      if (existing > 0) return;
      const defaults = [
        { name: 'Welcome (SMS)', event: 'WELCOME', channel: 'SMS',
          body: 'Welcome to our network, {name}! Your username is {username} on the {package} plan. Thank you for joining us.' },
        { name: 'Payment receipt (SMS)', event: 'PAYMENT_RECEIVED', channel: 'SMS',
          body: 'Dear {name}, we have received your payment of {amount}. Your service is active until {expiry}. Thank you.' },
        { name: 'Invoice created (SMS)', event: 'INVOICE_CREATED', channel: 'SMS',
          body: 'Dear {name}, invoice {invoiceNo} for {amount} has been generated. Please pay to avoid interruption.' },
        { name: 'Renewal confirmation (SMS)', event: 'RENEWAL', channel: 'SMS',
          body: 'Dear {name}, your {package} plan has been renewed. New expiry: {expiry}. Thank you.' },
        { name: 'Expiry reminder (SMS)', event: 'EXPIRY_REMINDER', channel: 'SMS',
          body: 'Dear {name}, your internet expires on {expiry}. Please recharge to stay connected.' },
        { name: 'Suspension notice (SMS)', event: 'SUSPENSION', channel: 'SMS',
          body: 'Dear {name}, your service has been suspended for non-payment. Please clear your dues to restore it.' },
      ];
      await this.prisma.messageTemplate.createMany({ data: defaults as any });
      this.logger.log(`Seeded ${defaults.length} default message templates.`);
    } catch (e: any) {
      this.logger.warn(`Default template seeding skipped: ${e.message}`);
    }
  }

  // ── Gateway status ────────────────────────────────────────────
  gatewayStatus() {
    return {
      sms: process.env.SMS_GATEWAY_URL ? 'configured' : 'simulated',
      email: process.env.SMTP_HOST ? 'configured' : 'simulated',
    };
  }

  // ── Template rendering ────────────────────────────────────────
  render(text: string, vars: Record<string, any>) {
    return text.replace(/\{(\w+)\}/g, (_, key) => {
      const v = vars[key];
      if (v === undefined || v === null) return `{${key}}`;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v);
    });
  }

  private varsForSubscriber(sub: any, extra: Record<string, any> = {}) {
    return {
      name: sub?.fullName,
      username: sub?.username,
      phone: sub?.phone,
      package: sub?.package?.name,
      balance: sub?.balance,
      expiry: sub?.serviceSettings?.expiryDate,
      ...extra,
    };
  }

  // ── Core send API ─────────────────────────────────────────────

  /** Queue a single message. Returns the Message row immediately (status QUEUED). */
  async send(opts: {
    channel: 'SMS' | 'EMAIL';
    recipient: string;
    body: string;
    subject?: string;
    subscriberId?: number;
    event?: string;
    createdBy?: number;
  }) {
    if (!opts.recipient) throw new BadRequestException('Recipient is required');
    if (!opts.body?.trim()) throw new BadRequestException('Message body is required');

    const message = await this.prisma.message.create({
      data: {
        channel: opts.channel,
        recipient: opts.recipient,
        subject: opts.subject || null,
        body: opts.body,
        subscriberId: opts.subscriberId,
        event: opts.event || 'MANUAL',
        createdBy: opts.createdBy,
      },
    });
    await this.queue.add('send-message', { messageId: message.id });
    return message;
  }

  /** Fire an event: find active templates for it and send to the subscriber. Never throws. */
  async fireEvent(event: string, subscriber: any, extra: Record<string, any> = {}) {
    try {
      const templates = await this.prisma.messageTemplate.findMany({ where: { event, isActive: true } });
      const vars = this.varsForSubscriber(subscriber, extra);
      for (const tpl of templates) {
        const recipient = tpl.channel === 'SMS' ? subscriber?.phone : subscriber?.email;
        if (!recipient) continue;
        await this.send({
          channel: tpl.channel as any,
          recipient,
          subject: tpl.subject ? this.render(tpl.subject, vars) : undefined,
          body: this.render(tpl.body, vars),
          subscriberId: subscriber?.id,
          event,
        });
      }
    } catch (e: any) {
      this.logger.warn(`fireEvent(${event}) failed: ${e.message}`);
    }
  }

  /** Bulk send to a target audience. Returns queued count. */
  async bulkSend(opts: {
    channel: 'SMS' | 'EMAIL';
    body: string;
    subject?: string;
    title?: string;
    target?: { status?: string; areaId?: number; packageId?: number; subscriberIds?: number[] };
    createdBy?: number;
  }) {
    const where: any = {};
    const t = opts.target || {};
    if (t.subscriberIds?.length) where.id = { in: t.subscriberIds.map(Number) };
    if (t.status && t.status !== 'ALL') where.status = t.status;
    if (t.areaId) where.areaId = Number(t.areaId);
    if (t.packageId) where.packageId = Number(t.packageId);

    const subscribers = await this.prisma.subscriber.findMany({
      where,
      include: { package: true, serviceSettings: true },
      take: 10000,
    });

    let queued = 0;
    for (const sub of subscribers) {
      const recipient = opts.channel === 'SMS' ? sub.phone : sub.email;
      if (!recipient) continue;
      const vars = this.varsForSubscriber(sub);
      await this.send({
        channel: opts.channel,
        recipient,
        subject: opts.subject ? this.render(opts.subject, vars) : undefined,
        body: this.render(opts.body, vars),
        subscriberId: sub.id,
        event: 'NOTICE',
        createdBy: opts.createdBy,
      });
      queued++;
    }

    const audience = t.subscriberIds?.length
      ? `IDS:${t.subscriberIds.length}`
      : t.areaId
        ? `AREA:${t.areaId}`
        : t.packageId
          ? `PACKAGE:${t.packageId}`
          : t.status
            ? `STATUS:${t.status}`
            : 'ALL';
    await this.prisma.notice.create({
      data: {
        title: opts.title || opts.body.slice(0, 60),
        body: opts.body,
        channel: opts.channel,
        audience,
        sentCount: queued,
        createdBy: opts.createdBy,
      },
    });
    return { queued, matched: subscribers.length };
  }

  // ── Message log ───────────────────────────────────────────────
  async getMessages(query: any) {
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.channel) where.channel = query.channel;
    if (query?.event) where.event = query.event;
    if (query?.subscriberId) where.subscriberId = Number(query.subscriberId);
    const limit = Math.min(Number(query?.limit) || 50, 200);
    const cursor = Number(query?.cursor) || 0;
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor > 0 ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, hasMore };
  }

  async getLatestNotice(actor?: Actor) {
    const where: any = {};
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.OR = [{ createdBy: { in: ids } }, { createdBy: null }];
    }
    return this.prisma.notice.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async retryMessage(id: number) {
    await this.prisma.message.update({ where: { id }, data: { status: 'QUEUED', error: null } });
    await this.queue.add('send-message', { messageId: id });
    return { queued: true };
  }

  // ── Templates CRUD ────────────────────────────────────────────
  getTemplates() {
    return this.prisma.messageTemplate.findMany({ orderBy: { id: 'desc' } });
  }
  createTemplate(data: any) {
    return this.prisma.messageTemplate.create({
      data: {
        name: data.name,
        channel: data.channel === 'EMAIL' ? 'EMAIL' : 'SMS',
        subject: data.subject || null,
        body: data.body,
        event: data.event || 'MANUAL',
        isActive: data.isActive !== false,
      },
    });
  }
  updateTemplate(id: number, data: any) {
    return this.prisma.messageTemplate.update({
      where: { id },
      data: {
        name: data.name,
        channel: data.channel,
        subject: data.subject ?? null,
        body: data.body,
        event: data.event,
        isActive: data.isActive,
      },
    });
  }
  deleteTemplate(id: number) {
    return this.prisma.messageTemplate.delete({ where: { id } });
  }

  // ── Expiry reminder cron (09:00 daily) ────────────────────────
  @Cron('0 9 * * *')
  async cronExpiryReminders() {
    // CLUSTER GUARD — background work must run on ONE process only.
    // Without this the cron fired on every pm2 instance (11 web + 1 worker
    // = 12 concurrent runs of the same job), which duplicated side effects
    // and flooded the logs with identical rows.
    if (!isPrimaryInstance()) return;
    if ((process.env.BILLING_AUTOMATION || 'on').toLowerCase() === 'off') return;
    const reminderDays = (process.env.EXPIRY_REMINDER_DAYS || '3,1,0')
      .split(',')
      .map((d) => parseInt(d.trim()))
      .filter((d) => Number.isFinite(d) && d >= 0);

    for (const days of reminderDays) {
      const dayStart = new Date();
      dayStart.setDate(dayStart.getDate() + days);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const expiring = await this.prisma.subscriber.findMany({
        where: {
          status: 'ACTIVE',
          serviceSettings: { is: { expiryDate: { gte: dayStart, lte: dayEnd } } },
        },
        include: { package: true, serviceSettings: true },
      });
      for (const sub of expiring) {
        await this.fireEvent('EXPIRY_REMINDER', sub, { daysLeft: days });
      }
      if (expiring.length) this.logger.log(`Expiry reminders queued: ${expiring.length} (T-${days})`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DELIVERY (runs inside the queue worker)
  // ─────────────────────────────────────────────────────────────
  private async processMessage(messageId: number) {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.status === 'SENT') return;
    try {
      let status = 'SENT';
      if (msg.channel === 'SMS') status = await this.deliverSms(msg.recipient, msg.body);
      else status = await this.deliverEmail(msg.recipient, msg.subject || 'Notification', msg.body);
      await this.prisma.message.update({
        where: { id: messageId },
        data: { status, sentAt: new Date(), attempts: { increment: 1 }, error: null },
      });
    } catch (e: any) {
      await this.prisma.message.update({
        where: { id: messageId },
        data: { status: 'FAILED', error: e.message?.slice(0, 500), attempts: { increment: 1 } },
      });
      throw e; // let BullMQ retry
    }
  }

  private async deliverSms(phone: string, message: string): Promise<string> {
    const url = process.env.SMS_GATEWAY_URL;
    if (!url) {
      this.logger.log(`[SIMULATED SMS] → ${phone}: ${message.slice(0, 80)}`);
      return 'SIMULATED';
    }
    const method = (process.env.SMS_GATEWAY_METHOD || 'GET').toUpperCase();
    const finalUrl = url.replace('{phone}', encodeURIComponent(phone)).replace('{message}', encodeURIComponent(message));
    const init: any = { method };
    if (method === 'POST') {
      const bodyTpl = process.env.SMS_GATEWAY_BODY || '{"to":"{phone}","message":"{message}"}';
      init.body = bodyTpl.replace('{phone}', phone).replace('{message}', message.replace(/"/g, '\\"'));
      init.headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(finalUrl, init);
    if (!res.ok) throw new Error(`SMS gateway HTTP ${res.status}`);
    return 'SENT';
  }

  private async deliverEmail(to: string, subject: string, body: string): Promise<string> {
    if (!process.env.SMTP_HOST) {
      this.logger.log(`[SIMULATED EMAIL] → ${to}: ${subject}`);
      return 'SIMULATED';
    }
    if (!this.mailer) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodemailer = require('nodemailer');
      this.mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
    }
    await this.mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
    return 'SENT';
  }
}
