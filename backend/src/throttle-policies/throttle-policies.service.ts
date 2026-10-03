import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';

@Injectable()
export class ThrottlePoliciesService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  /**
   * ThrottlePolicy is installation-wide config (no owner column): one row
   * serves every company, so the policy itself is readable by any operator.
   * What hangs off it is NOT shared — the packages and subscribers attached
   * to a policy belong to individual companies, so counts and lists of those
   * are narrowed to the caller's own. The platform owner sees them all.
   */
  private async bindingScope(actor?: any): Promise<{ pkg: any; sub: any } | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    const [pkg, sub] = await Promise.all([
      this.scope.packageWhere(actor),
      this.scope.subscriberWhere(actor),
    ]);
    return { pkg, sub };
  }

  /** Attach/detach on a package changes it for everyone on it: the caller must own it. */
  private async assertPackageOwned(actor: any, packageId: number): Promise<void> {
    if (this.scope.isPlatformOwner(actor)) return;
    await this.scope.assertPackage(actor, packageId);
    const pkg = await this.prisma.package.findUnique({ where: { id: packageId }, select: { ownerId: true } });
    await this.scope.assertOwnerInScope(actor, pkg?.ownerId, `Package ${packageId}`);
  }

  /** Exists, and is a platform default or the caller's company's own. */
  private async assertPolicyExists(id: number, actor?: any): Promise<void> {
    const p = await this.prisma.throttlePolicy.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!p) throw new NotFoundException(`Policy ${id} not found`);
    if (actor) await this.scope.assertConfigReadable(actor, p, `Policy ${id}`);
  }

  // Policies: platform defaults plus each company's own. A company shapes its
  // own customers' speed without being able to touch anyone else's policy.
  async list(query: any, actor?: any) {
    const scoped = await this.bindingScope(actor);
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    const rows = await this.prisma.throttlePolicy.findMany({
      where: {
        AND: [
          own,
          query?.isActive ? { isActive: query.isActive === 'true' } : {},
          query?.q ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          } : {},
        ],
      },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: scoped
            ? {
                packages: { where: { package: scoped.pkg } },
                subscribers: { where: { subscriber: scoped.sub } },
              }
            : { packages: true, subscribers: true },
        },
      },
    });
    return rows.map((r: any) => ({ ...r, scope: r.ownerId == null ? 'PLATFORM' : 'COMPANY' }));
  }

  async options(actor?: any) {
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    return this.prisma.throttlePolicy.findMany({
      where: { isActive: true, ...own },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, mode: true, value: true, daysOfWeek: true, startTime: true, endTime: true },
    });
  }

  async get(id: number, actor?: any) {
    const scoped = await this.bindingScope(actor);
    const p = await this.prisma.throttlePolicy.findUnique({
      where: { id },
      include: {
        packages: {
          ...(scoped ? { where: { package: scoped.pkg } } : {}),
          include: { package: { select: { id: true, name: true, price: true } } },
        },
        subscribers: {
          ...(scoped ? { where: { subscriber: scoped.sub } } : {}),
          include: { subscriber: { select: { id: true, fullName: true, username: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException(`Policy ${id} not found`);
    if (actor) await this.scope.assertConfigReadable(actor, p, `Policy ${id}`);
    return p;
  }

  async create(body: any, actor: any) {
    // Platform owner: a platform default. A company administrator: the
    // company's own policy (ScopeService.configOwnerForCreate).
    const ownerId = await this.scope.configOwnerForCreate(actor);
    if (!body?.name) throw new BadRequestException('name is required');
    if (!body?.mode) throw new BadRequestException('mode is required (PERCENT | ABSOLUTE_KBPS | BURST_TO_KBPS)');
    return this.prisma.throttlePolicy.create({
      data: {
        ownerId,
        name: body.name,
        description: body.description ?? null,
        mode: body.mode,
        value: +body.value || 0,
        daysOfWeek: Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map((d: any) => +d) : [],
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        burstSeconds: +body.burstSeconds || 0,
        burstThreshold: +body.burstThreshold || 0,
        isActive: body.isActive !== false,
      },
    });
  }

  async update(id: number, body: any, actor: any) {
    const existing = await this.prisma.throttlePolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Policy ${id} not found`);
    await this.scope.assertConfigWritable(actor, existing, 'Policy');
    return this.prisma.throttlePolicy.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.value !== undefined ? { value: +body.value } : {}),
        ...(Array.isArray(body.daysOfWeek) ? { daysOfWeek: body.daysOfWeek.map((d: any) => +d) } : {}),
        ...(body.startTime !== undefined ? { startTime: body.startTime } : {}),
        ...(body.endTime !== undefined ? { endTime: body.endTime } : {}),
        ...(body.burstSeconds !== undefined ? { burstSeconds: +body.burstSeconds } : {}),
        ...(body.burstThreshold !== undefined ? { burstThreshold: +body.burstThreshold } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    });
  }

  async remove(id: number, actor: any) {
    const existing = await this.prisma.throttlePolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Policy ${id} not found`);
    await this.scope.assertConfigWritable(actor, existing, 'Policy');
    await this.prisma.throttlePolicy.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Package bindings ────────────────────────────────────────────────

  async attachToPackage(policyId: number, body: any, actor?: any) {
    if (!body?.packageId) throw new BadRequestException('packageId is required');
    if (actor) {
      await this.assertPackageOwned(actor, +body.packageId);
      await this.assertPolicyExists(policyId, actor);
    }
    return this.prisma.packageThrottlePolicy.upsert({
      where: { packageId_policyId: { packageId: +body.packageId, policyId } },
      update: {},
      create: { policyId, packageId: +body.packageId },
    });
  }

  async detachFromPackage(policyId: number, packageId: number, actor?: any) {
    if (actor) await this.assertPackageOwned(actor, packageId);
    await this.prisma.packageThrottlePolicy.delete({
      where: { packageId_policyId: { packageId, policyId } },
    });
    return { ok: true };
  }

  // ─── Subscriber overrides ───────────────────────────────────────────

  async attachToSubscriber(policyId: number, body: any, actor?: any) {
    if (!body?.subscriberId) throw new BadRequestException('subscriberId is required');
    if (actor) {
      await this.scope.assertSubscriberVisible(actor, +body.subscriberId);
      await this.assertPolicyExists(policyId, actor);
    }
    return this.prisma.subscriberThrottle.upsert({
      where: { subscriberId_policyId: { subscriberId: +body.subscriberId, policyId } },
      update: { isOverride: body.isOverride !== false },
      create: { policyId, subscriberId: +body.subscriberId, isOverride: body.isOverride !== false },
    });
  }

  async detachFromSubscriber(policyId: number, subscriberId: number, actor?: any) {
    if (actor) await this.scope.assertSubscriberVisible(actor, subscriberId);
    await this.prisma.subscriberThrottle.delete({
      where: { subscriberId_policyId: { subscriberId, policyId } },
    });
    return { ok: true };
  }

  /**
   * Compute the RADIUS reply attributes for a subscriber right now. Used by
   * the auth flow: when the subscriber authenticates, we look up the active
   * policies (from package + overrides) and write the relevant Mikrotik-Rate-Limit
   * (or equivalent) to radreply.
   */
  async computeActiveForSubscriber(subscriberId: number): Promise<{ attribute: string; value: string; op: string }[]> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: {
        package: true,
        throttlePolicies: { include: { policy: true } },
      },
    });
    if (!sub) return [];

    const now = new Date();
    const dow = now.getDay(); // 0..6
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const isActiveNow = (p: any): boolean => {
      if (!p.isActive) return false;
      if (p.daysOfWeek && p.daysOfWeek.length > 0 && !p.daysOfWeek.includes(dow)) return false;
      if (p.startTime && currentHHMM < p.startTime) return false;
      if (p.endTime && currentHHMM > p.endTime) return false;
      return true;
    };

    const inWindow: any[] = [];
    for (const sp of sub.throttlePolicies ?? []) {
      if (isActiveNow(sp.policy)) inWindow.push({ policy: sp.policy, isOverride: sp.isOverride });
    }
    // If no override, also consider package-level policies.
    if (!inWindow.some((x) => x.isOverride) && sub.packageId) {
      const pkgPolicies = await this.prisma.packageThrottlePolicy.findMany({
        where: { packageId: sub.packageId },
        include: { policy: true },
      });
      for (const pp of pkgPolicies) {
        if (isActiveNow(pp.policy)) inWindow.push({ policy: pp.policy, isOverride: false });
      }
    }

    const attrs: { attribute: string; value: string; op: string }[] = [];
    for (const { policy } of inWindow) {
      let rateDown: number, rateUp: number;
      const pkg = sub.package;
      if (policy.mode === 'PERCENT') {
        const pct = (policy.value || 0) / 100;
        rateDown = Math.floor((pkg?.downloadSpeed || 0) * pct);
        rateUp = Math.floor((pkg?.uploadSpeed || 0) * pct);
      } else if (policy.mode === 'ABSOLUTE_KBPS') {
        // Value is the total kbps; split 70/30 down/up.
        rateDown = Math.floor(policy.value * 0.7);
        rateUp = Math.floor(policy.value * 0.3);
      } else {
        // BURST_TO_KBPS: burst-then-throttle pattern.
        rateDown = Math.floor(policy.value);
        rateUp = Math.floor(policy.value / 2);
      }
      const fmt = `${rateDown}k/${rateUp}k`;
      attrs.push({ attribute: 'Mikrotik-Rate-Limit', value: fmt, op: ':=' });
    }
    return attrs;
  }
}
