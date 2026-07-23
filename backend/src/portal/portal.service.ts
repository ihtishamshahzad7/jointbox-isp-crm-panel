import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { GatewayService } from '../gateway/gateway.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { VouchersService } from '../vouchers/vouchers.service';

/**
 * Phase 3 subscriber self-service portal API.
 * Separate JWT scope ('subscriber') — an admin token cannot be used here and vice versa.
 * Login is rate-limited: 5 attempts per username+IP per 10 minutes.
 */
@Injectable()
export class PortalService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cache: CacheService,
    private gateway: GatewayService,
    // Password changes must reach RADIUS, and vouchers are the main top-up path.
    private radiusSync: RadiusSyncService,
    private vouchers: VouchersService,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────
  async login(username: string, password: string, ip: string) {
    if (!username || !password) throw new BadRequestException('Username and password are required');

    const rlKey = `portal:rl:${username}:${ip}`;
    const attempts = (await this.cache.get<number>(rlKey)) || 0;
    if (attempts >= 5) throw new UnauthorizedException('Too many attempts — try again in 10 minutes');

    const sub = await this.prisma.subscriber.findUnique({
      where: { username },
      include: { package: true, serviceSettings: true },
    });
    if (!sub || sub.password !== password) {
      await this.cache.set(rlKey, attempts + 1, 600);
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.cache.del(rlKey);

    const token = this.jwt.sign({ sub: sub.id, username: sub.username, scope: 'subscriber' }, { expiresIn: '30d' });
    return { token, subscriber: this.publicProfile(sub) };
  }

  private publicProfile(sub: any) {
    return {
      id: sub.id,
      fullName: sub.fullName,
      username: sub.username,
      phone: sub.phone,
      email: sub.email,
      status: sub.status,
      balance: sub.balance,
      package: sub.package ? { name: sub.package.name, price: sub.package.price, downloadSpeed: sub.package.downloadSpeed, uploadSpeed: sub.package.uploadSpeed } : null,
      expiryDate: sub.serviceSettings?.expiryDate || null,
    };
  }

  // ── Data ──────────────────────────────────────────────────────
  async me(id: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      include: { package: true, serviceSettings: true },
    });
    if (!sub) throw new UnauthorizedException();
    return this.publicProfile(sub);
  }

  async usage(id: number) {
    const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { username: true } });
    if (!sub) throw new UnauthorizedException();
    const sessions = await this.prisma.radAcct.findMany({
      where: { username: sub.username },
      orderBy: { radacctid: 'desc' },
      take: 30,
      select: {
        acctstarttime: true,
        acctstoptime: true,
        acctsessiontime: true,
        acctinputoctets: true,
        acctoutputoctets: true,
        framedipaddress: true,
        callingstationid: true,
      },
    });
    const totals = sessions.reduce(
      (a, s) => ({
        download: a.download + Number(s.acctoutputoctets || 0),
        upload: a.upload + Number(s.acctinputoctets || 0),
        seconds: a.seconds + (s.acctsessiontime || 0),
      }),
      { download: 0, upload: 0, seconds: 0 },
    );
    const online = sessions.some((s) => !s.acctstoptime);
    return {
      online,
      totals,
      sessions: sessions.map((s) => ({
        start: s.acctstarttime,
        stop: s.acctstoptime,
        seconds: s.acctsessiontime,
        download: Number(s.acctoutputoctets || 0),
        upload: Number(s.acctinputoctets || 0),
        ip: s.framedipaddress,
        mac: s.callingstationid,
      })),
    };
  }

  async invoices(id: number) {
    return this.prisma.invoice.findMany({
      where: { subscriberId: id },
      orderBy: { id: 'desc' },
      take: 50,
      select: {
        id: true, invoiceNo: true, total: true, paidAmount: true, dueAmount: true,
        status: true, invoiceDate: true, dueDate: true, paidDate: true,
      },
    });
  }

  async payInvoice(subscriberId: number, invoiceId: number, gatewayName: string) {
    return this.gateway.initiate(invoiceId, gatewayName, subscriberId);
  }

  availableGateways() {
    return this.gateway.availableGateways();
  }

  // ── Tickets ───────────────────────────────────────────────────
  // ── Self-service: password, recharge, session history ─────────

  /**
   * Change the PPPoE password.
   *
   * This has to reach RADIUS too — changing it only in the CRM would lock the
   * customer out on their next reconnect, which is the worst possible outcome
   * for a self-service feature.
   */
  async changePassword(id: number, currentPassword: string, newPassword: string) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, username: true, password: true, packageId: true },
    });
    if (!sub) throw new UnauthorizedException('Account not found');
    if (sub.password !== currentPassword) {
      throw new BadRequestException('Your current password is incorrect.');
    }
    const pw = (newPassword || '').trim();
    if (pw.length < 6) {
      throw new BadRequestException('New password must be at least 6 characters.');
    }
    if (pw === currentPassword) {
      throw new BadRequestException('The new password must be different.');
    }

    await this.prisma.subscriber.update({ where: { id }, data: { password: pw } });

    // Push to RADIUS so the change applies on the next connection.
    try {
      const pkg = sub.packageId
        ? await this.prisma.package.findUnique({
            where: { id: sub.packageId },
            include: { pool: true },
          })
        : null;
      await this.radiusSync.syncSubscriberProfile(sub.username, pw, pkg as any);
    } catch {
      // Roll back rather than leave CRM and RADIUS disagreeing.
      await this.prisma.subscriber.update({
        where: { id },
        data: { password: currentPassword },
      });
      throw new BadRequestException(
        'Could not update the password on the network. Please try again or contact support.',
      );
    }

    return {
      changed: true,
      note: 'Password updated. Reconnect for it to take effect.',
    };
  }

  /**
   * Redeem a prepaid voucher into the wallet.
   *
   * The dominant top-up method for this market: the customer buys a scratch
   * card from a shop and enters the code, with no bank or card involved.
   * Credit lands in their wallet, and the nightly auto-renewal spends it.
   */
  async redeemVoucher(id: number, code: string, pin: string) {
    if (!code?.trim()) throw new BadRequestException('Voucher code is required.');
    try {
      const result = await this.vouchers.redeemVoucher(code.trim(), (pin || '').trim(), id);
      const sub = await this.prisma.subscriber.findUnique({
        where: { id },
        select: { balance: true },
      });
      return {
        redeemed: true,
        newBalance: sub?.balance ?? null,
        ...(typeof result === 'object' ? result : {}),
      };
    } catch (e: any) {
      // Voucher errors are user-facing — pass the real reason through.
      throw new BadRequestException(e?.message || 'This voucher could not be redeemed.');
    }
  }

  /** Recent connection history — "was I actually offline last night?". */
  async sessions(id: number, limit = 20) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { username: true },
    });
    if (!sub?.username) return [];

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT acctstarttime, acctstoptime, acctterminatecause,
              framedipaddress::text AS ip,
              acctinputoctets, acctoutputoctets,
              GREATEST(0, COALESCE(NULLIF(acctsessiontime,0),
                EXTRACT(EPOCH FROM (COALESCE(acctstoptime, NOW()) - acctstarttime))::int)) AS seconds
         FROM radacct WHERE username = $1
        ORDER BY radacctid DESC LIMIT $2`,
      sub.username,
      Math.min(Number(limit) || 20, 100),
    ).catch(() => [] as any[]);

    const REASON: Record<string, string> = {
      'User-Request': 'You disconnected',
      'Lost-Carrier': 'Cable or device disconnected',
      'Idle-Timeout': 'Idle timeout',
      'Session-Timeout': 'Session limit reached',
      'Admin-Reset': 'Disconnected by operator',
      'NAS-Reboot': 'Router restarted',
      'NAS-Request': 'Network closed the session',
    };

    return rows.map((r) => ({
      startedAt: r.acctstarttime,
      endedAt: r.acctstoptime,
      online: !r.acctstoptime,
      ipAddress: r.ip,
      durationSeconds: Number(r.seconds || 0),
      uploadBytes: Number(r.acctinputoctets || 0),
      downloadBytes: Number(r.acctoutputoctets || 0),
      // Plain language — a customer should never see "Lost-Carrier".
      reason: r.acctterminatecause
        ? REASON[r.acctterminatecause] || r.acctterminatecause
        : null,
    }));
  }

  async tickets(id: number) {
    return this.prisma.ticket.findMany({
      where: { subscriberId: id },
      orderBy: { id: 'desc' },
      take: 50,
      include: { messages: { orderBy: { id: 'asc' } } },
    });
  }

  async createTicket(id: number, data: { subject: string; description: string; category?: string }) {
    if (!data.subject?.trim() || !data.description?.trim()) {
      throw new BadRequestException('Subject and description are required');
    }
    const validCategories = ['TECHNICAL', 'BILLING', 'COMPLAINT', 'INSTALLATION', 'DISCONNECTION', 'OTHER'];
    const category = validCategories.includes((data.category || '').toUpperCase()) ? (data.category as any).toUpperCase() : 'TECHNICAL';
    return this.prisma.ticket.create({
      data: {
        ticketNo: `TKT-${Date.now()}`,
        subscriberId: id,
        subject: data.subject.trim(),
        description: data.description.trim(),
        category,
      },
    });
  }

  async replyTicket(subscriberId: number, ticketId: number, message: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket || ticket.subscriberId !== subscriberId) throw new BadRequestException('Ticket not found');
    return this.prisma.ticketMessage.create({
      data: { ticketId, message: message.trim(), sentBy: subscriberId, sentByType: 'SUBSCRIBER' },
    });
  }
}
