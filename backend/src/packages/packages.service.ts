import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IpPoolService } from '../ip-pool/ip-pool.service';
import { CacheService } from '../common/cache.service';
import { ScopeService, Actor } from '../common/scope.service';
import { SecurityService } from '../security/security.service';
import * as fs from 'fs';
import * as path from 'path';

type TaxType = 'FIXED' | 'PERCENTAGE' | 'FORMULA';
type AttributeType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN';
type AttributeOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'CONTAINS';

interface PackageSettings {
  packageId: number;
  invoiceDescription?: string;
  serviceType?: 'RESIDENTIAL' | 'BUSINESS' | 'CORPORATE' | 'EDUCATIONAL' | 'GOVERNMENT';
  durationType?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';
  autoRenew?: boolean;
  allowReseller?: boolean;
  generateInvoice?: 'AUTOMATIC' | 'MANUAL';
  selfActivation?: boolean;
  carryLeftoverQuota?: boolean;
  carryLeftoverSessions?: boolean;
  customExpiryStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'EXPIRED';
  dataQuotaGb?: number;
  dataQuotaOver?: 'BLOCK' | 'THROTTLE' | 'NOTIFY';
  fupQuotaGb?: number;
  sessionQuotaMin?: number;
  sessionQuotaOver?: 'BLOCK' | 'NOTIFY';
  sessionFupQuotaMin?: number;
  expirationEnabled?: boolean;
  fixedExpireDay?: number;
  fixedExpireDayAcct?: number;
  fixedExpireTime?: string;
  nextExpiredPackageId?: number | null;
  nextDisabledPackageId?: number | null;
  taxIds?: number[];
  policyIds?: number[];
  allocationIds?: number[];
}

interface TaxFee {
  id: number;
  groupName: string;
  name: string;
  type: TaxType;
  value: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
}

interface PolicyRule {
  id: number;
  groupName: string;
  attributeName: string;
  attributeType: AttributeType;
  attributeOp: AttributeOp;
  attributeValue: string;
  description?: string;
  createdAt: string;
}

interface AllocationRule {
  id: number;
  groupName: string;
  isActive: boolean;
  days: string[];
  startTime: string;
  endTime: string;
  policyId?: number | null;
  description?: string;
  createdAt: string;
}

interface PackagesStore {
  packageSettings: PackageSettings[];
  taxes: TaxFee[];
  policies: PolicyRule[];
  allocations: AllocationRule[];
}

@Injectable()
export class PackagesService {
  private readonly storeFilePath = path.join(process.cwd(), 'data', 'packages-management.json');

  constructor(
    private prisma: PrismaService,
    private ipPoolService: IpPoolService,
    private cache: CacheService,
    private scope: ScopeService,
    private security: SecurityService,
  ) {}

  /** ⚡ Phase 0: drop cached package list after any mutation */
  private invalidateCache() {
    void this.cache.delPrefix('packages:');
  }

  private defaultStore(): PackagesStore {
    return {
      packageSettings: [],
      taxes: [],
      policies: [],
      allocations: [],
    };
  }

  private ensureStoreFile() {
    const dir = path.dirname(this.storeFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.storeFilePath)) {
      fs.writeFileSync(this.storeFilePath, JSON.stringify(this.defaultStore(), null, 2), 'utf-8');
    }
  }

  private readStore(): PackagesStore {
    this.ensureStoreFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFilePath, 'utf-8'));
      return {
        packageSettings: Array.isArray(parsed.packageSettings) ? parsed.packageSettings : [],
        taxes: Array.isArray(parsed.taxes) ? parsed.taxes : [],
        policies: Array.isArray(parsed.policies) ? parsed.policies : [],
        allocations: Array.isArray(parsed.allocations) ? parsed.allocations : [],
      };
    } catch {
      return this.defaultStore();
    }
  }

  private writeStore(store: PackagesStore) {
    this.ensureStoreFile();
    fs.writeFileSync(this.storeFilePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  private nextId(items: Array<{ id: number }>) {
    if (items.length === 0) return 1;
    return Math.max(...items.map((x) => x.id)) + 1;
  }

  private getPackageSettingById(packageId: number): PackageSettings | undefined {
    const store = this.readStore();
    return store.packageSettings.find((s) => s.packageId === packageId);
  }

  private upsertPackageSettings(packageId: number, payload: any): PackageSettings {
    const store = this.readStore();
    const index = store.packageSettings.findIndex((s) => s.packageId === packageId);
    const current = index >= 0 ? store.packageSettings[index] : { packageId };
    const next = {
      ...current,
      ...payload,
      packageId,
    };
    if (index >= 0) {
      store.packageSettings[index] = next;
    } else {
      store.packageSettings.push(next);
    }
    this.writeStore(store);
    return next;
  }

  // ─────────────────────────────────────────────────────────────
  // GET ALL  — includes pool so the frontend table shows pool name
  // ─────────────────────────────────────────────────────────────
  async findAll(query?: any, actor?: any) {
    const searchQ = (query?.q || '').trim().toLowerCase();
    const serviceType = query?.serviceType && query.serviceType !== 'ALL' ? String(query.serviceType) : null;
    const durationType = query?.durationType && query.durationType !== 'ALL' ? String(query.durationType) : null;

    // ⚡ Phase 0: DB hit cached for 30s (filters below run in-memory on the cached list)
    const packages = await this.cache.wrap('packages:list', 30, () =>
      this.prisma.package.findMany({
        orderBy: { price: 'asc' },
        include: {
          pool:   true,
          _count: { select: { subscribers: true } },
        },
      }),
    );

    const store = this.readStore();

    // Scope: a reseller sees packages it OWNS, plus every package sellable
    // anywhere UP its chain — once an ancestor is priced a package, the whole
    // subtree beneath can sell it. The buy price shown is the reseller's own
    // cost: their assigned price if set, otherwise the NEAREST priced ancestor's
    // cost (inherited), NOT the ISP base. This is why a retailer saw "No
    // packages" and never saw their buying price — visibility and cost both
    // required an explicit row for that exact account.
    let visible = packages;
    if (actor && !this.scope.isAdmin(actor.role)) {
      visible = await this.scopeToActor(packages, actor);
    }

    return visible
      .map((pkg) => {
        const settings = store.packageSettings.find((s) => s.packageId === pkg.id);
        return {
          ...pkg,
          serviceType: settings?.serviceType || 'RESIDENTIAL',
          durationType: settings?.durationType || 'MONTHLY',
          invoiceDescription: settings?.invoiceDescription || null,
          // The column is authoritative — it is what FUP enforcement reads.
          // The settings store is only a fallback for packages created before
          // the column existed.
          dataQuotaGb: pkg.dataQuotaGb ?? settings?.dataQuotaGb ?? null,
          settings,
        };
      })
      .filter((pkg) => {
        const statusPass =
          !query?.status ||
          query.status === 'ALL' ||
          (query.status === 'ACTIVE' && pkg.isActive) ||
          (query.status === 'INACTIVE' && !pkg.isActive);

        const searchPass =
          !searchQ ||
          pkg.name.toLowerCase().includes(searchQ) ||
          (pkg.description || '').toLowerCase().includes(searchQ) ||
          (pkg.serviceType || '').toLowerCase().includes(searchQ);

        const serviceTypePass = !serviceType || pkg.serviceType === serviceType;
        const durationTypePass = !durationType || pkg.durationType === durationType;

        return statusPass && searchPass && serviceTypePass && durationTypePass;
      });
  }

  // ─────────────────────────────────────────────────────────────
  // GET ONE
  // ─────────────────────────────────────────────────────────────
  async findOne(id: number) {
    const pkg = await this.prisma.package.findUnique({
      where: { id },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });
    if (!pkg) throw new NotFoundException('Package not found');
    const settings = this.getPackageSettingById(id);
    return {
      ...pkg,
      serviceType: settings?.serviceType || 'RESIDENTIAL',
      durationType: settings?.durationType || 'MONTHLY',
      invoiceDescription: settings?.invoiceDescription || null,
      dataQuotaGb: pkg.dataQuotaGb ?? settings?.dataQuotaGb ?? null,
      settings: settings || null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────
  /**
   * A reseller sees packages it OWNS plus any priced anywhere up its chain; the
   * displayed price is its inherited cost. Shared by findAll() and getStats() so
   * the stat cards can never disagree with the list. The ISP passes through.
   */
  /**
   * Restrict the visible package list to packages EXPLICITLY shared with this
   * account — either the account owns the package (created it) or it has a
   * direct ResellerPackagePrice row assigned to it. Packages inherited from
   * an ancestor are not shown until the ancestor explicitly assigns them.
   *
   * The assignment endpoint /users/:id/packages keeps the ancestor-chain
   * lookup because upstream account holders need to see what they _can_ assign
   * to a downstream account. This function controls what the downstream account
   * itself may see and sell — and that should only be what has been explicitly
   * shared with them.
   */
  private async scopeToActor(packages: any[], actor: any): Promise<any[]> {
    const meId = this.scope.actorId(actor);
    // Only check the user's OWN ResellerPackagePrice rows — no ancestor inheritance.
    const rows = await this.prisma.resellerPackagePrice.findMany({
      where: { userId: meId },
      select: { packageId: true, price: true },
    });
    const buyByPkg = new Map(rows.map((r) => [r.packageId, r.price]));
    return packages
      .filter((p: any) => buyByPkg.has(p.id) || p.ownerId === meId)
      .map((p: any) => ({ ...p, price: buyByPkg.get(p.id) ?? p.price }));
  }

  async getStats(actor?: any) {
    // Scope the cards to what the caller can actually see — otherwise a retailer
    // saw "2 packages" while the list correctly showed none.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const all = await this.prisma.package.findMany({ select: { id: true, isActive: true, ownerId: true } });
      const visible = await this.scopeToActor(all, actor);
      const ids = visible.map((p: any) => p.id);
      const active = visible.filter((p: any) => p.isActive).length;
      const subIds = await this.scope.descendantIds(await this.scope.rootId(actor));
      const totalSubscribers = ids.length
        ? await this.prisma.subscriber.count({ where: { packageId: { in: ids }, userId: { in: subIds } } })
        : 0;
      return { total: visible.length, active, inactive: visible.length - active, totalSubscribers };
    }
    const total    = await this.prisma.package.count();
    const active   = await this.prisma.package.count({ where: { isActive: true } });
    const inactive = await this.prisma.package.count({ where: { isActive: false } });
    const totalSubscribers = await this.prisma.subscriber.count({
      where: { packageId: { not: null } },
    });
    return { total, active, inactive, totalSubscribers };
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE
  // If a poolId is sent, we verify:
  //   1. The pool exists
  //   2. The pool is not already assigned to another package
  // ─────────────────────────────────────────────────────────────
  async create(data: any) {
    const poolId = data.poolId ? parseInt(data.poolId) : null;

    // ── One-pool-per-package check
    if (poolId) {
      await this.ipPoolService.checkPoolAvailable(poolId);
      // throws ConflictException if the pool is already taken
    }

    const created = await this.prisma.package.create({
      data: {
        name:           data.name,
        price:          parseFloat(data.price),
        description:    data.description   || null,
        duration:       data.duration      ? parseInt(data.duration)      : 30,
        isActive:       data.isActive !== undefined ? data.isActive : true,

        // Speed fields (Mbps)
        downloadSpeed:  data.downloadSpeed  ? parseInt(data.downloadSpeed)  : 10,
        uploadSpeed:    data.uploadSpeed    ? parseInt(data.uploadSpeed)    : 5,
        burstDownload:  data.burstDownload  ? parseInt(data.burstDownload)  : null,
        burstUpload:    data.burstUpload    ? parseInt(data.burstUpload)    : null,
        burstThreshold: data.burstThreshold ? parseInt(data.burstThreshold) : null,
        burstTime:      data.burstTime      ? parseInt(data.burstTime)      : null,

        // FUP: allowance and the reduced speed applied once it is used up.
        // These live on the Package table (not just the settings store)
        // because the hourly enforcement sweep reads them straight from the
        // database — a value only in settings would never be enforced.
        dataQuotaGb:      data.dataQuotaGb      ? parseInt(data.dataQuotaGb)      : null,
        fupDownloadSpeed: data.fupDownloadSpeed ? parseInt(data.fupDownloadSpeed) : null,
        fupUploadSpeed:   data.fupUploadSpeed   ? parseInt(data.fupUploadSpeed)   : null,

        // Pool relation
        poolId,
      },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });

    const settings = this.upsertPackageSettings(created.id, {
      invoiceDescription: data.invoiceDescription || null,
      serviceType: data.serviceType || 'RESIDENTIAL',
      durationType: data.durationType || 'MONTHLY',
      autoRenew: data.autoRenew === true || data.autoRenew === 'true',
      allowReseller: data.allowReseller === true || data.allowReseller === 'true',
      generateInvoice: data.generateInvoice || 'AUTOMATIC',
      selfActivation: data.selfActivation === true || data.selfActivation === 'true',
      carryLeftoverQuota: data.carryLeftoverQuota === true || data.carryLeftoverQuota === 'true',
      carryLeftoverSessions: data.carryLeftoverSessions === true || data.carryLeftoverSessions === 'true',
      customExpiryStatus: data.customExpiryStatus || 'ACTIVE',
      dataQuotaGb: data.dataQuotaGb !== undefined ? Number(data.dataQuotaGb) : null,
      dataQuotaOver: data.dataQuotaOver || 'NOTIFY',
      fupQuotaGb: data.fupQuotaGb !== undefined ? Number(data.fupQuotaGb) : null,
      sessionQuotaMin: data.sessionQuotaMin !== undefined ? Number(data.sessionQuotaMin) : null,
      sessionQuotaOver: data.sessionQuotaOver || 'NOTIFY',
      sessionFupQuotaMin: data.sessionFupQuotaMin !== undefined ? Number(data.sessionFupQuotaMin) : null,
      expirationEnabled: data.expirationEnabled === true || data.expirationEnabled === 'true',
      fixedExpireDay: data.fixedExpireDay !== undefined ? Number(data.fixedExpireDay) : null,
      fixedExpireDayAcct: data.fixedExpireDayAcct !== undefined ? Number(data.fixedExpireDayAcct) : null,
      fixedExpireTime: data.fixedExpireTime || null,
      nextExpiredPackageId: data.nextExpiredPackageId !== undefined && data.nextExpiredPackageId !== null && data.nextExpiredPackageId !== '' ? Number(data.nextExpiredPackageId) : null,
      nextDisabledPackageId: data.nextDisabledPackageId !== undefined && data.nextDisabledPackageId !== null && data.nextDisabledPackageId !== '' ? Number(data.nextDisabledPackageId) : null,
      taxIds: Array.isArray(data.taxIds) ? data.taxIds.map(Number) : [],
      policyIds: Array.isArray(data.policyIds) ? data.policyIds.map(Number) : [],
      allocationIds: Array.isArray(data.allocationIds) ? data.allocationIds.map(Number) : [],
    });

    this.invalidateCache();
    return {
      ...created,
      serviceType: settings.serviceType,
      durationType: settings.durationType,
      invoiceDescription: settings.invoiceDescription,
      dataQuotaGb: created.dataQuotaGb ?? settings.dataQuotaGb,
      settings,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE
  // If poolId changes, check the new pool is not taken by another package
  // ─────────────────────────────────────────────────────────────
  async update(id: number, data: any) {
    const existing = await this.prisma.package.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Package not found');

    // Determine the new poolId (undefined = don't change, null = remove, number = assign)
    let poolId: number | null | undefined = undefined;
    if (data.poolId !== undefined) {
      poolId = data.poolId ? parseInt(data.poolId) : null;
    }

    // ── One-pool-per-package check (exclude self so editing without changing pool works)
    if (poolId) {
      await this.ipPoolService.checkPoolAvailable(poolId, id);
      // throws ConflictException if the pool is already taken by a DIFFERENT package
    }

    const updated = await this.prisma.package.update({
      where: { id },
      data: {
        name:           data.name,
        price:          data.price          !== undefined ? parseFloat(data.price)          : undefined,
        description:    data.description,
        duration:       data.duration       !== undefined ? parseInt(data.duration)         : undefined,
        isActive:       data.isActive,

        // Speed fields
        downloadSpeed:  data.downloadSpeed  !== undefined ? parseInt(data.downloadSpeed)  : undefined,
        uploadSpeed:    data.uploadSpeed    !== undefined ? parseInt(data.uploadSpeed)    : undefined,
        burstDownload:  data.burstDownload  !== undefined ? (data.burstDownload ? parseInt(data.burstDownload) : null) : undefined,
        burstUpload:    data.burstUpload    !== undefined ? (data.burstUpload   ? parseInt(data.burstUpload)   : null) : undefined,
        burstThreshold: data.burstThreshold !== undefined ? (data.burstThreshold ? parseInt(data.burstThreshold) : null) : undefined,
        burstTime:      data.burstTime      !== undefined ? (data.burstTime      ? parseInt(data.burstTime)      : null) : undefined,

        // FUP — see create(). Mirrored onto the table so the sweep can read it.
        dataQuotaGb:      data.dataQuotaGb      !== undefined ? (data.dataQuotaGb      ? parseInt(data.dataQuotaGb)      : null) : undefined,
        fupDownloadSpeed: data.fupDownloadSpeed !== undefined ? (data.fupDownloadSpeed ? parseInt(data.fupDownloadSpeed) : null) : undefined,
        fupUploadSpeed:   data.fupUploadSpeed   !== undefined ? (data.fupUploadSpeed   ? parseInt(data.fupUploadSpeed)   : null) : undefined,

        // Pool relation
        ...(poolId !== undefined && { poolId }),
      },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });

    const settings = this.upsertPackageSettings(id, {
      invoiceDescription: data.invoiceDescription,
      serviceType: data.serviceType,
      durationType: data.durationType,
      autoRenew: data.autoRenew,
      allowReseller: data.allowReseller,
      generateInvoice: data.generateInvoice,
      selfActivation: data.selfActivation,
      carryLeftoverQuota: data.carryLeftoverQuota,
      carryLeftoverSessions: data.carryLeftoverSessions,
      customExpiryStatus: data.customExpiryStatus,
      dataQuotaGb: data.dataQuotaGb !== undefined ? Number(data.dataQuotaGb) : undefined,
      dataQuotaOver: data.dataQuotaOver,
      fupQuotaGb: data.fupQuotaGb !== undefined ? Number(data.fupQuotaGb) : undefined,
      sessionQuotaMin: data.sessionQuotaMin !== undefined ? Number(data.sessionQuotaMin) : undefined,
      sessionQuotaOver: data.sessionQuotaOver,
      sessionFupQuotaMin: data.sessionFupQuotaMin !== undefined ? Number(data.sessionFupQuotaMin) : undefined,
      expirationEnabled: data.expirationEnabled,
      fixedExpireDay: data.fixedExpireDay !== undefined ? Number(data.fixedExpireDay) : undefined,
      fixedExpireDayAcct: data.fixedExpireDayAcct !== undefined ? Number(data.fixedExpireDayAcct) : undefined,
      fixedExpireTime: data.fixedExpireTime,
      nextExpiredPackageId:
        data.nextExpiredPackageId !== undefined
          ? data.nextExpiredPackageId === null || data.nextExpiredPackageId === ''
            ? null
            : Number(data.nextExpiredPackageId)
          : undefined,
      nextDisabledPackageId:
        data.nextDisabledPackageId !== undefined
          ? data.nextDisabledPackageId === null || data.nextDisabledPackageId === ''
            ? null
            : Number(data.nextDisabledPackageId)
          : undefined,
      taxIds: Array.isArray(data.taxIds) ? data.taxIds.map(Number) : undefined,
      policyIds: Array.isArray(data.policyIds) ? data.policyIds.map(Number) : undefined,
      allocationIds: Array.isArray(data.allocationIds) ? data.allocationIds.map(Number) : undefined,
    });

    this.invalidateCache();
    return {
      ...updated,
      serviceType: settings.serviceType,
      durationType: settings.durationType,
      invoiceDescription: settings.invoiceDescription,
      dataQuotaGb: updated.dataQuotaGb ?? settings.dataQuotaGb,
      settings,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────────────────────
  async remove(id: number, actor?: Actor) {
    if (actor) {
      await this.security.assertCan(actor, 'packages.delete');
    }

    const existing = await this.prisma.package.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Package not found');

    /**
     * Refuse to delete a package that is still in service.
     *
     * There was no check at all. Deleting a package with live subscribers on it
     * either cascades them away or breaks the foreign key — and every one of
     * those customers is a paying connection whose plan, speed and billing
     * basis just vanished. It also destroys the reseller price rows underneath,
     * so the whole downline's cost for that plan disappears with it.
     *
     * Deactivating is almost always what was meant: existing customers keep
     * running, nobody new can be put on it.
     */
    const inUse = await this.prisma.subscriber.count({ where: { packageId: id } });
    if (inUse > 0) {
      throw new BadRequestException(
        `${existing.name} still has ${inUse} subscriber(s) on it and cannot be deleted. ` +
        `Switch them to another package first, or deactivate this one instead — ` +
        `deactivating keeps existing customers running and stops new sign-ups.`,
      );
    }

    const resold = await this.prisma.resellerPackagePrice.count({ where: { packageId: id } });
    if (resold > 0) {
      throw new BadRequestException(
        `${existing.name} is assigned to ${resold} reseller account(s) with agreed prices. ` +
        `Remove those price assignments first, or deactivate the package instead.`,
      );
    }

    const deleted = await this.prisma.package.delete({ where: { id } });
    const store = this.readStore();
    store.packageSettings = store.packageSettings.filter((s) => s.packageId !== id);
    this.writeStore(store);
    this.invalidateCache();
    return deleted;
  }

  // ─────────────────────────────────────────────────────────────
  // TOGGLE STATUS
  // ─────────────────────────────────────────────────────────────
  async toggleStatus(id: number) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    this.invalidateCache();
    return this.prisma.package.update({
      where: { id },
      data:  { isActive: !pkg.isActive },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });
  }

  async duplicate(id: number) {
    const original = await this.findOne(id);
    const copy = await this.create({
      name: `${original.name} (Copy)`,
      price: original.price,
      description: original.description,
      duration: original.duration,
      isActive: false,
      downloadSpeed: original.downloadSpeed,
      uploadSpeed: original.uploadSpeed,
      dataQuotaGb: original.dataQuotaGb,
      fupDownloadSpeed: original.fupDownloadSpeed,
      fupUploadSpeed: original.fupUploadSpeed,
      burstDownload: original.burstDownload,
      burstUpload: original.burstUpload,
      burstThreshold: original.burstThreshold,
      burstTime: original.burstTime,
      poolId: original.poolId,
      ...(original as any).settings,
    });
    return copy;
  }

  async subscribersByPackage(id: number) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    return this.prisma.subscriber.findMany({
      where: { packageId: id },
      select: {
        id: true,
        fullName: true,
        username: true,
        phone: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  getTaxes() {
    return this.readStore().taxes;
  }

  createTax(payload: any) {
    const store = this.readStore();
    const tax: TaxFee = {
      id: this.nextId(store.taxes),
      groupName: payload.groupName || 'Default',
      name: payload.name,
      type: payload.type || 'FIXED',
      value: String(payload.value ?? ''),
      description: payload.description || '',
      isActive: payload.isActive !== false,
      createdAt: new Date().toISOString(),
    };
    store.taxes.push(tax);
    this.writeStore(store);
    return tax;
  }

  updateTax(id: number, payload: any) {
    const store = this.readStore();
    const idx = store.taxes.findIndex((t) => t.id === id);
    if (idx < 0) throw new NotFoundException('Tax/Fee not found');
    store.taxes[idx] = { ...store.taxes[idx], ...payload };
    this.writeStore(store);
    return store.taxes[idx];
  }

  deleteTax(id: number) {
    const store = this.readStore();
    const exists = store.taxes.some((t) => t.id === id);
    if (!exists) throw new NotFoundException('Tax/Fee not found');
    store.taxes = store.taxes.filter((t) => t.id !== id);
    store.packageSettings = store.packageSettings.map((s) => ({
      ...s,
      taxIds: (s.taxIds || []).filter((x) => x !== id),
    }));
    this.writeStore(store);
    return { success: true };
  }

  getPolicies() {
    return this.readStore().policies;
  }

  createPolicy(payload: any) {
    const store = this.readStore();
    const policy: PolicyRule = {
      id: this.nextId(store.policies),
      groupName: payload.groupName || 'Default',
      attributeName: payload.attributeName,
      attributeType: payload.attributeType || 'TEXT',
      attributeOp: payload.attributeOp || '=',
      attributeValue: String(payload.attributeValue ?? ''),
      description: payload.description || '',
      createdAt: new Date().toISOString(),
    };
    store.policies.push(policy);
    this.writeStore(store);
    return policy;
  }

  updatePolicy(id: number, payload: any) {
    const store = this.readStore();
    const idx = store.policies.findIndex((p) => p.id === id);
    if (idx < 0) throw new NotFoundException('Policy not found');
    store.policies[idx] = { ...store.policies[idx], ...payload };
    this.writeStore(store);
    return store.policies[idx];
  }

  deletePolicy(id: number) {
    const store = this.readStore();
    const exists = store.policies.some((p) => p.id === id);
    if (!exists) throw new NotFoundException('Policy not found');
    store.policies = store.policies.filter((p) => p.id !== id);
    store.allocations = store.allocations.map((a) => ({
      ...a,
      policyId: a.policyId === id ? null : a.policyId,
    }));
    store.packageSettings = store.packageSettings.map((s) => ({
      ...s,
      policyIds: (s.policyIds || []).filter((x) => x !== id),
    }));
    this.writeStore(store);
    return { success: true };
  }

  getAllocations() {
    return this.readStore().allocations;
  }

  createAllocation(payload: any) {
    const store = this.readStore();
    const allocation: AllocationRule = {
      id: this.nextId(store.allocations),
      groupName: payload.groupName || 'Default',
      isActive: payload.isActive !== false,
      days: Array.isArray(payload.days) ? payload.days : [],
      startTime: payload.startTime || '00:00',
      endTime: payload.endTime || '23:59',
      policyId: payload.policyId ? Number(payload.policyId) : null,
      description: payload.description || '',
      createdAt: new Date().toISOString(),
    };
    store.allocations.push(allocation);
    this.writeStore(store);
    return allocation;
  }

  updateAllocation(id: number, payload: any) {
    const store = this.readStore();
    const idx = store.allocations.findIndex((a) => a.id === id);
    if (idx < 0) throw new NotFoundException('Allocation not found');
    store.allocations[idx] = {
      ...store.allocations[idx],
      ...payload,
      policyId:
        payload.policyId !== undefined
          ? payload.policyId === null || payload.policyId === ''
            ? null
            : Number(payload.policyId)
          : store.allocations[idx].policyId,
    };
    this.writeStore(store);
    return store.allocations[idx];
  }

  deleteAllocation(id: number) {
    const store = this.readStore();
    const exists = store.allocations.some((a) => a.id === id);
    if (!exists) throw new NotFoundException('Allocation not found');
    store.allocations = store.allocations.filter((a) => a.id !== id);
    store.packageSettings = store.packageSettings.map((s) => ({
      ...s,
      allocationIds: (s.allocationIds || []).filter((x) => x !== id),
    }));
    this.writeStore(store);
    return { success: true };
  }

  getManagementOptions() {
    const store = this.readStore();
    return {
      taxes: store.taxes,
      policies: store.policies,
      allocations: store.allocations,
    };
  }
}