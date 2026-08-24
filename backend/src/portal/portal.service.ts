import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { GatewayService } from '../gateway/gateway.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { FupService } from '../compliance/fup.service';

/**
 * Phase 3 subscriber self-service portal API.
 * Separate JWT scope ('subscriber') — an admin token cannot be used here and vice versa.
 * Login is rate-limited: 5 attempts per username+IP per 10 minutes.
 *
 * Phase 3.5: Self-activation.
 * A new subscriber can pick a package, register, pay via gateway, and get
 * auto-activated — no operator involvement. This is the key gap vs Zal Ultra.
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cache: CacheService,
    private gateway: GatewayService,
    // Password changes must reach RADIUS, and vouchers are the main top-up path.
    private radiusSync: RadiusSyncService,
    private vouchers: VouchersService,
    private fup: FupService,
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
    // Data-cap / FUP status so the customer can see their allowance and how
    // much is left this cycle. Null when the plan has no cap. Never fatal.
    let quota: any = null;
    try { quota = await this.fup.usageFor(id); } catch { quota = null; }
    return {
      online,
      quota,
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
      const subForOpts = await this.prisma.subscriber.findUnique({
        where: { id: sub.id },
        include: { serviceSettings: true },
      });
      const wantsStatic = subForOpts?.authMethod === 'STATIC' || subForOpts?.serviceSettings?.ipType === 'STATIC';
      const staticIp = wantsStatic ? subForOpts?.serviceSettings?.ipAddress ?? null : null;
      const pkg = sub.packageId
        ? await this.prisma.package.findUnique({
            where: { id: sub.packageId },
            include: { pool: true },
          })
        : null;
      await this.radiusSync.syncSubscriberProfile(
        sub.username,
        pw,
        pkg as any,
        {
          serviceType: subForOpts?.authMethod as any,
          staticIp,
          macAddress: subForOpts?.serviceSettings?.macAddress ?? null,
          sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
          idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
        },
      );
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

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT acctstarttime, acctstoptime, acctterminatecause,
              framedipaddress::text AS ip,
              acctinputoctets, acctoutputoctets,
              GREATEST(0, COALESCE(NULLIF(acctsessiontime,0),
                EXTRACT(EPOCH FROM (COALESCE(acctstoptime, NOW()) - acctstarttime))::int)) AS seconds
         FROM radacct WHERE username = ${sub.username}
        ORDER BY radacctid DESC LIMIT ${Math.min(Number(limit) || 20, 100)}`
    .catch(() => [] as any[]);

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

  // ─────────────────────────────────────────────────────────────
  // SELF-ACTIVATION
  // ─────────────────────────────────────────────────────────────

  /** List packages that are active and marked for self-activation. */
  async availablePackages() {
    const packages = await this.prisma.package.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, price: true, description: true,
        downloadSpeed: true, uploadSpeed: true, duration: true,
        dataQuotaGb: true, poolId: true,
      },
      orderBy: { price: 'asc' },
    });

    // Only show packages where self-activation is explicitly enabled.
    // Packages with no settings row are skipped, not defaulted on.
    const store = await this.packageSettingsById();
    return packages.filter((p) => store[p.id]?.selfActivation === true);
  }

  /**
   * Register a new subscriber for self-activation.
   *
   * Flow:
   * 1. Validate inputs (phone / email uniqueness, package availability)
   * 2. Generate a RADIUS username from the phone number
   * 3. Create the subscriber + ServiceSettings
   * 4. Generate the first invoice (pro-rated for the remaining days)
   * 5. Return a JWT so the subscriber can proceed straight to payment
   */
  async selfRegister(body: {
    fullName: string; phone: string; email?: string; password: string;
    packageId: number; address?: string;
  }, ip: string) {
    const { fullName, phone, password, packageId, email, address } = body;

    // Validate
    if (!fullName?.trim()) throw new BadRequestException('Full name is required');
    if (!phone?.trim()) throw new BadRequestException('Phone number is required');
    if (!password || password.length < 6) throw new BadRequestException('Password must be at least 6 characters');

    const pkg = await this.prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg || !pkg.isActive) throw new BadRequestException('Package not found or inactive');

    // Check self-activation is enabled for this package
    const store = await this.packageSettingsById();
    if (!store[pkg.id]?.selfActivation) {
      throw new BadRequestException('This package is not available for self-activation');
    }

    // Check phone uniqueness
    const existing = await this.prisma.subscriber.findFirst({
      where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
    });
    if (existing) {
      const field = existing.phone === phone ? 'Phone number' : 'Email';
      throw new BadRequestException(`${field} is already registered`);
    }

    // Generate a clean username: phone number prefixed
    const username = phone.replace(/[^0-9]/g, '').replace(/^(\+?92|0)/, '92');

    // Find an admin user to assign ownership (first SUPER_ADMIN)
    const admin = await this.prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    // Create the subscriber
    const sub = await this.prisma.subscriber.create({
      data: {
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email?.trim() || null,
        username,
        password,
        address: address?.trim() || null,
        packageId: pkg.id,
        userId: admin?.id || null,
        status: 'INACTIVE',
        sellPrice: pkg.price,
        costPrice: pkg.price,
        profit: 0,
      },
    });

    // Create ServiceSettings with a short initial expiry (1 day grace for payment)
    const initialExpiry = new Date();
    initialExpiry.setDate(initialExpiry.getDate() + 1); // 1 day to pay
    await this.prisma.serviceSettings.create({
      data: {
        subscriberId: sub.id,
        expiryDate: initialExpiry,
        duration: pkg.duration || 30,
      },
    });

    // Create the activation invoice
    const invoiceNo = `ACT-${Date.now()}-${sub.id}`;
    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNo,
        subscriberId: sub.id,
        subscriberName: sub.fullName,
        amount: pkg.price,
        total: pkg.price,
        dueAmount: pkg.price,
        dueDate: initialExpiry,
        status: 'UNPAID',
        notes: 'Self-activation invoice',
        items: {
          create: [{
            description: `Activation - ${pkg.name} (${pkg.downloadSpeed}M/${pkg.uploadSpeed}M)`,
            quantity: 1,
            unitPrice: pkg.price,
            total: pkg.price,
          }],
        },
      },
    });

    // Issue a JWT so the subscriber can pay immediately
    const token = this.jwt.sign(
      { sub: sub.id, username: sub.username, scope: 'subscriber' },
      { expiresIn: '7d' },
    );

    this.logger.log(`Self-registration: #${sub.id} ${username} package #${pkg.id} invoice #${invoice.id}`);

    return {
      token,
      subscriber: {
        id: sub.id,
        fullName: sub.fullName,
        username: sub.username,
        phone: sub.phone,
        status: sub.status,
        package: {
          name: pkg.name,
          price: pkg.price,
          downloadSpeed: pkg.downloadSpeed,
          uploadSpeed: pkg.uploadSpeed,
        },
      },
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        amount: invoice.total,
        dueDate: invoice.dueDate,
      },
    };
  }

  /**
   * Initiate the payment for a self-activation.
   *
   * Called after registration — the subscriber has an unpaid activation
   * invoice and a JWT. This picks up that invoice and creates a gateway
   * transaction, returning the payment URL to redirect the subscriber to.
   */
  async selfActivate(subscriberId: number, gatewayName: string) {
    // Find the unpaid activation invoice
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        subscriberId,
        status: 'UNPAID',
        invoiceNo: { startsWith: 'ACT-' },
      },
      orderBy: { id: 'desc' },
    });
    if (!invoice) {
      throw new BadRequestException('No pending activation invoice found. Already activated?');
    }

    // Initiate payment
    const result = await this.gateway.initiate(invoice.id, gatewayName, subscriberId);
    return result;
  }

  /** Check if the subscriber is fully activated and their service status. */
  async activationStatus(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: {
        package: { select: { name: true, downloadSpeed: true, uploadSpeed: true } },
        serviceSettings: { select: { expiryDate: true } },
      },
    });
    if (!sub) throw new UnauthorizedException();

    const pendingInvoice = await this.prisma.invoice.findFirst({
      where: {
        subscriberId,
        status: 'UNPAID',
        invoiceNo: { startsWith: 'ACT-' },
      },
      orderBy: { id: 'desc' },
    });

    return {
      id: sub.id,
      fullName: sub.fullName,
      status: sub.status,
      isActive: sub.status === 'ACTIVE',
      hasPendingPayment: !!pendingInvoice,
      pendingAmount: pendingInvoice?.dueAmount || 0,
      package: sub.package ? {
        name: sub.package.name,
        downloadSpeed: sub.package.downloadSpeed,
        uploadSpeed: sub.package.uploadSpeed,
      } : null,
      expiryDate: sub.serviceSettings?.expiryDate || null,
    };
  }

  /**
   * Per-package settings, keyed by package id — currently only the
   * self-activation flag is read here.
   *
   * TWO BUGS WERE FIXED WHEN THIS MOVED OFF THE JSON FILE.
   *
   * The previous version parsed data/packages-management.json and returned the
   * whole document, then callers indexed it as `store[packageId]`. But the
   * document's top level is `{ packageSettings, taxes, policies, allocations }`
   * — there is no key that is a package id. So the lookup was always undefined,
   * which means `getSelfActivationPackages()` always returned an empty list and
   * `register()` rejected every package as "not available for self-activation",
   * no matter how it was configured in the panel. Self-activation had never
   * actually worked.
   *
   * Second, the settings lived in a file that no backup captured and any deploy
   * could replace.
   *
   * Reading the real table fixes both: the flag an operator sets in the panel is
   * now the flag the portal honours.
   */
  private async packageSettingsById(): Promise<Record<number, { selfActivation?: boolean }>> {
    try {
      const rows = await this.prisma.packageSetting.findMany();
      const out: Record<number, any> = {};
      for (const r of rows) out[r.packageId] = (r.settings as any) ?? {};
      return out;
    } catch {
      // Fail closed: if settings cannot be read we show nothing rather than
      // opening self-activation on every package.
      return {};
    }
  }
}
