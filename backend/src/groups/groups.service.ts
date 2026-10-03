import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';

/**
 * Access Groups
 *
 * Three access modes per resource (NAS or Package):
 *
 *   GLOBAL    — no rows in `access_group_nas` / `access_group_package`.
 *               Visible to everyone. Default.
 *
 *   PERSONAL  — owner only (the existing `ownerId` field already does this;
 *               groups aren't needed).
 *
 *   GROUPED   — at least one row in the link table. The resource is then
 *               visible to any user who is a member of one of those groups
 *               (or, if propagate=true on the membership, to a member's
 *               downline).
 *
 * The visibility filter for an actor is the OR of:
 *   (1) I am the owner, OR
 *   (2) any of my groups contains the resource, with my membership being
 *       direct OR inherited from a member-with-propagate down the line.
 *
 * ISP / SUPER_ADMIN see everything regardless of group.
 */
@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  // ────────────────────────────────────────────────────────────────────
  // GROUPS CRUD
  // ────────────────────────────────────────────────────────────────────

  async listGroups(query: any, actor: any) {
    const q = (query?.q || '').trim().toLowerCase();
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    const rows = await this.prisma.accessGroup.findMany({
      where: {
        AND: [
          own,
          q ? { OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ] } : {},
          query?.isActive ? { isActive: query.isActive === 'true' } : {},
        ],
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true, nasResources: true, pkgResources: true } } },
    });
    if (!actor || this.scope.isPlatformOwner(actor)) return rows;
    // Counts are installation-wide; a company sees its own share only.
    const [uw, nw, pw] = await Promise.all([
      this.scope.userWhere(actor), this.scope.nasWhere(actor), this.scope.packageWhere(actor),
    ]);
    return Promise.all(rows.map(async (g: any) => {
      const [members, nasResources, pkgResources] = await Promise.all([
        this.prisma.accessGroupMember.count({ where: { groupId: g.id, user: uw } as any }),
        this.prisma.accessGroupNas.count({ where: { groupId: g.id, nas: nw } as any }),
        this.prisma.accessGroupPackage.count({ where: { groupId: g.id, package: pw } as any }),
      ]);
      return { ...g, _count: { members, nasResources, pkgResources } };
    }));
  }

  async listOptions(actor?: any) {
    const own = actor ? await this.scope.configReadWhere(actor) : {};
    return this.prisma.accessGroup.findMany({
      where: { AND: [{ isActive: true }, own] },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true, propagate: true },
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // TENANCY
  // ────────────────────────────────────────────────────────────────────
  //
  // Each COMPANY owns its groups (ownerId = the company's top account). Its
  // administrator creates and edits them; members must be its own accounts,
  // and only its own routers / packages can be bound. Rows from before
  // ownership (ownerId NULL) stay readable but cannot be changed by a company.
  // Reads are cut down to what the caller can already see, so walking group
  // ids never lists another company's accounts or routers.

  private async memberFilter(actor?: any): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return { user: { is: await this.scope.userWhere(actor) } };
  }

  private async nasFilter(actor?: any): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return { nas: { is: await this.scope.nasWhere(actor) } };
  }

  private async packageFilter(actor?: any): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return { package: { is: await this.scope.packageWhere(actor) } };
  }

  async getGroup(id: number, actor?: any) {
    const [member, nas, pkg] = await Promise.all([
      this.memberFilter(actor), this.nasFilter(actor), this.packageFilter(actor),
    ]);
    if (actor) {
      const row = await this.prisma.accessGroup.findUnique({ where: { id }, select: { ownerId: true } });
      await this.scope.assertConfigReadable(actor, row, `Group ${id}`);
    }
    const group = await this.prisma.accessGroup.findUnique({
      where: { id },
      include: {
        members: {
          ...(member ? { where: member } : {}),
          include: {
            user: { select: { id: true, name: true, email: true, role: true, parentId: true } },
          },
        },
        nasResources: {
          ...(nas ? { where: nas } : {}),
          include: { nas: { select: { id: true, nasname: true, shortname: true, isActive: true } } },
        },
        pkgResources: {
          ...(pkg ? { where: pkg } : {}),
          include: { package: { select: { id: true, name: true, price: true, isActive: true } } },
        },
      },
    });
    if (!group) throw new NotFoundException(`Group ${id} not found`);
    return group;
  }

  /** The caller's company administrator, on a group that company owns. */
  private async assertGroupWritable(actor: any, id: number) {
    if (!actor) return;
    const row = await this.prisma.accessGroup.findUnique({ where: { id }, select: { ownerId: true } });
    await this.scope.assertConfigWritable(actor, row, `Group ${id}`);
  }

  async createGroup(body: any, actor: any) {
    const ownerId = actor ? await this.scope.configOwnerForCreate(actor) : null;
    if (!body?.name) throw new BadRequestException('name is required');
    const exists = await this.prisma.accessGroup.findFirst({ where: { ownerId, name: body.name } });
    if (exists) throw new BadRequestException(`Group "${body.name}" already exists`);
    return this.prisma.accessGroup.create({
      data: {
        ownerId,
        name: body.name,
        description: body.description ?? null,
        color: body.color ?? null,
        propagate: body.propagate ?? true,
        isActive: body.isActive ?? true,
      },
    });
  }

  async updateGroup(id: number, body: any, actor: any) {
    await this.assertGroupWritable(actor, id);
    const existing = await this.prisma.accessGroup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Group ${id} not found`);
    return this.prisma.accessGroup.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(typeof body.propagate === 'boolean' ? { propagate: body.propagate } : {}),
        ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
      },
    });
  }

  async removeGroup(id: number, actor: any) {
    await this.assertGroupWritable(actor, id);
    const existing = await this.prisma.accessGroup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Group ${id} not found`);
    // Cascade: members, nas bindings, package bindings all clear automatically.
    await this.prisma.accessGroup.delete({ where: { id } });
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────────
  // MEMBERS
  // ────────────────────────────────────────────────────────────────────

  async listMembers(groupId: number, actor?: any) {
    const member = await this.memberFilter(actor);
    return this.prisma.accessGroupMember.findMany({
      where: member ? { AND: [{ groupId }, member] } : { groupId },
      include: { user: { select: { id: true, name: true, email: true, role: true, parentId: true, isActive: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async addMember(groupId: number, body: any, actor: any) {
    if (!body?.userId) throw new BadRequestException('userId is required');
    await this.assertGroupWritable(actor, groupId);
    // Members are the company's own accounts — never another company's.
    if (actor) await this.scope.assertUser(actor, +body.userId);
    return this.prisma.accessGroupMember.upsert({
      where: { groupId_userId: { groupId, userId: +body.userId } },
      update: { propagate: body.propagate ?? false },
      create: { groupId, userId: +body.userId, propagate: body.propagate ?? false },
    });
  }

  async updateMember(groupId: number, userId: number, body: any, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    return this.prisma.accessGroupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { propagate: body.propagate ?? false },
    });
  }

  async removeMember(groupId: number, userId: number, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    await this.prisma.accessGroupMember.delete({
      where: { groupId_userId: { groupId, userId } },
    });
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────────
  // RESOURCE BINDINGS
  // ────────────────────────────────────────────────────────────────────

  async listNasInGroup(groupId: number, actor?: any) {
    const nas = await this.nasFilter(actor);
    return this.prisma.accessGroupNas.findMany({
      where: nas ? { AND: [{ groupId }, nas] } : { groupId },
      include: { nas: { select: { id: true, nasname: true, shortname: true, isActive: true, nasIp: true } } },
    });
  }

  async bindNas(groupId: number, body: any, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    if (!body?.nasId) throw new BadRequestException('nasId is required');
    if (actor) await this.scope.assertNas(actor, +body.nasId);
    return this.prisma.accessGroupNas.upsert({
      where: { groupId_nasId: { groupId, nasId: +body.nasId } },
      update: {},
      create: { groupId, nasId: +body.nasId },
    });
  }

  async unbindNas(groupId: number, nasId: number, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    await this.prisma.accessGroupNas.delete({
      where: { groupId_nasId: { groupId, nasId } },
    });
    return { ok: true };
  }

  async listPackagesInGroup(groupId: number, actor?: any) {
    const pkg = await this.packageFilter(actor);
    return this.prisma.accessGroupPackage.findMany({
      where: pkg ? { AND: [{ groupId }, pkg] } : { groupId },
      include: { package: { select: { id: true, name: true, price: true, isActive: true } } },
    });
  }

  async bindPackage(groupId: number, body: any, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    if (!body?.packageId) throw new BadRequestException('packageId is required');
    if (actor) await this.scope.assertPackage(actor, +body.packageId);
    return this.prisma.accessGroupPackage.upsert({
      where: { groupId_packageId: { groupId, packageId: +body.packageId } },
      update: {},
      create: { groupId, packageId: +body.packageId },
    });
  }

  async unbindPackage(groupId: number, packageId: number, actor: any) {
    await this.assertGroupWritable(actor, groupId);
    await this.prisma.accessGroupPackage.delete({
      where: { groupId_packageId: { groupId, packageId } },
    });
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────────
  // VISIBILITY — used by other modules to filter their queries
  // ────────────────────────────────────────────────────────────────────

  /**
   * The set of NAS ids the actor is allowed to see.
   *
   * Rules:
   *   • SUPER_ADMIN sees everything (returns null = "no filter").
   *   • Otherwise: NAS that are GLOBAL (no AccessGroupNas rows) OR are in a
   *     group the actor (or, with propagate, a member of the actor's ancestor
   *     chain) belongs to.
   *
   * The "owner" check is layered on top by the calling service (a NAS owned
   * by someone else is still visible if it is GLOBAL or in a shared group).
   */
  async visibleNasFor(actor: any): Promise<{ ids: number[] | 'ALL'; globalCount: number; groupedCount: number }> {
    if (this.scope.isAdmin(actor?.role)) return { ids: 'ALL', globalCount: 0, groupedCount: 0 };
    const userId = Number(actor?.sub ?? actor?.id);
    if (!userId) return { ids: [], globalCount: 0, groupedCount: 0 };

    // 1. NAS that are explicitly grouped AND the actor (or a propagating
    //    ancestor of the actor) is a member of the matching group.
    const directGroups = await this.prisma.accessGroupMember.findMany({
      where: { userId },
      select: { groupId: true, propagate: true },
    });
    const directGroupIds = directGroups.map((g) => g.groupId);

    // Ancestors of the actor (excluding self) — these propagate if the
    // membership on the ancestor had propagate=true. We need the per-group
    // membership row of each ancestor to check.
    const ancestors = await this.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, "parentId" FROM "User" WHERE id = ${userId}
        UNION ALL
        SELECT u.id, u."parentId" FROM "User" u INNER JOIN up ON u.id = up."parentId"
      )
      SELECT id FROM up WHERE id <> ${userId};
    `;
    const ancestorIds = ancestors.map((r) => Number(r.id));
    const inheritedGroupIds = ancestorIds.length
      ? (await this.prisma.accessGroupMember.findMany({
          where: { userId: { in: ancestorIds }, propagate: true },
          select: { groupId: true },
        })).map((m) => m.groupId)
      : [];
    const allGroupIds = Array.from(new Set([...directGroupIds, ...inheritedGroupIds]));

    if (allGroupIds.length === 0) {
      return { ids: [], globalCount: 0, groupedCount: 0 };
    }

    const grouped = await this.prisma.accessGroupNas.findMany({
      where: { groupId: { in: allGroupIds } },
      select: { nasId: true },
    });
    const ids = Array.from(new Set(grouped.map((g) => g.nasId)));
    return { ids, globalCount: 0, groupedCount: ids.length };
  }

  async visiblePackagesFor(actor: any): Promise<{ ids: number[] | 'ALL' }> {
    if (this.scope.isAdmin(actor?.role)) return { ids: 'ALL' };
    const userId = Number(actor?.sub ?? actor?.id);
    if (!userId) return { ids: [] };

    const direct = await this.prisma.accessGroupMember.findMany({
      where: { userId }, select: { groupId: true },
    });
    const ancestors = await this.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, "parentId" FROM "User" WHERE id = ${userId}
        UNION ALL
        SELECT u.id, u."parentId" FROM "User" u INNER JOIN up ON u.id = up."parentId"
      )
      SELECT id FROM up WHERE id <> ${userId};`;
    const ancestorIds = ancestors.map((r) => Number(r.id));
    const inherited = ancestorIds.length
      ? (await this.prisma.accessGroupMember.findMany({
          where: { userId: { in: ancestorIds }, propagate: true },
          select: { groupId: true },
        })).map((m) => m.groupId)
      : [];
    const allGroupIds = Array.from(new Set([...direct.map((d) => d.groupId), ...inherited]));
    if (allGroupIds.length === 0) return { ids: [] };

    const grouped = await this.prisma.accessGroupPackage.findMany({
      where: { groupId: { in: allGroupIds } },
      select: { packageId: true },
    });
    return { ids: Array.from(new Set(grouped.map((g) => g.packageId))) };
  }

  /**
   * Returns a Prisma where-fragment for NAS that limits the actor to GLOBAL +
   * GROUPED rows. Owner is still layered on by the calling service.
   */
  async nasWhereWithGroups(actor: any): Promise<any> {
    if (this.scope.isAdmin(actor?.role)) return {};
    const vis = await this.visibleNasFor(actor);
    if (vis.ids === 'ALL') return {};
    // GLOBAL = no row in AccessGroupNas for that nasId.
    return {
      OR: [
        { accessGroups: { none: {} } },
        { id: { in: vis.ids as number[] } },
      ],
    };
  }

  async packageWhereWithGroups(actor: any): Promise<any> {
    if (this.scope.isAdmin(actor?.role)) return {};
    const vis = await this.visiblePackagesFor(actor);
    if (vis.ids === 'ALL') return {};
    return {
      OR: [
        { accessGroups: { none: {} } },
        { id: { in: vis.ids as number[] } },
      ],
    };
  }
}
