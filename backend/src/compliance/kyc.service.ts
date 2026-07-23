import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * KycService — identity verification for connections.
 *
 * WHY
 * PTA licence conditions require a verified identity behind every connection.
 * Beyond compliance, duplicate CNICs are the usual signature of resale fraud —
 * one person taking several connections and reselling bandwidth — and expired
 * CNICs mean your subscriber register no longer matches reality.
 *
 * The panel already captures CNIC images. What was missing was the *process*:
 * a number to match on, duplicate detection, expiry tracking, and a record of
 * who verified what and when.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Strip formatting so duplicates can't hide behind punctuation.
   * 35201-1234567-1 and 3520112345671 are the same person.
   */
  normalise(cnic?: string | null): string | null {
    if (!cnic) return null;
    const digits = String(cnic).replace(/\D/g, '');
    return digits.length ? digits : null;
  }

  /** Pakistani CNIC is 13 digits: 5 (district) + 7 (serial) + 1 (gender). */
  validate(cnic?: string | null): { valid: boolean; reason?: string; formatted?: string } {
    const n = this.normalise(cnic);
    if (!n) return { valid: false, reason: 'CNIC is required.' };
    if (n.length !== 13) {
      return { valid: false, reason: `CNIC must be 13 digits — got ${n.length}.` };
    }
    // First digit is the province/region code; 0 is never valid.
    if (n[0] === '0') return { valid: false, reason: 'CNIC cannot start with 0.' };
    return {
      valid: true,
      formatted: `${n.slice(0, 5)}-${n.slice(5, 12)}-${n.slice(12)}`,
    };
  }

  /**
   * Record or update a subscriber's CNIC.
   * Rejects an invalid number outright and reports any other connection already
   * using it — legitimate cases exist (a family, a business), so this warns
   * rather than blocks.
   */
  async setCnic(
    subscriberId: number,
    data: { cnicNumber: string; cnicExpiry?: string },
    actor?: Actor,
  ) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const check = this.validate(data.cnicNumber);
    if (!check.valid) throw new BadRequestException(check.reason);
    const n = this.normalise(data.cnicNumber)!;

    const duplicates = await this.prisma.subscriber.findMany({
      where: { cnicNumber: n, id: { not: subscriberId } },
      select: { id: true, fullName: true, username: true, status: true },
    });

    const expiry = data.cnicExpiry ? new Date(data.cnicExpiry) : null;
    const expired = expiry ? expiry < new Date() : false;

    const updated = await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        cnicNumber: n,
        cnicExpiry: expiry,
        // Changing the number invalidates any previous verification.
        kycStatus: expired ? 'EXPIRED' : 'PENDING',
        kycVerifiedBy: null,
        kycVerifiedAt: null,
      },
      select: { id: true, fullName: true, cnicNumber: true, cnicExpiry: true, kycStatus: true },
    });

    return {
      ...updated,
      formatted: check.formatted,
      duplicates,
      warning: duplicates.length
        ? `This CNIC is already on ${duplicates.length} other connection(s). Verify this is a genuine family or business account.`
        : null,
    };
  }

  async verify(subscriberId: number, approved: boolean, notes?: string, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { cnicNumber: true, cnicFrontUrl: true, cnicBackUrl: true, cnicExpiry: true },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');

    if (approved) {
      // Don't allow verifying an incomplete record — that defeats the purpose.
      if (!sub.cnicNumber) throw new BadRequestException('Record the CNIC number before verifying.');
      if (!sub.cnicFrontUrl || !sub.cnicBackUrl) {
        throw new BadRequestException('Both sides of the CNIC must be uploaded before verifying.');
      }
      if (sub.cnicExpiry && sub.cnicExpiry < new Date()) {
        throw new BadRequestException('This CNIC has expired — obtain a current one.');
      }
    }

    return this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        kycStatus: approved ? 'VERIFIED' : 'REJECTED',
        kycVerifiedBy: actor ? this.scope.actorId(actor) : null,
        kycVerifiedAt: new Date(),
        kycNotes: notes ?? null,
      },
      select: { id: true, fullName: true, kycStatus: true, kycVerifiedAt: true },
    });
  }

  /** Compliance dashboard: what still needs attention. */
  async stats(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    const soon = new Date(Date.now() + 60 * 86400_000);

    const [byStatus, missingNumber, missingDocs, expiringSoon, total] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['kycStatus'], where, _count: { _all: true } }),
      this.prisma.subscriber.count({ where: { ...where, cnicNumber: null } }),
      this.prisma.subscriber.count({
        where: { ...where, OR: [{ cnicFrontUrl: null }, { cnicBackUrl: null }] },
      }),
      this.prisma.subscriber.count({
        where: { ...where, cnicExpiry: { gte: new Date(), lte: soon } },
      }),
      this.prisma.subscriber.count({ where }),
    ]);

    const m: Record<string, number> = {};
    byStatus.forEach((s) => (m[s.kycStatus] = s._count._all));
    const verified = m.VERIFIED ?? 0;

    return {
      total,
      verified,
      pending: m.PENDING ?? 0,
      rejected: m.REJECTED ?? 0,
      expired: m.EXPIRED ?? 0,
      missingCnicNumber: missingNumber,
      missingDocuments: missingDocs,
      expiringIn60Days: expiringSoon,
      compliancePercent: total > 0 ? Math.round((verified / total) * 1000) / 10 : 100,
    };
  }

  /** The work queue — who needs checking, worst first. */
  async queue(actor?: Actor, filter = 'ALL') {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    if (filter === 'PENDING') where.kycStatus = 'PENDING';
    if (filter === 'EXPIRED') where.kycStatus = 'EXPIRED';
    if (filter === 'REJECTED') where.kycStatus = 'REJECTED';
    if (filter === 'MISSING') where.OR = [{ cnicNumber: null }, { cnicFrontUrl: null }, { cnicBackUrl: null }];

    const rows = await this.prisma.subscriber.findMany({
      where,
      select: {
        id: true, fullName: true, username: true, phone: true, status: true,
        cnicNumber: true, cnicExpiry: true, cnicFrontUrl: true, cnicBackUrl: true,
        kycStatus: true, kycVerifiedAt: true, kycNotes: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return rows.map((r) => ({
      ...r,
      formattedCnic: r.cnicNumber
        ? `${r.cnicNumber.slice(0, 5)}-${r.cnicNumber.slice(5, 12)}-${r.cnicNumber.slice(12)}`
        : null,
      hasDocuments: !!(r.cnicFrontUrl && r.cnicBackUrl),
      daysToExpiry: r.cnicExpiry
        ? Math.ceil((new Date(r.cnicExpiry).getTime() - Date.now()) / 86400_000)
        : null,
    }));
  }

  /**
   * Every connection sharing a CNIC.
   *
   * Some are legitimate — a household, a business with several lines. The point
   * is to make them visible and deliberate rather than accidental, because an
   * unexplained cluster is usually resale.
   */
  async duplicates(actor?: Actor) {
    const scopeIds = actor && !this.scope.isAdmin(actor.role)
      ? await this.scope.descendantIds(await this.scope.rootId(actor))
      : null;

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT "cnicNumber", COUNT(*)::int AS n
         FROM "Subscriber"
        WHERE "cnicNumber" IS NOT NULL
          ${scopeIds ? `AND "userId" = ANY($1::int[])` : ''}
        GROUP BY "cnicNumber"
       HAVING COUNT(*) > 1
        ORDER BY n DESC LIMIT 100`,
      ...(scopeIds ? [scopeIds] : []),
    ).catch(() => [] as any[]);

    const out: any[] = [];
    for (const r of rows) {
      const subs = await this.prisma.subscriber.findMany({
        where: { cnicNumber: r.cnicNumber },
        select: { id: true, fullName: true, username: true, phone: true, status: true, kycStatus: true },
      });
      out.push({
        cnicNumber: r.cnicNumber,
        formatted: `${r.cnicNumber.slice(0, 5)}-${r.cnicNumber.slice(5, 12)}-${r.cnicNumber.slice(12)}`,
        count: Number(r.n),
        subscribers: subs,
      });
    }
    return out;
  }

  /**
   * Daily: move CNICs past their expiry date into EXPIRED so the register
   * reflects reality rather than a verification done two years ago.
   */
  @Cron('0 5 * * *')
  async expirySweep() {
    try {
      const res = await this.prisma.subscriber.updateMany({
        where: { cnicExpiry: { lt: new Date() }, kycStatus: { in: ['VERIFIED', 'PENDING'] } },
        data: { kycStatus: 'EXPIRED' },
      });
      if (res.count) {
        this.logger.warn(`${res.count} subscriber(s) now have an expired CNIC — re-verification needed`);
      }
      return { expired: res.count };
    } catch (e: any) {
      this.logger.warn(`KYC expiry sweep failed: ${e?.message || e}`);
    }
  }

  /**
   * PTA-style subscriber register export.
   * When a regulator asks, this is produced in minutes rather than days.
   */
  async register(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }
    const rows = await this.prisma.subscriber.findMany({
      where,
      select: {
        id: true, fullName: true, cnicNumber: true, phone: true, email: true,
        address: true, username: true, status: true, kycStatus: true,
        installationDate: true, createdAt: true,
        area: { select: { name: true, city: true } },
        package: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((r) => ({
      subscriberId: r.id,
      name: r.fullName,
      cnic: r.cnicNumber
        ? `${r.cnicNumber.slice(0, 5)}-${r.cnicNumber.slice(5, 12)}-${r.cnicNumber.slice(12)}`
        : '',
      phone: r.phone,
      email: r.email ?? '',
      address: r.address ?? '',
      area: r.area?.name ?? '',
      city: r.area?.city ?? '',
      username: r.username,
      package: r.package?.name ?? '',
      connectionStatus: r.status,
      verification: r.kycStatus,
      activatedOn: r.installationDate ?? r.createdAt,
    }));
  }
}
