import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { RadiusSyncService } from '../nas/radius-sync.service';
import { NetworkService } from '../network/network.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * FupService — Fair Usage Policy enforcement.
 *
 * Standard practice locally is to THROTTLE a customer who exceeds their data
 * allowance, not disconnect them. Throttling keeps them connected and billable
 * and avoids a support call; disconnecting turns a heavy user into a complaint
 * and often a cancellation.
 *
 * Usage is measured from RADIUS accounting over the customer's current billing
 * period, so it reflects what actually crossed the network rather than a
 * separate meter that can drift.
 *
 * Applying FUP rewrites Mikrotik-Rate-Limit and then issues a CoA disconnect —
 * the new speed only takes effect on the next session, so without the kick the
 * customer keeps full speed until they happen to reconnect.
 */
@Injectable()
export class FupService {
  private readonly logger = new Logger(FupService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private radiusSync: RadiusSyncService,
    private network: NetworkService,
    private notifications: NotificationsService,
  ) {}

  /** Bytes used in the current billing period, from RADIUS accounting. */
  private async usageBytes(username: string, since: Date): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(SUM(acctinputoctets),0)::bigint  AS up,
              COALESCE(SUM(acctoutputoctets),0)::bigint AS down
         FROM radacct
        WHERE username = $1 AND acctstarttime >= $2`,
      username,
      since,
    ).catch(() => [] as any[]);
    const up = Number(rows?.[0]?.up ?? 0);
    const down = Number(rows?.[0]?.down ?? 0);
    return up + down;
  }

  /**
   * Resolve the allowance in GB.
   *
   * ServiceSettings.quota is free text ("500", "500GB", "1 TB") because it was
   * typed by an operator, so it is parsed rather than trusted. A per-subscriber
   * value always wins over the package default — that is the whole point of
   * setting one.
   */
  /** System-wide default cap (GB) applied when nothing else is set. Off unless
   *  FUP_DEFAULT_QUOTA_GB is configured — set it to 1500 for a blanket cap. */
  private get defaultQuotaGb(): number | null {
    const n = parseFloat(process.env.FUP_DEFAULT_QUOTA_GB || '');
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  /** THROTTLE (reduce speed) or BLOCK (cut net entirely) when over quota. */
  private get mode(): 'THROTTLE' | 'BLOCK' {
    return String(process.env.FUP_MODE || 'THROTTLE').toUpperCase() === 'BLOCK' ? 'BLOCK' : 'THROTTLE';
  }

  /**
   * The BASE allowance: subscriber override → package quota → system default.
   * `null` means genuinely unlimited (no override, no package cap, no default).
   */
  private baseQuotaGb(settingsQuota?: string | null, packageQuota?: number | null): number | null {
    if (settingsQuota) {
      const raw = String(settingsQuota).trim();
      const num = parseFloat(raw.replace(/[^\d.]/g, ''));
      if (Number.isFinite(num) && num > 0) return /tb/i.test(raw) ? num * 1024 : num;
      // "unlimited"/"none"/gibberish → fall through.
    }
    if (packageQuota && packageQuota > 0) return packageQuota;
    return this.defaultQuotaGb;
  }

  /** Effective allowance for this cycle = base + any bonus GB granted. */
  private quotaGb(settingsQuota?: string | null, packageQuota?: number | null, bonusGb?: number | null): number | null {
    const base = this.baseQuotaGb(settingsQuota, packageQuota);
    if (base == null) return null;
    return base + (bonusGb && bonusGb > 0 ? bonusGb : 0);
  }

  /** Start of the customer's current cycle — falls back to 30 days. */
  private cycleStart(expiry?: Date | null, duration?: number | null): Date {
    if (expiry && duration) {
      const start = new Date(expiry);
      start.setDate(start.getDate() - duration);
      return start;
    }
    return new Date(Date.now() - 30 * 86400_000);
  }

  /** Live usage for one subscriber, with the quota position. */
  async usageFor(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: true, serviceSettings: true },
    });
    if (!sub?.username) return null;

    const bonusGb = (sub.serviceSettings as any)?.bonusQuotaGb ?? 0;
    const quotaGb = this.quotaGb(sub.serviceSettings?.quota, (sub.package as any)?.dataQuotaGb, bonusGb);

    const since = this.cycleStart(sub.serviceSettings?.expiryDate, sub.serviceSettings?.duration);
    const used = await this.usageBytes(sub.username, since);
    const usedGb = Math.round((used / 1024 ** 3) * 100) / 100;

    return {
      subscriberId,
      username: sub.username,
      cycleStart: since,
      usedGb,
      quotaGb,
      bonusGb,
      remainingGb: quotaGb ? Math.max(0, Math.round((quotaGb - usedGb) * 100) / 100) : null,
      percentUsed: quotaGb ? Math.round((usedGb / quotaGb) * 1000) / 10 : null,
      mode: this.mode,
      fupApplied: sub.fupApplied,
      // In BLOCK mode fupApplied means "net cut"; in THROTTLE it means "reduced speed".
      state: sub.fupApplied ? (this.mode === 'BLOCK' ? 'BLOCKED' : 'THROTTLED') : 'OK',
      throttledTo: sub.fupApplied && this.mode === 'THROTTLE' && (sub.package as any)?.fupDownloadSpeed
        ? `${(sub.package as any).fupDownloadSpeed}/${(sub.package as any).fupUploadSpeed} Mbps`
        : null,
    };
  }

  /**
   * Grant extra GB for the current cycle (a quota top-up). Lifts enforcement
   * immediately if the customer is now back under their (raised) cap.
   */
  async extendQuota(subscriberId: number, addGb: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);
    const gb = Number(addGb);
    if (!Number.isFinite(gb) || gb <= 0) throw new Error('Enter a positive number of GB to add.');

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId }, include: { serviceSettings: true },
    });
    if (!sub) throw new Error('Subscriber not found.');

    const current = (sub.serviceSettings as any)?.bonusQuotaGb ?? 0;
    await this.prisma.serviceSettings.upsert({
      where: { subscriberId },
      update: { bonusQuotaGb: current + gb },
      create: { subscriberId, bonusQuotaGb: gb },
    });

    // If they were cut/throttled but the extra GB puts them back under quota,
    // restore service right away.
    const after = await this.usageFor(subscriberId);
    if (sub.fupApplied && after && after.quotaGb && after.usedGb < after.quotaGb) {
      await this.release(subscriberId).catch(() => null);
    }
    return { subscriberId, addedGb: gb, bonusGb: current + gb, restored: !!sub.fupApplied };
  }

  /**
   * Hourly sweep. Only considers packages that actually define a quota AND a
   * reduced speed — without both, there is no policy to enforce and the
   * customer is left alone.
   */
  @Cron('15 * * * *')
  async enforce() {
    if (process.env.FUP_ENABLED === 'false') return;
    try {
      // In THROTTLE mode a reduced speed is required (nothing to slow to
      // otherwise). In BLOCK mode we cut net entirely, so no package speed is
      // needed — any active subscriber with a resolvable quota qualifies.
      const block = this.mode === 'BLOCK';
      const candidates = await this.prisma.subscriber.findMany({
        where: {
          status: 'ACTIVE',
          fupApplied: false,
          ...(block ? {} : { package: { is: { fupDownloadSpeed: { not: null } } } }),
        },
        include: { package: { include: { pool: true } }, serviceSettings: true },
        take: 500,
      });

      let acted = 0;
      for (const sub of candidates) {
        if (!sub.username) continue;
        const pkg: any = sub.package;
        const bonus = (sub.serviceSettings as any)?.bonusQuotaGb ?? 0;
        const quotaGb = this.quotaGb(sub.serviceSettings?.quota, pkg?.dataQuotaGb, bonus);
        if (!quotaGb) continue;

        const since = this.cycleStart(sub.serviceSettings?.expiryDate, sub.serviceSettings?.duration);
        const usedGb = (await this.usageBytes(sub.username, since)) / 1024 ** 3;
        if (usedGb < quotaGb) continue;

        if (block) await this.applyBlock(sub, usedGb, quotaGb);
        else await this.applyThrottle(sub, usedGb, quotaGb);
        acted++;
      }

      if (acted) this.logger.log(`FUP: ${block ? 'blocked' : 'throttled'} ${acted} subscriber(s) over quota`);
    } catch (e: any) {
      this.logger.warn(`FUP sweep failed: ${e?.message || e}`);
    }
  }

  /** Hard stop: remove from RADIUS and kick the live session. Used in BLOCK mode. */
  private async applyBlock(sub: any, usedGb: number, quotaGb: number) {
    try {
      await this.radiusSync.removeSubscriberFromRadius(sub.username).catch(() => null);
      await this.network.disconnect(sub.username).catch(() => null);
      await this.prisma.subscriber.update({
        where: { id: sub.id }, data: { fupApplied: true, fupAppliedAt: new Date() },
      });
      this.logger.log(`FUP BLOCK ${sub.username}: ${usedGb.toFixed(1)}/${quotaGb} GB → net cut`);
      if (sub.phone) {
        void this.notifications.send({
          channel: 'SMS', recipient: sub.phone, subscriberId: sub.id, event: 'FUP_BLOCK',
          body: `Dear customer, you have used your ${quotaGb} GB data limit and your internet is now stopped. Please top up your data or renew to continue.`,
        }).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`FUP block failed for ${sub.username}: ${e?.message || e}`);
    }
  }

  private async applyThrottle(sub: any, usedGb: number, quotaGb: number) {
    const pkg = sub.package;
    try {
      // Push the reduced speed, then kick the session so it takes effect now
      // rather than whenever the customer next reconnects.
      const subForOpts = await this.prisma.subscriber.findUnique({
        where: { id: sub.id },
        include: { serviceSettings: true },
      });
      const wantsStatic = subForOpts?.authMethod === 'STATIC' || subForOpts?.serviceSettings?.ipType === 'STATIC';
      const staticIp = wantsStatic ? subForOpts?.serviceSettings?.ipAddress ?? null : null;

      await this.radiusSync.syncSubscriberProfile(
        sub.username,
        sub.password,
        { ...pkg, downloadSpeed: pkg.fupDownloadSpeed, uploadSpeed: pkg.fupUploadSpeed },
        {
          serviceType: subForOpts?.authMethod as any,
          staticIp,
          macAddress: subForOpts?.serviceSettings?.macAddress ?? null,
          sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
          idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
        },
      );
      await this.network.disconnect(sub.username).catch(() => null);

      await this.prisma.subscriber.update({
        where: { id: sub.id },
        data: { fupApplied: true, fupAppliedAt: new Date() },
      });

      this.logger.log(
        `FUP applied to ${sub.username}: ${usedGb.toFixed(1)}/${quotaGb} GB → ` +
          `${pkg.fupDownloadSpeed}/${pkg.fupUploadSpeed} Mbps`,
      );

      // Telling them beats them discovering it and calling.
      if (sub.phone) {
        void this.notifications
          .send({
            channel: 'SMS',
            recipient: sub.phone,
            body:
              `Dear customer, you have used your ${quotaGb} GB allowance. ` +
              `Your speed is now ${pkg.fupDownloadSpeed} Mbps until your next renewal. ` +
              `Contact us to upgrade.`,
            subscriberId: sub.id,
            event: 'FUP',
          })
          .catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`FUP throttle failed for ${sub.username}: ${e?.message || e}`);
    }
  }

  /**
   * Restore full speed — called on renewal, or manually as a goodwill gesture.
   */
  async release(subscriberId: number, actor?: Actor) {
    if (actor) await this.scope.assertSubscriber(actor, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { 
        package: { include: { pool: true } },
        serviceSettings: true,
      },
    });
    if (!sub?.username) return { released: false };

    const wantsStatic = sub.authMethod === 'STATIC' || sub.serviceSettings?.ipType === 'STATIC';
    const staticIp = wantsStatic ? sub.serviceSettings?.ipAddress ?? null : null;

    await this.radiusSync.syncSubscriberProfile(
      sub.username, sub.password, sub.package as any,
      {
        serviceType: sub.authMethod as any,
        staticIp,
        macAddress: sub.serviceSettings?.macAddress ?? null,
        sessionTimeout: Number(process.env.HOTSPOT_SESSION_TIMEOUT || 0) || null,
        idleTimeout: Number(process.env.HOTSPOT_IDLE_TIMEOUT || 0) || null,
      },
    );
    await this.network.disconnect(sub.username).catch(() => null);

    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: { fupApplied: false, fupAppliedAt: null },
    });

    this.logger.log(`FUP released for ${sub.username} — full speed restored`);
    return { released: true, username: sub.username };
  }

  /** Everyone currently throttled, plus those approaching their limit. */
  async report(actor?: Actor) {
    const where: any = { status: 'ACTIVE' };
    if (actor && !this.scope.isAdmin(actor.role)) {
      where.userId = { in: await this.scope.descendantIds(await this.scope.rootId(actor)) };
    }

    const subs = await this.prisma.subscriber.findMany({
      where: {
        ...where,
        OR: [
          { package: { is: { dataQuotaGb: { not: null } } } },
          { serviceSettings: { is: { quota: { not: null } } } },
        ],
      },
      include: { package: true, serviceSettings: true },
      take: 300,
    });

    // One aggregate query for the whole page rather than one per subscriber.
    // Cycle starts differ per customer, so the oldest is used as the floor and
    // each row is filtered to its own window afterwards.
    const usernames = subs.map((s) => s.username).filter(Boolean) as string[];
    const usage = new Map<string, { start: Date; bytes: number }>();
    if (usernames.length) {
      const starts = subs.map((s) => this.cycleStart(s.serviceSettings?.expiryDate, s.serviceSettings?.duration));
      const floor = new Date(Math.min(...starts.map((d) => d.getTime())));
      const agg = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT username, acctstarttime,
                COALESCE(acctinputoctets,0)::bigint  AS up,
                COALESCE(acctoutputoctets,0)::bigint AS down
           FROM radacct
          WHERE username = ANY($1::text[]) AND acctstarttime >= $2`,
        usernames,
        floor,
      ).catch(() => [] as any[]);

      for (const s of subs) {
        if (!s.username) continue;
        usage.set(s.username, {
          start: this.cycleStart(s.serviceSettings?.expiryDate, s.serviceSettings?.duration),
          bytes: 0,
        });
      }
      for (const r of agg) {
        const entry = usage.get(r.username);
        if (!entry) continue;
        if (new Date(r.acctstarttime) < entry.start) continue;
        entry.bytes += Number(r.up) + Number(r.down);
      }
    }

    const rows: any[] = [];
    for (const s of subs) {
      if (!s.username) continue;
      const pkg: any = s.package;
      const quotaGb = this.quotaGb(s.serviceSettings?.quota, pkg?.dataQuotaGb);
      if (!quotaGb) continue;

      const usedGb = Math.round(((usage.get(s.username)?.bytes ?? 0) / 1024 ** 3) * 100) / 100;
      const pct = Math.round((usedGb / quotaGb) * 1000) / 10;

      // Only surface people who matter: near the limit or already past it.
      if (pct < 70 && !s.fupApplied) continue;

      rows.push({
        subscriberId: s.id,
        name: s.fullName,
        username: s.username,
        phone: s.phone,
        package: pkg?.name,
        quotaGb,
        usedGb,
        percentUsed: pct,
        fupApplied: s.fupApplied,
        throttledTo: s.fupApplied && pkg?.fupDownloadSpeed
          ? `${pkg.fupDownloadSpeed}/${pkg.fupUploadSpeed} Mbps` : null,
        // The commercial opportunity: heavy users are upgrade candidates.
        upsellCandidate: pct >= 100,
      });
    }

    return rows.sort((a, b) => b.percentUsed - a.percentUsed);
  }
}
