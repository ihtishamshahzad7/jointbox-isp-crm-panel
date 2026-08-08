import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { validatePassword } from '../security/security.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * Ceiling on the un-paginated user list. Large enough that no realistic
 * downline is truncated in practice, small enough that a runaway query cannot
 * take the panel down.
 */
const USER_LIST_CAP = 500;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /** Group accounts by role, parent or KYC status — clear classification. */
  async groupedBy(by: string, actor?: Actor) {
    // Scope: admins see all; others see their subtree (descendants incl. self).
    let where: any = {};
    if (!this.scope.isAdmin(actor?.role)) {
      const ids = await this.scope.descendantIds(this.scope.actorId(actor));
      where = { id: { in: ids } };
    }
    const field = ({ role: 'role', parent: 'parentId', kyc: 'kycStatus' } as Record<string, string>)[by] || 'role';
    const groups = await this.prisma.user.groupBy({ by: [field as any], where, _count: { _all: true } });
    const active = await this.prisma.user.groupBy({ by: [field as any], where: { AND: [where, { isActive: true }] }, _count: { _all: true } });
    const activeMap = new Map(active.map((g: any) => [g[field], g._count._all]));

    const labels = new Map<any, string>();
    if (field === 'parentId') {
      const keys = groups.map((g: any) => g[field]).filter((v) => v != null);
      if (keys.length) {
        const rows = await this.prisma.user.findMany({ where: { id: { in: keys } }, select: { id: true, name: true, role: true } });
        rows.forEach((r) => labels.set(r.id, `${r.name} (${r.role})`));
      }
    }
    return {
      groupBy: by,
      groups: groups.map((g: any) => {
        const key = g[field];
        return {
          key,
          label: field === 'parentId'
            ? (labels.get(key) ?? (key == null ? 'Top-level (no parent)' : `#${key}`))
            : String(key ?? 'Unspecified'),
          total: g._count._all,
          active: activeMap.get(key) ?? 0,
        };
      }).sort((a, b) => b.total - a.total),
    };
  }

  /** The logged-in user's own profile: details, organization, downline counts, balance. */
  async myProfile(actor?: Actor) {
    const id = this.scope.actorId(actor);
    const me = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, phone: true, address: true, role: true,
        isActive: true, balance: true, commissionPercent: true,
        canTopupDownline: true, canAddNas: true, canSetPackagePrice: true,
        createdAt: true, updatedAt: true,
        photoUrl: true, cnicFrontUrl: true, cnicBackUrl: true,
        parent: { select: { id: true, name: true, role: true } },
        branch: { select: { id: true, name: true, isp: { select: { id: true, name: true } } } },
      },
    });
    if (!me) throw new NotFoundException('Profile not found');

    // Downline (subtree including self) for the counts.
    const ids = await this.scope.descendantIds(id);
    const [subscribers, resellers, subResellers, retailers, staff, packages, lastLogin] = await Promise.all([
      this.prisma.subscriber.count({ where: { userId: { in: ids } } }),
      this.prisma.user.count({ where: { id: { in: ids }, role: 'RESELLER', NOT: { id } } }),
      this.prisma.user.count({ where: { id: { in: ids }, role: 'SUB_RESELLER', NOT: { id } } }),
      this.prisma.user.count({ where: { id: { in: ids }, role: 'RETAILER', NOT: { id } } }),
      this.prisma.user.count({ where: { id: { in: ids }, role: 'SALES', NOT: { id } } }),
      this.prisma.package.count(),
      this.prisma.loginLog.findFirst({ where: { userId: id, status: 'SUCCESS' }, orderBy: { id: 'desc' }, select: { createdAt: true, ipAddress: true } }),
    ]);

    return {
      ...me,
      isp: me.branch?.isp?.name ?? null,
      branchName: me.branch?.name ?? null,
      createdBy: me.parent?.name ?? '—',
      counts: { packages, subscribers, staff, resellers, subResellers, retailers },
      lastLogin: lastLogin?.createdAt ?? null,
      lastLoginIp: lastLogin?.ipAddress ?? null,
    };
  }

  async findAll(actor?: Actor) {
    // A reseller sees only its DOWNLINE — its own descendants, excluding itself
    // (so you don't see your own account, and never a sibling). ISP/admin see all.
    let where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const rootId = await this.scope.rootId(actor); // staff → their owner's subtree
      const ids = (await this.scope.descendantIds(rootId)).filter((id) => id !== rootId);
      where = { id: { in: ids.length ? ids : [-1] } }; // [-1] => empty list when no downline yet
    }
    const users = await this.prisma.user.findMany({
      where,
      select: {
        id:        true,
        name:      true,
        email:     true,
        role:      true,
        phone:     true,
        address:   true,
        isActive:  true,
        balance:   true,
        createdAt: true,
        updatedAt: true,
        parentId:  true,
        parent: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      /**
       * SCALE GUARD.
       *
       * This method had no cap at all, and the app shell calls it on EVERY page
       * navigation to build the "Act as" list. At a thousand accounts that is
       * the entire user table plus five aggregate queries, re-run on every
       * click — the panel would get slower the more successful the ISP got.
       *
       * Callers needing the full set must page via findAllPaginated().
       */
      take: USER_LIST_CAP,
    });

    // Batched last-login lookup for the whole page (one query, not N).
    const uids = users.map((u) => u.id);
    const logins = uids.length
      ? await this.prisma.loginLog.groupBy({
          by: ['userId'], where: { userId: { in: uids }, status: 'SUCCESS' }, _max: { createdAt: true },
        })
      : [];
    const lastLoginMap = new Map(logins.map((l) => [l.userId, l._max.createdAt]));

    // ⚡ Counts via 4 grouped queries for the WHOLE page, not 4 per user.
    // The previous per-user version issued 4 × N queries — 400 round trips for
    // 100 users — which was the single worst hot path in the app.
    const [subGroups, childGroups, payGroups, ticketGroups] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['userId'],     where: { userId:     { in: uids } }, _count: { _all: true } }),
      this.prisma.user.groupBy({       by: ['parentId'],   where: { parentId:   { in: uids } }, _count: { _all: true } }),
      this.prisma.payment.groupBy({    by: ['receivedBy'], where: { receivedBy: { in: uids } }, _count: { _all: true } }),
      this.prisma.ticket.groupBy({     by: ['assignedTo'], where: { assignedTo: { in: uids } }, _count: { _all: true } }),
    ]);

    const toMap = (rows: any[], key: string) =>
      new Map(rows.map((r) => [r[key] as number, r._count?._all ?? 0]));
    const subMap    = toMap(subGroups,    'userId');
    const childMap  = toMap(childGroups,  'parentId');
    const payMap    = toMap(payGroups,    'receivedBy');
    const ticketMap = toMap(ticketGroups, 'assignedTo');

    return users.map((user) => ({
      ...user,
      lastLogin: lastLoginMap.get(user.id) ?? null,
      _count: {
        ownedSubscribers: subMap.get(user.id)    ?? 0,
        children:         childMap.get(user.id)  ?? 0,
        payments:         payMap.get(user.id)    ?? 0,
        assignedTickets:  ticketMap.get(user.id) ?? 0,
      },
    }));
  }

  async findAllPaginated(
    page:    number = 1,
    limit:   number = 10,
    filters?: { role?: string; isActive?: boolean; search?: string },
  ) {
    const skip  = (page - 1) * limit;
    const where: any = {};

    if (filters?.role)                   where.role     = filters.role;
    if (filters?.isActive !== undefined) where.isActive = filters.isActive;
    if (filters?.search) {
      where.OR = [
        { name:  { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id:        true,
        name:      true,
        email:     true,
        role:      true,
        phone:     true,
        address:   true,
        isActive:  true,
        balance:   true,
        createdAt: true,
        parentId:  true,
        parent: { select: { id: true, name: true, email: true, role: true } },
      },
      skip,
      take:    limit,
      orderBy: { createdAt: 'desc' },
    });

    const total = await this.prisma.user.count({ where });

    const userIds = users.map((u) => u.id);

    const [subGroups, childGroups] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { userId: true } }),
      this.prisma.user.groupBy({ by: ['parentId'], where: { parentId: { in: userIds } }, _count: { _all: true } }),
    ]);

    const subMap = new Map(subGroups.map((r) => [r.userId, r._count.userId]));
    const childMap = new Map(childGroups.map((r) => [r.parentId, r._count._all]));

    const usersWithCounts = users.map((user) => ({
      ...user,
      _count: {
        ownedSubscribers: subMap.get(user.id) ?? 0,
        children: childMap.get(user.id) ?? 0,
      },
    }));

    return {
      data: usersWithCounts,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findByRole(role: string) {
    return this.prisma.user.findMany({
      where:   { role: role as any, isActive: true },
      select:  { id: true, name: true, email: true, role: true, phone: true, balance: true },
      orderBy: { name: 'asc' },
    });
  }

  async findByParent(parentId: number) {
    const users = await this.prisma.user.findMany({
      where:  { parentId, isActive: true },
      select: { id: true, name: true, email: true, role: true, phone: true, balance: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const userIds = users.map((u) => u.id);

    const [subGroups, childGroups] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { userId: true } }),
      this.prisma.user.groupBy({ by: ['parentId'], where: { parentId: { in: userIds } }, _count: { _all: true } }),
    ]);

    const subMap = new Map(subGroups.map((r) => [r.userId, r._count.userId]));
    const childMap = new Map(childGroups.map((r) => [r.parentId, r._count._all]));

    return users.map((user) => ({
      ...user,
      _count: {
        ownedSubscribers: subMap.get(user.id) ?? 0,
        children: childMap.get(user.id) ?? 0,
      },
    }));
  }

  async getUserHierarchy(userId: number) {
    const user = await this.findOne(userId);

    const getChildren = async (id: number): Promise<any[]> => {
      const children = await this.prisma.user.findMany({
        where:  { parentId: id, isActive: true },
        select: { id: true, name: true, email: true, role: true, phone: true, balance: true, createdAt: true },
      });

      if (children.length === 0) return children;

      const childIds = children.map((c) => c.id);

      // One batch query for subscriber counts at this level, not N
      const subGroups = await this.prisma.subscriber.groupBy({
        by: ['userId'],
        where: { userId: { in: childIds } },
        _count: { userId: true },
      });
      const subMap = new Map(subGroups.map((r) => [r.userId, r._count.userId]));

      // Recurse for grandchildren
      const nestedChildren = await Promise.all(
        childIds.map((cid) => getChildren(cid)),
      );

      for (let i = 0; i < children.length; i++) {
        (children[i] as any).children = nestedChildren[i];
        (children[i] as any)._count   = { ownedSubscribers: subMap.get(children[i].id) ?? 0 };
      }
      return children;
    };

    return { ...user, children: await getChildren(userId) };
  }

  async findOne(id: number, actor?: Actor) {
    if (actor) await this.scope.assertUser(actor, id);
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id:        true,
        name:      true,
        email:     true,
        role:      true,
        phone:     true,
        address:   true,
        isActive:  true,
        balance:   true,
        parentId:  true,
        createdAt: true,
        updatedAt: true,
        photoUrl: true, cnicFrontUrl: true, cnicBackUrl: true,
        smsEnabled: true, emailEnabled: true,
        country: true, province: true, city: true,
        identity: true, zipCode: true, dateOfBirth: true, about: true,
        additionalPhones: true, additionalEmails: true,
        autoRenew: true, billingType: true, accountingLimit: true,
        nasGroup: true, areaGroup: true,
        commissionPercent: true,
        branchId: true,
        branch: {
          select: { id: true, name: true, isp: { select: { id: true, name: true } } },
        },
        parent: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    const [
      ownedSubscribersCount,
      childrenCount,
      paymentsCount,
      ticketsCount,
      ownedPackagesCount,
      recentSubscribers,
      recentPayments,
      recentTickets,
      lastLogin,
      childRoleCounts,
    ] = await Promise.all([
      this.prisma.subscriber.count({ where: { userId: id } }),
      this.prisma.user.count({ where: { parentId: id } }),
      this.prisma.payment.count({ where: { receivedBy: id } }),
      this.prisma.ticket.count({ where: { assignedTo: id } }),
      this.prisma
        .resellerPackagePrice
        .count({ where: { userId: id } }),
      this.prisma.subscriber.findMany({
        where:   { userId: id },
        take:    10,
        orderBy: { createdAt: 'desc' },
        select:  {
          id: true, fullName: true, phone: true, status: true,
          package: { select: { name: true, price: true } },
        },
      }),
      this.prisma.payment.findMany({
        where:   { receivedBy: id },
        take:    10,
        orderBy: { createdAt: 'desc' },
        select:  {
          id: true, amount: true, method: true, paymentDate: true,
          invoice: { select: { invoiceNo: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where:   { assignedTo: id },
        take:    10,
        orderBy: { createdAt: 'desc' },
        select:  { id: true, ticketNo: true, subject: true, status: true, priority: true, createdAt: true },
      }),
      this.prisma.loginLog.findFirst({
        where:  { userId: id, status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { parentId: id },
        _count: { role: true },
      }),
    ]);

    // Convert child role counts into named fields
    const roleBreakdown: Record<string, number> = {};
    for (const row of childRoleCounts) {
      roleBreakdown[row.role.toLowerCase()] = row._count.role;
    }

    const children = await this.prisma.user.findMany({
      where:  { parentId: id },
      select: { id: true, name: true, email: true, role: true, isActive: true, balance: true },
    });

    const childIds = children.map((c) => c.id);
    const subGroups = childIds.length
      ? await this.prisma.subscriber.groupBy({ by: ['userId'], where: { userId: { in: childIds } }, _count: { userId: true } })
      : [];
    const subMap = new Map(subGroups.map((r) => [r.userId, r._count.userId]));

    const childrenWithCounts = children.map((child) => ({
      ...child,
      _count: { ownedSubscribers: subMap.get(child.id) ?? 0 },
    }));

    return {
      ...user,
      lastLogin:       lastLogin?.createdAt ?? null,
      children:        childrenWithCounts,
      subscribers:     recentSubscribers,
      payments:        recentPayments,
      assignedTickets: recentTickets,
      _count: {
        ownedSubscribers: ownedSubscribersCount,
        children:         childrenCount,
        payments:         paymentsCount,
        assignedTickets:  ticketsCount,
        ownedPackages:    ownedPackagesCount,
        subresellers:     roleBreakdown['sub_reseller'] ?? 0,
        retailers:        roleBreakdown['retailer'] ?? 0,
        sales:            roleBreakdown['sales'] ?? 0,
      },
    };
  }

  async findUserPackages(id: number, actor?: Actor) {
    if (actor) await this.scope.assertUser(actor, id);
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    // Get all active packages that this user's ancestors own, plus the user's own prices
    const ancestors = await this.scope.ancestorIds(id);
    const packages = await this.prisma.package.findMany({
      where: {
        ownerId: { in: ancestors },
        isActive: true,
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        price: true,
        duration: true,
        isActive: true,
        downloadSpeed: true,
        uploadSpeed: true,
        dataQuotaGb: true,
        _count: { select: { subscribers: true } },
      },
    });

    // Get the reseller's pricing for these packages (if set)
    const userPrices = await this.prisma.resellerPackagePrice.findMany({
      where:  { userId: id },
      select: {
        packageId: true,
        price: true,
        retailPrice: true,
        subresellerProfit: true,
        subscriberProfit: true,
      },
    });
    const priceMap = new Map(userPrices.map((p) => [p.packageId, p]));

    return packages.map((pkg) => {
      const assigned = priceMap.get(pkg.id);
      return {
        ...pkg,
        minimumPrice: Math.round(pkg.price),
        price:        assigned?.price ?? null,
        retailPrice:  assigned?.retailPrice ?? null,
        subresellerProfit: assigned?.subresellerProfit ?? null,
        subscriberProfit:  assigned?.subscriberProfit ?? null,
      };
    });
  }

  async getStats(actor?: Actor) {
    // Scope every count to the actor's subtree (ISP/admin => all).
    const s = await this.scope.userWhere(actor);
    const w = (extra: any) => (Object.keys(s).length ? { AND: [s, extra] } : extra);

    const [
      total, activeUsers, inactiveUsers,
      superAdmins, admins, sales, resellers, subResellers, retailers,
      totalBalance,
    ] = await Promise.all([
      this.prisma.user.count({ where: w({}) }),
      this.prisma.user.count({ where: w({ isActive: true }) }),
      this.prisma.user.count({ where: w({ isActive: false }) }),
      this.prisma.user.count({ where: w({ role: 'SUPER_ADMIN' }) }),
      this.prisma.user.count({ where: w({ role: 'ADMIN' }) }),
      this.prisma.user.count({ where: w({ role: 'SALES' }) }),
      this.prisma.user.count({ where: w({ role: 'RESELLER' }) }),
      this.prisma.user.count({ where: w({ role: 'SUB_RESELLER' }) }),
      this.prisma.user.count({ where: w({ role: 'RETAILER' }) }),
      this.prisma.user.aggregate({
        _sum:  { balance: true },
        where: w({ role: { in: ['RESELLER', 'SUB_RESELLER', 'RETAILER'] as any } }),
      }),
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentUsers = await this.prisma.user.count({ where: w({ createdAt: { gte: thirtyDaysAgo } }) });

    const usersWithSubscribersResult: any = await this.prisma.$queryRaw`
      SELECT COUNT(DISTINCT "userId") as count
      FROM "Subscriber"
      WHERE "userId" IS NOT NULL
    `;
    const usersWithSubscribers = Number(usersWithSubscribersResult[0]?.count || 0);

    return {
      total,
      activeUsers,
      inactiveUsers,
      recentUsers,
      superAdmins,
      admins,
      sales,
      resellers,
      subResellers,
      retailers,
      totalBalance: totalBalance._sum.balance ?? 0,
      usersWithSubscribers,
      byRole: [
        { role: 'SUPER_ADMIN',  count: superAdmins  },
        { role: 'ADMIN',        count: admins        },
        { role: 'SALES',        count: sales         },
        { role: 'RESELLER',     count: resellers     },
        { role: 'SUB_RESELLER', count: subResellers  },
        { role: 'RETAILER',     count: retailers     },
      ],
    };
  }

  async create(data: {
    name:       string;
    email:      string;
    password:   string;
    role:       string;
    phone?:     string;
    address?:   string;
    parentId?:  number;
    balance?:   number;
    photoUrl?:     string;
    cnicFrontUrl?: string;
    cnicBackUrl?:  string;
    isActive?:     boolean;
    smsEnabled?:   boolean;
    emailEnabled?: boolean;
    country?:      string;
    province?:     string;
    city?:         string;
  }, actor?: Actor) {
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException(`User with email ${data.email} already exists`);

    // Hierarchy: a new account is placed UNDER its creator by default, so it lands
    // in their tree automatically. If a parent is given explicitly, admins may put
    // it anywhere; a reseller may only place it inside its own subtree.
    if (actor) {
      if (!data.parentId) data.parentId = this.scope.actorId(actor);
      else if (!this.scope.isAdmin(actor.role)) await this.scope.assertUser(actor, data.parentId);
    }

    if (data.parentId) {
      const parent = await this.prisma.user.findUnique({ where: { id: data.parentId } });
      if (!parent) throw new NotFoundException(`Parent user with ID ${data.parentId} not found`);

      // Strict one-level-down creation. Each role may create ONLY the role directly
      // beneath it: ISP → Franchise → Dealer → Retailer. This is what forces the
      // ISP to switch into a franchise to create dealers, etc.
      const nextRole: Record<string, string | null> = {
        SUPER_ADMIN:  'RESELLER',      // ISP creates a Franchise
        ADMIN:        'RESELLER',      // ISP creates a Franchise
        RESELLER:     'SUB_RESELLER',  // Franchise creates a Dealer
        SUB_RESELLER: 'RETAILER',      // Dealer creates a Retailer
        RETAILER:     null,            // Retailer creates customers, not sub-accounts
      };
      const labels: Record<string, string> = {
        RESELLER: 'Franchise', SUB_RESELLER: 'Dealer', RETAILER: 'Retailer', ADMIN: 'ISP',
      };
      // AUDITOR is a read-only books account. Only the ISP owner may mint one,
      // placed anywhere in their tree — it sees that subtree but writes nothing.
      if (data.role === 'AUDITOR') {
        if (parent.role !== 'SUPER_ADMIN' && parent.role !== 'ADMIN') {
          throw new BadRequestException('Only the ISP owner can create an auditor (read-only) account.');
        }
      }
      // STAFF (SALES) can be created by ANY account to help run the business.
      else if (data.role !== 'SALES') {
        const allowed = nextRole[parent.role];
        if (allowed === null) {
          throw new BadRequestException(`A ${labels[parent.role] || parent.role} can only create Staff accounts, not sub-resellers.`);
        }
        if (allowed && data.role !== allowed) {
          throw new BadRequestException(
            `A ${labels[parent.role] || parent.role} can only create a ${labels[allowed] || allowed} or a Staff account.`,
          );
        }
      }
    }

    // Phase 4A: password policy
    const policyError = validatePassword(data.password);
    if (policyError) throw new BadRequestException(policyError);

    const hashedPassword = await bcrypt.hash(data.password, 10);

    return this.prisma.user.create({
      data: {
        name:      data.name,
        email:     data.email,
        password:  hashedPassword,
        role:      data.role as any,
        phone:     data.phone,
        address:   data.address,
        parentId:  data.parentId,
        photoUrl:     data.photoUrl     || null,
        cnicFrontUrl: data.cnicFrontUrl || null,
        cnicBackUrl:  data.cnicBackUrl  || null,
        // Status + contact prefs + location. Defaults match the schema so an
        // omitted field behaves exactly as before.
        isActive:     data.isActive !== undefined ? data.isActive : true,
        smsEnabled:   data.smsEnabled !== undefined ? data.smsEnabled : true,
        emailEnabled: data.emailEnabled !== undefined ? data.emailEnabled : true,
        country:      data.country  || null,
        province:     data.province || null,
        city:         data.city     || null,
        // Only the ISP/admin (the source) may seed a starting balance. A reseller
        // creates children at 0 and must fund them via a prepaid wallet top-up.
        balance:   this.scope.isAdmin(actor?.role) ? (data.balance || 0) : 0,
      },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, address: true, isActive: true, balance: true,
        parentId: true, createdAt: true,
        photoUrl: true, cnicFrontUrl: true, cnicBackUrl: true,
        smsEnabled: true, emailEnabled: true, country: true, province: true, city: true,
      },
    });
  }

  async update(
    id:   number,
    data: {
      name?:      string;
      email?:     string;
      password?:  string;
      role?:      string;
      phone?:     string;
      address?:   string;
      parentId?:  number;
      isActive?:  boolean;
      photoUrl?:     string;
      cnicFrontUrl?: string;
      cnicBackUrl?:  string;
      smsEnabled?:   boolean;
      emailEnabled?: boolean;
      country?:      string;
      province?:     string;
      city?:         string;
      identity?:        string;
      zipCode?:         string;
      dateOfBirth?:     string;
      about?:           string;
      additionalPhones?: string;
      additionalEmails?: string;
      autoRenew?:       boolean;
      billingType?:     string;
      accountingLimit?: number;
      nasGroup?:        string;
      areaGroup?:       string;
      branchId?:        number;
      commissionPercent?: number;
    },
    actor?: Actor,
  ) {
    if (actor) await this.scope.assertUser(actor, id);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    if (data.email && data.email !== user.email) {
      const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new ConflictException(`User with email ${data.email} already exists`);
    }

    if (data.parentId !== undefined) {
      if (data.parentId === id) throw new BadRequestException('User cannot be their own parent');

      if (data.parentId) {
        const parent = await this.prisma.user.findUnique({ where: { id: data.parentId } });
        if (!parent) throw new NotFoundException(`Parent user with ID ${data.parentId} not found`);

        let currentParentId = parent.parentId;
        while (currentParentId) {
          if (currentParentId === id) throw new BadRequestException('Circular hierarchy detected');
          const currentParent = await this.prisma.user.findUnique({ where: { id: currentParentId } });
          currentParentId = currentParent?.parentId ?? null;
        }
      }
    }

    const updateData: any = { ...data };
    // Balance is MONEY — it can never be edited here. It only changes through the
    // audited wallet flow (Organization → Wallet top-up/withdraw), which is prepaid
    // and scoped. Silently drop any balance sent from the edit form.
    delete updateData.balance;

    // Handle dateOfBirth as ISO string → Date
    if (typeof updateData.dateOfBirth === 'string') {
      updateData.dateOfBirth = new Date(updateData.dateOfBirth);
    }

    if (data.password) {
      // Phase 4A: password policy
      const policyError = validatePassword(data.password);
      if (policyError) throw new BadRequestException(policyError);
      updateData.password = await bcrypt.hash(data.password, 10);
    } else {
      delete updateData.password;
    }

    return this.prisma.user.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, address: true, isActive: true, balance: true,
        parentId: true, updatedAt: true,
        photoUrl: true, cnicFrontUrl: true, cnicBackUrl: true,
        smsEnabled: true, emailEnabled: true, country: true, province: true, city: true,
        identity: true, zipCode: true, dateOfBirth: true, about: true,
        additionalPhones: true, additionalEmails: true,
        autoRenew: true, billingType: true, accountingLimit: true,
        nasGroup: true, areaGroup: true,
        commissionPercent: true,
      },
    });
  }

  /**
   * Remove an account and everything beneath it. ISP only.
   *
   * `delete()` refuses while an account has subscribers, children or a wallet
   * balance — which is right for an accidental click, and useless for the case
   * this exists to serve: a dealer leaves, or moves to another ISP, and their
   * data has to come out of the database entirely rather than sit there
   * forever inflating counts and confusing reports.
   *
   * Two-phase on purpose. `dryRun` reports exactly what would go, by name and
   * count, and nothing is written. Only a second call with `confirm` set to
   * the account's own name actually removes it — typing a name is a deliberate
   * act in a way that clicking OK is not.
   */
  async purgeAccount(
    actor: Actor,
    rootUserId: number,
    opts: { dryRun?: boolean; confirm?: string } = {},
  ) {
    if (!this.scope.isAdmin(actor?.role)) {
      throw new ForbiddenException(
        'Only the ISP account can purge data. Your parent account can remove yours.',
      );
    }
    const root = await this.prisma.user.findUnique({
      where: { id: rootUserId },
      select: { id: true, name: true, role: true, balance: true },
    });
    if (!root) throw new NotFoundException('Account not found');
    if (rootUserId === this.scope.actorId(actor)) {
      throw new BadRequestException('You cannot purge the account you are signed in with.');
    }

    // The whole subtree: this account and every account under it.
    const ids = await this.scope.descendantIds(rootUserId);

    const [users, subscribers, invoices, payments, prices, nasOwned, poolsOwned] =
      await Promise.all([
        this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true, balance: true } }),
        this.prisma.subscriber.count({ where: { userId: { in: ids } } }),
        this.prisma.invoice.count({ where: { subscriber: { userId: { in: ids } } } }),
        this.prisma.payment.count({ where: { subscriber: { userId: { in: ids } } } }),
        this.prisma.resellerPackagePrice.count({ where: { userId: { in: ids } } }),
        this.prisma.nas.count({ where: { ownerId: { in: ids } } }),
        this.prisma.ipPool.count({ where: { ownerId: { in: ids } } }),
      ]);

    const heldBalance = users.reduce((n, u) => n + (u.balance ?? 0), 0);

    const plan = {
      account: root.name,
      accounts: users.map((u) => ({ id: u.id, name: u.name, role: u.role, balance: u.balance })),
      willDelete: {
        accounts: users.length,
        subscribers,
        /** Detached, not deleted — the money stays in your books. */
        invoicesDetached: invoices,
        paymentsDetached: payments,
        priceRows: prices,
      },
      willDetach: { routers: nasOwned, ipPools: poolsOwned },
      heldBalance,
      warning: heldBalance > 0
        ? `These accounts still hold ${heldBalance.toFixed(0)} in wallet balance. That money disappears with them and is not returned to you.`
        : null,
    };

    if (opts.dryRun !== false && opts.confirm !== root.name) {
      return { ...plan, dryRun: true, confirmWith: root.name };
    }
    if (opts.confirm !== root.name) {
      throw new BadRequestException(
        `To confirm, send confirm="${root.name}" — the exact account name. Nothing has been removed.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      /**
       * Subscribers first, then accounts.
       *
       * Deleting the users alone would only detach their subscribers (userId is
       * SetNull), leaving orphaned customers in the database still consuming
       * RADIUS credentials and still counted in totals — the opposite of
       * cleaning up. Removing them explicitly is the point of the exercise.
       */
      const subs = await tx.subscriber.findMany({
        where: { userId: { in: ids } }, select: { id: true, fullName: true },
      });
      for (const s of subs) {
        // Keep the financial trail readable once it is detached.
        await tx.invoice.updateMany({ where: { subscriberId: s.id }, data: { subscriberName: s.fullName } });
        await tx.payment.updateMany({ where: { subscriberId: s.id }, data: { subscriberName: s.fullName } });
      }
      await tx.subscriber.deleteMany({ where: { userId: { in: ids } } });

      // Routers and pools become ISP-owned rather than vanishing — they are
      // hardware and address space you paid for.
      await tx.nas.updateMany({ where: { ownerId: { in: ids } }, data: { ownerId: null } });
      await tx.ipPool.updateMany({ where: { ownerId: { in: ids } }, data: { ownerId: null } });

      // Deepest accounts first so no parent is removed before its children.
      const ordered = [...ids].reverse();
      for (const uid of ordered) {
        await tx.user.delete({ where: { id: uid } }).catch(() => null);
      }
    });

    // Loud and permanent: this is the one action with no undo.
    console.warn(
      `⚠️ PURGED account "${root.name}" (#${rootUserId}) — ${users.length} account(s), ` +
      `${subscribers} subscriber(s) removed by user #${this.scope.actorId(actor)}`,
    );
    return { ...plan, dryRun: false, purged: true };
  }

  async delete(id: number, actor?: Actor) {
    if (actor) await this.scope.assertUser(actor, id);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    const subscribersCount = await this.prisma.subscriber.count({ where: { userId: id } });
    if (subscribersCount > 0) {
      throw new BadRequestException(
        `Cannot delete user with ${subscribersCount} subscribers. Reassign or delete subscribers first.`,
      );
    }

    const childrenCount = await this.prisma.user.count({ where: { parentId: id } });
    if (childrenCount > 0) {
      throw new BadRequestException(
        `Cannot delete user with ${childrenCount} child users. Reassign or delete children first.`,
      );
    }

    /**
     * Money cannot be deleted quietly.
     *
     * Subscribers and children were checked; the wallet was not. Deleting an
     * account holding Rs 5,000 destroyed that balance with no ledger entry and
     * no way to tell afterwards where it went — the parent had already paid it
     * out, so the loss is real, not notional.
     */
    if (user.balance && Math.abs(user.balance) > 0.009) {
      throw new BadRequestException(
        `${user.name} still holds a wallet balance of ${user.balance.toFixed(0)}. ` +
        `Withdraw it back to the parent account first — deleting now would destroy that money ` +
        `with no record of where it went.`,
      );
    }

    return this.prisma.user.delete({ where: { id } });
  }

  async softDelete(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return this.prisma.user.update({ where: { id }, data: { isActive: false } });
  }

  async restore(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return this.prisma.user.update({ where: { id }, data: { isActive: true } });
  }

  async toggleStatus(id: number, actor?: Actor) {
    if (actor) await this.scope.assertUser(actor, id);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return this.prisma.user.update({
      where: { id },
      data:  { isActive: !user.isActive },
      select: { id: true, name: true, isActive: true },
    });
  }

  async changeRole(id: number, role: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    const validRoles = ['SUPER_ADMIN', 'ADMIN', 'SALES', 'RESELLER', 'SUB_RESELLER', 'RETAILER', 'AUDITOR'];
    if (!validRoles.includes(role)) {
      throw new BadRequestException(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
    }

    return this.prisma.user.update({
      where: { id },
      data:  { role: role as any },
      select: { id: true, name: true, email: true, role: true },
    });
  }

  async addBalance(id: number, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than 0');

    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    const allowedRoles = ['RESELLER', 'SUB_RESELLER', 'RETAILER'];
    if (!allowedRoles.includes(user.role)) {
      throw new ForbiddenException(`Balance can only be added to ${allowedRoles.join(', ')} roles`);
    }

    return this.prisma.user.update({
      where: { id },
      data:  { balance: { increment: amount } },
      select: { id: true, name: true, role: true, balance: true },
    });
  }

  async deductBalance(id: number, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than 0');

    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);

    if (user.balance < amount) {
      throw new BadRequestException(`Insufficient balance. Current balance: ${user.balance}`);
    }

    return this.prisma.user.update({
      where: { id },
      data:  { balance: { decrement: amount } },
      select: { id: true, name: true, role: true, balance: true },
    });
  }

  async getBalance(id: number) {
    const user = await this.prisma.user.findUnique({
      where:  { id },
      select: { id: true, name: true, role: true, balance: true },
    });
    if (!user) throw new NotFoundException(`User with ID ${id} not found`);
    return user;
  }

  async getUserDashboardSummary(id: number) {
    const user = await this.findOne(id);

    const [totalSubscribers, activeSubscribers, totalRevenue, pendingTickets] = await Promise.all([
      this.prisma.subscriber.count({ where: { userId: id } }),
      this.prisma.subscriber.count({ where: { userId: id, status: 'ACTIVE' } }),
      this.prisma.payment.aggregate({ _sum: { amount: true }, where: { receivedBy: id } }),
      this.prisma.ticket.count({ where: { assignedTo: id, status: { not: 'CLOSED' } } }),
    ]);

    return {
      user: { id: user.id, name: user.name, role: user.role, balance: user.balance },
      stats: {
        totalSubscribers,
        activeSubscribers,
        totalRevenue: totalRevenue._sum.amount ?? 0,
        pendingTickets,
      },
    };
  }
}
