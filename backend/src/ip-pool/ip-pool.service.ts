import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class IpPoolService {
  private readonly logger = new Logger(IpPoolService.name);

  constructor(
    private prisma: PrismaService,
    private mikrotikSync: MikrotikSyncService,
    private scope: ScopeService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // SYNC POOLS FROM THE ROUTER  (the router is the source of truth)
  //
  // The panel's pool list is only a description; the MikroTik is what actually
  // assigns addresses. When they disagree — e.g. the panel says
  // 10.172.0.0/24 but subscribers lease 10.172.1.x — every IP-based report and
  // any Framed-Pool sent to RADIUS is wrong.
  //
  // `apply = false` reports differences only; `apply = true` makes the panel
  // match the router (import missing pools, correct ranges).
  // ─────────────────────────────────────────────────────────────
  async syncFromNas(apply = false) {
    const nasList = await this.prisma.nas.findMany({ where: { isActive: true } });
    const report: Array<{
      nas: string; pool: string; routerRange: string;
      panelRange: string | null; status: 'MATCH' | 'DIFFERENT' | 'MISSING_IN_PANEL' | 'MISSING_ON_ROUTER';
      action?: string;
    }> = [];

    for (const nas of nasList) {
      if (!nas.nasIp || !nas.apiUsername || !nas.apiPassword) continue;

      let routerPools: Array<{ name: string; ranges: string }> = [];
      try {
        routerPools = await this.mikrotikSync.getIpPools(
          nas.nasIp, nas.apiPort ?? 8728, nas.apiUsername, nas.apiPassword,
        );
      } catch (e: any) {
        this.logger.warn(`Could not read pools from ${nas.nasname}: ${e?.message || e}`);
        continue;
      }

      const panelPools = await this.prisma.ipPool.findMany();

      // Router → panel
      for (const rp of routerPools) {
        const existing = panelPools.find(
          (p) => p.name.trim().toLowerCase() === rp.name.trim().toLowerCase(),
        );

        if (!existing) {
          report.push({
            nas: nas.nasname, pool: rp.name, routerRange: rp.ranges,
            panelRange: null, status: 'MISSING_IN_PANEL',
            action: apply ? 'imported' : 'would import',
          });
          if (apply) {
            await this.prisma.ipPool.create({
              data: {
                name: rp.name,
                network: rp.ranges,
                subnet: this.rangeToCidr(rp.ranges),
                nasId: nas.id,
              },
            }).catch((e) => { this.logger?.warn?.('createPool: ' + (e?.message || e)); });
          }
        } else if ((existing.network || '').trim() !== rp.ranges.trim()) {
          report.push({
            nas: nas.nasname, pool: rp.name, routerRange: rp.ranges,
            panelRange: existing.network, status: 'DIFFERENT',
            action: apply ? 'corrected to router value' : 'would correct to router value',
          });
          if (apply) {
            await this.prisma.ipPool.update({
              where: { id: existing.id },
              data: { network: rp.ranges, subnet: this.rangeToCidr(rp.ranges), nasId: nas.id },
            }).catch((e) => { this.logger?.warn?.('updatePool: ' + (e?.message || e)); });
          }
        } else {
          report.push({
            nas: nas.nasname, pool: rp.name, routerRange: rp.ranges,
            panelRange: existing.network, status: 'MATCH',
          });
        }
      }

      // Panel → router (pools defined here that the router doesn't have;
      // Framed-Pool referencing one of these would fail on the NAS).
      for (const pp of panelPools) {
        const onRouter = routerPools.some(
          (r) => r.name.trim().toLowerCase() === pp.name.trim().toLowerCase(),
        );
        if (!onRouter) {
          report.push({
            nas: nas.nasname, pool: pp.name, routerRange: '—',
            panelRange: pp.network, status: 'MISSING_ON_ROUTER',
            action: 'create this pool on the MikroTik, or remove it here',
          });
        }
      }
    }

    const mismatches = report.filter((r) => r.status !== 'MATCH').length;
    return { applied: apply, checked: report.length, mismatches, report };
  }

  /** Best-effort CIDR from a MikroTik range string like "10.172.1.2-10.172.1.254". */
  private rangeToCidr(ranges: string): string {
    const first = (ranges || '').split(',')[0]?.trim() || '';
    const start = first.split('-')[0]?.trim() || '';
    const octets = start.split('.');
    return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : (ranges || '');
  }

  // ─────────────────────────────────────────────────────────────
  // GET ALL
  // Returns every pool with its assigned package and subscriber count
  // ─────────────────────────────────────────────────────────────
  /**
   * Check every pool against what actually exists on the routers.
   *
   * A pool here is only a NAME sent to the router as Framed-Pool. The router
   * owns the addresses. If the name doesn't match a pool on the MikroTik —
   * different spelling, different case, never created — the router cannot
   * allocate, invents an address, and drops the session. Auth succeeds, RADIUS
   * looks perfect, and the customer is offline in a reconnect loop.
   *
   * That failure is invisible from the panel and cost real downtime, so it is
   * checked explicitly rather than discovered through a customer complaint.
   */
  async verifyAgainstRouters() {
    const [pools, nasList] = await Promise.all([
      this.prisma.ipPool.findMany({
        include: {
          nas: { select: { id: true, nasname: true, nasIp: true } },
          _count: { select: { packages: true } },
          packages: { select: { id: true, name: true, _count: { select: { subscribers: true } } } },
        },
      }),
      this.prisma.nas.findMany({
        where: { isActive: true, nasIp: { not: null }, apiUsername: { not: null } },
      }),
    ]);

    // Read each router once, not once per pool.
    const routerPools = new Map<number, string[]>();
    const unreachable: string[] = [];
    for (const nas of nasList) {
      try {
        const found = await this.mikrotikSync.getIpPools(
          nas.nasIp!, nas.apiPort ?? 8728, nas.apiUsername!, nas.apiPassword!,
        );
        routerPools.set(nas.id, (found || []).map((p: any) => p.name).filter(Boolean));
      } catch {
        unreachable.push(nas.nasname || nas.nasIp || String(nas.id));
      }
    }

    const allRouterNames = [...routerPools.values()].flat();

    const results = pools.map((p) => {
      // A pool tied to one NAS is only valid on that NAS; an untied pool just
      // needs to exist somewhere.
      const names = p.nasId ? routerPools.get(p.nasId) ?? [] : allRouterNames;
      const exists = names.includes(p.name);
      // Catching a case or whitespace slip is more useful than "not found".
      const nearMiss = !exists
        ? names.find((n) => n.toLowerCase().trim() === p.name.toLowerCase().trim())
        : null;

      const affected = p.packages.reduce((s, k) => s + (k._count?.subscribers ?? 0), 0);

      return {
        id: p.id,
        name: p.name,
        network: p.network,
        nas: p.nas,
        packageCount: p._count.packages,
        affectedSubscribers: affected,
        existsOnRouter: exists,
        suggestion: nearMiss,
        availableOnRouter: names,
        problem: exists
          ? null
          : nearMiss
            ? `The router has "${nearMiss}" — this pool is spelled "${p.name}". Pool names are case-sensitive, so the router cannot match it.`
            : `No pool named "${p.name}" exists on the router. Any customer on this pool will authenticate and then be dropped immediately.`,
      };
    });

    const broken = results.filter((r) => !r.existsOnRouter);
    return {
      pools: results,
      ok: broken.length === 0,
      brokenCount: broken.length,
      subscribersAtRisk: broken.reduce((s, r) => s + r.affectedSubscribers, 0),
      unreachableRouters: unreachable,
      routerPools: allRouterNames,
    };
  }

  /**
   * Pools this account may see.
   *
   * Previously unscoped — every franchise and dealer saw the ISP's entire
   * address space, including test pools, with no way to tell which were
   * theirs to use. A franchise running its own router needs its own pools.
   */
  /**
   * Share a pool with a downline account (or withdraw it).
   *
   * Only the OWNER may share, and only into their own subtree. An account that
   * was merely lent a pool cannot pass it on — otherwise the ISP would lose
   * track of who is drawing from its address space, and two franchises could
   * end up handing the same range to different dealers.
   */
  async setShare(poolId: number, userId: number, on: boolean, actor?: Actor, propagate: boolean = true) {
    const pool = await this.prisma.ipPool.findUnique({ where: { id: poolId } });
    if (!pool) throw new NotFoundException(`IP pool ${poolId} not found`);

    if (actor && !this.scope.isAdmin(actor.role)) {
      const meId = this.scope.actorId(actor);
      // Owner OR holder: an account the pool was shared to may now re-share it
      // to one specific dealer (propagate=false) without every sibling dealer
      // inheriting the range — mirrors NAS sharing.
      const owns = pool.ownerId === meId;
      const holds = owns
        ? true
        : (await this.prisma.ipPoolAssignment.count({ where: { poolId, userId: meId } })) > 0;
      if (!holds) {
        throw new ForbiddenException(
          'You can only share a pool that you own or that has been shared with you.',
        );
      }
      if (userId === meId) {
        throw new ForbiddenException('You cannot share a pool with yourself.');
      }
      await this.scope.assertUser(actor, userId);
    }

    if (on) {
      await this.prisma.ipPoolAssignment.upsert({
        where: { poolId_userId: { poolId, userId } },
        update: { propagate },
        create: { poolId, userId, propagate, assignedById: actor ? this.scope.actorId(actor) : null },
      });
    } else {
      /**
       * Withdrawing access does NOT reclaim addresses already in use.
       *
       * Subscribers holding an address from this pool keep it — their session
       * is live and the address is routable on the router. Removing the share
       * only stops NEW assignments. Yanking live customers offline because of
       * a bookkeeping change would be the wrong trade.
       */
      await this.prisma.ipPoolAssignment
        .delete({ where: { poolId_userId: { poolId, userId } } })
        .catch((e) => { this.logger?.warn?.('deleteAssignment: ' + (e?.message || e)); });
    }
    return { poolId, userId, shared: on };
  }

  async findAll(query: any, actor?: Actor) {
    const groupFilter = query?.group;
    const groupId = groupFilter && groupFilter !== 'ALL' && groupFilter !== 'UNGROUPED'
      ? Number(groupFilter)
      : null;

    const where = await this.scope.poolWhere(actor as any);
    const options: any = {
      where,
      include: {
        assignments: { select: { userId: true, user: { select: { id: true, name: true } } } },
        packages: {
          select: {
            id:       true,
            name:     true,
            isActive: true,
            _count:   { select: { subscribers: true } },
          },
        },
        owner: { select: { id: true, name: true, role: true } },
        _count: { select: { packages: true } },
      },
      orderBy: { id: 'desc' },
    };

    if (groupFilter && groupFilter !== 'ALL') {
      if (groupFilter === 'UNGROUPED') {
        options.where = {
          AND: [where, { accessGroups: { none: {} } }],
        };
      } else if (groupId !== null) {
        options.where = {
          AND: [where, { accessGroups: { some: { groupId } } }],
        };
      }
      options.include.accessGroups = { select: { groupId: true } };
    }

    return this.prisma.ipPool.findMany(options);
  }

  // ─────────────────────────────────────────────────────────────
  // GET ONE
  // ─────────────────────────────────────────────────────────────
  async findOne(id: number) {
    const pool = await this.prisma.ipPool.findUnique({
      where: { id },
      include: {
        packages: {
          select: {
            id:            true,
            name:          true,
            isActive:      true,
            downloadSpeed: true,
            uploadSpeed:   true,
            price:         true,
            _count:        { select: { subscribers: true } },
          },
        },
        _count: { select: { packages: true } },
      },
    });
    if (!pool) throw new NotFoundException(`IP Pool with ID ${id} not found`);
    return pool;
  }

  // ─────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────
  async getStats(actor?: Actor) {
    // Scope to the caller's own pools (same poolWhere as findAll) — pools are
    // per-tenant, so an unscoped count leaked every account's pool totals.
    const base = await this.scope.poolWhere(actor as any);
    const w = (extra: any = {}) => (base && Object.keys(base).length ? { AND: [base, extra] } : extra);
    const total      = await this.prisma.ipPool.count({ where: w() });
    const assigned   = await this.prisma.ipPool.count({ where: w({ packages: { some: {} } }) });
    const unassigned = total - assigned;
    // Packages that have a pool assigned (catalogue-level — packages are shared).
    const packages   = await this.prisma.package.count({ where: { poolId: { not: null } } });
    return { total, assigned, unassigned, packages };
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE
  // Rules:
  //   1. Name must be unique (matches MikroTik pool name exactly)
  //   2. Network must be a valid IPv4 address
  //   3. Subnet must be a number between 8 and 30
  //   4. No NAS required — NAS field is intentionally ignored
  // ─────────────────────────────────────────────────────────────
  /** Bulk import IP pools from a file. Subnet defaults to /24 if not supplied. */
  async importMany(rows: any[], actor?: Actor) {
    let success = 0, failed = 0;
    const errors: Array<{ index: number; name?: string; error: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      try {
        await this.create({ name: r.name, network: r.network, subnet: String(r.subnet || '24').replace('/', '').trim() }, actor);
        success++;
      } catch (e: any) {
        failed++;
        errors.push({ index: i, name: r.name, error: e?.message || 'Import failed' });
      }
    }
    return { total: rows.length, success, failed, errors };
  }

  async create(data: {
    name:    string;
    network: string;
    subnet:  string;
  }, actor?: Actor) {
    // ── Validate name
    if (!data.name || !data.name.trim()) {
      throw new BadRequestException('Pool name is required');
    }

    // ── Validate network (basic IPv4 check)
    if (!this.isValidIPv4(data.network)) {
      throw new BadRequestException(
        `Invalid network address "${data.network}". Use a valid IPv4 like 192.168.10.0`,
      );
    }

    // ── Validate subnet
    const subnetNum = parseInt(data.subnet);
    if (isNaN(subnetNum) || subnetNum < 8 || subnetNum > 30) {
      throw new BadRequestException('Subnet must be a number between 8 and 30');
    }

    const ownerId = actor ? this.scope.actorId(actor) : null;

    // Uniqueness is PER OWNER, not global. Two franchises running separate
    // networks will both have a "pppoe-pool" on their own routers, and one
    // must not block the other from creating theirs.
    const existing = await this.prisma.ipPool.findFirst({
      where: { name: data.name.trim(), ownerId },
    });
    if (existing) {
      throw new ConflictException(
        `You already have a pool named "${data.name}". Pool names must be unique within your own account.`,
      );
    }

    const pool = await this.prisma.ipPool.create({
      data: {
        name:    data.name.trim(),
        network: data.network.trim(),
        subnet:  data.subnet.trim(),
        nasId:   null,   // NAS not used in this system
        // Stamp the creator, or the pool falls out of every scoped query —
        // including its own creator's list.
        ownerId,
      },
      include: {
        packages: {
          select: { id: true, name: true, isActive: true },
        },
        _count: { select: { packages: true } },
      },
    });

    this.logger.log(
      `✅ IP Pool "${pool.name}" created — ${pool.network}/${pool.subnet}`,
    );
    return pool;
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE
  // Rules:
  //   1. Cannot rename to a name that already exists on another pool
  //   2. If pool is assigned to a package, warn but still allow edit
  //      (admin may need to fix a typo in the MikroTik name)
  //   3. NAS field is intentionally ignored
  // ─────────────────────────────────────────────────────────────
  async update(
    id: number,
    data: {
      name?:    string;
      network?: string;
      subnet?:  string;
    },
  ) {
    const existing = await this.prisma.ipPool.findUnique({
      where: { id },
      include: { _count: { select: { packages: true } } },
    });
    if (!existing) throw new NotFoundException(`IP Pool with ID ${id} not found`);

    // ── Validate network if provided
    if (data.network && !this.isValidIPv4(data.network)) {
      throw new BadRequestException(
        `Invalid network address "${data.network}". Use a valid IPv4 like 192.168.10.0`,
      );
    }

    // ── Validate subnet if provided
    if (data.subnet !== undefined) {
      const subnetNum = parseInt(data.subnet);
      if (isNaN(subnetNum) || subnetNum < 8 || subnetNum > 30) {
        throw new BadRequestException('Subnet must be a number between 8 and 30');
      }
    }

    // ── Check name uniqueness — only if name is actually changing.
    // findFirst, not findUnique: `name` alone is no longer a unique key. The
    // constraint is now [ownerId, name], so the clash we care about is another
    // pool belonging to THIS owner — a different franchise having the same
    // pool name on their own router is fine and expected.
    if (data.name && data.name.trim() !== existing.name) {
      const nameConflict = await this.prisma.ipPool.findFirst({
        where: {
          name: data.name.trim(),
          ownerId: existing.ownerId,
          id: { not: id },
        },
      });
      if (nameConflict) {
        throw new ConflictException(
          `You already have a pool named "${data.name}".`,
        );
      }
    }

    const pool = await this.prisma.ipPool.update({
      where: { id },
      data: {
        // Only update fields that were actually sent
        ...(data.name    !== undefined && { name:    data.name.trim()    }),
        ...(data.network !== undefined && { network: data.network.trim() }),
        ...(data.subnet  !== undefined && { subnet:  data.subnet.trim()  }),
        // nasId intentionally never updated
      },
      include: {
        packages: {
          select: { id: true, name: true, isActive: true },
        },
        _count: { select: { packages: true } },
      },
    });

    this.logger.log(`✅ IP Pool "${pool.name}" updated`);
    return pool;
  }

  // ─────────────────────────────────────────────────────────────
  // DELETE
  // Cannot delete if a package is still using this pool
  // ─────────────────────────────────────────────────────────────
  async remove(id: number) {
    const pool = await this.prisma.ipPool.findUnique({
      where: { id },
      include: {
        packages: { select: { id: true, name: true } },
        _count:   { select: { packages: true } },
      },
    });
    if (!pool) throw new NotFoundException(`IP Pool with ID ${id} not found`);

    if (pool._count.packages > 0) {
      const names = pool.packages.map(p => `"${p.name}"`).join(', ');
      throw new BadRequestException(
        `Cannot delete pool "${pool.name}" — it is still assigned to ${pool._count.packages} package(s): ${names}. ` +
        `Go to Packages, remove the pool assignment first, then delete.`,
      );
    }

    await this.prisma.ipPool.delete({ where: { id } });
    this.logger.log(`🗑️ IP Pool "${pool.name}" deleted`);
    return { deleted: true, id, name: pool.name };
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Check that a pool is not already assigned to another package
  // Called by PackagesService before assigning a poolId
  // ─────────────────────────────────────────────────────────────
  async checkPoolAvailable(poolId: number, excludePackageId?: number): Promise<void> {
    const pool = await this.prisma.ipPool.findUnique({
      where: { id: poolId },
      include: {
        packages: { select: { id: true, name: true } },
      },
    });

    if (!pool) {
      throw new NotFoundException(`IP Pool with ID ${poolId} not found`);
    }

    const conflictingPackage = pool.packages.find(
      (p) => p.id !== excludePackageId,
    );

    if (conflictingPackage) {
      throw new ConflictException(
        `IP Pool "${pool.name}" is already assigned to package "${conflictingPackage.name}". ` +
        `One pool can only be used by one package. Choose a different pool or unassign it from "${conflictingPackage.name}" first.`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // HELPER: Build the MikroTik range string
  // e.g. "192.168.10.0" + "24" → "192.168.10.1-192.168.10.254"
  // ─────────────────────────────────────────────────────────────
  buildRangeString(network: string, subnet: string): string {
    const parts  = network.split('.').map(Number);
    const prefix = parseInt(subnet);

    if (prefix === 24) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.1-${parts[0]}.${parts[1]}.${parts[2]}.254`;
    }
    if (prefix === 23) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.1-${parts[0]}.${parts[1]}.${parts[2] + 1}.254`;
    }
    if (prefix === 22) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.1-${parts[0]}.${parts[1]}.${parts[2] + 3}.254`;
    }
    if (prefix === 16) {
      return `${parts[0]}.${parts[1]}.0.1-${parts[0]}.${parts[1]}.255.254`;
    }
    // Generic fallback — works fine for /25 through /30
    const base = parts.slice(0, 3).join('.');
    return `${base}.1-${base}.${Math.pow(2, 32 - prefix) - 2}`;
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE: IPv4 validation
  // ─────────────────────────────────────────────────────────────
  private isValidIPv4(ip: string): boolean {
    if (!ip || !ip.trim()) return false;
    const parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every((p) => {
      const n = parseInt(p, 10);
      return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
    });
  }
}