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

  // ─────────────────────────────────────────────────────────────
  // AUDIT  — every package mutation lands in ActivityLog so the
  // detail drawer can show a real change history.
  // ─────────────────────────────────────────────────────────────
  private async audit(action: string, packageId: number, details: any, actor?: Actor) {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: actor ? this.scope.actorId(actor) : null,
          action,
          entity: 'Package',
          entityId: packageId,
          details: details ? JSON.stringify(details) : null,
        },
      });
    } catch (e) {
      console.error('Package audit log failed:', (e as Error)?.message || e);
    }
  }

  /**
   * Shared numeric validation for create/update. Throws BadRequestException on
   * unparseable, empty-required, or negative values; returns human-readable
   * warnings like "FUP speed is higher than the package speed" so the UI can
   * surface them without ever faking success.
   *
   * Semantics per key:
   *   - undefined            → untouched (update) / falls back to defaults (create)
   *   - null / ''            → clears a nullable field; ERROR for required fields
   *   - number / numeric str → validated and returned
   */
  private validateNumbers(
    data: any,
    existing?: any,
  ): { warnings: string[]; numbers: { [k: string]: number | null | undefined } } {
    const warnings: string[] = [];
    const required = new Set(['price', 'duration', 'downloadSpeed', 'uploadSpeed']);
    const keys = [
      'price', 'duration', 'downloadSpeed', 'uploadSpeed',
      'burstDownload', 'burstUpload', 'burstThreshold', 'burstTime',
      'dataQuotaGb', 'fupDownloadSpeed', 'fupUploadSpeed',
    ];

    const numbers: { [k: string]: number | null | undefined } = {};
    for (const key of keys) {
      const v = data[key];
      if (v === undefined) { numbers[key] = undefined; continue; }
      if (v === null || v === '') {
        if (required.has(key)) {
          throw new BadRequestException(`${key} cannot be empty`);
        }
        numbers[key] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`${key} must be a valid number, got "${v}"`);
      }
      numbers[key] = n;
    }

    const isNum = (v: any): v is number => typeof v === 'number';
    if (isNum(numbers.price) && numbers.price < 0) throw new BadRequestException('Price cannot be negative');
    if (isNum(numbers.downloadSpeed) && numbers.downloadSpeed <= 0) throw new BadRequestException('Download speed must be greater than 0');
    if (isNum(numbers.uploadSpeed) && numbers.uploadSpeed <= 0) throw new BadRequestException('Upload speed must be greater than 0');
    if (isNum(numbers.duration) && numbers.duration <= 0) throw new BadRequestException('Duration must be greater than 0');
    if (isNum(numbers.dataQuotaGb) && numbers.dataQuotaGb < 0) throw new BadRequestException('Data quota cannot be negative');

    // FUP sanity — throttling faster than the plan speed would never engage,
    // and a throttle with no quota would never trigger. Surface as warnings;
    // the editor shows them and still allows saving an explicit choice.
    const pick = (k: string): number | undefined =>
      isNum(numbers[k]) ? numbers[k]! : (existing ? existing[k] ?? undefined : undefined);
    const dl = pick('downloadSpeed');
    const ul = pick('uploadSpeed');
    const quota = pick('dataQuotaGb');
    const fupDl = pick('fupDownloadSpeed');
    const fupUl = pick('fupUploadSpeed');
    if (quota && fupDl && dl && fupDl > dl) {
      warnings.push(`FUP download speed (${fupDl} Mbps) is faster than the package speed (${dl} Mbps) — the throttle would never engage.`);
    }
    if (quota && fupUl && ul && fupUl > ul) {
      warnings.push(`FUP upload speed (${fupUl} Mbps) is faster than the package speed (${ul} Mbps) — the throttle would never engage.`);
    }
    if ((fupDl || fupUl) && !quota) {
      warnings.push('FUP speeds are set but there is no data quota — the throttle would never trigger.');
    }
    return { warnings, numbers };
  }

  /** Humanized FUP semantics; null quota = unlimited, quota without FUP speeds = not enforced (sweep only throttles packages with FUP speeds: fup.service filters package fupDownloadSpeed not null). */
  private fupInfo(pkg: any) {
    const quota = pkg.dataQuotaGb;
    const dl = pkg.fupDownloadSpeed;
    const ul = pkg.fupUploadSpeed;
    if (!quota) return { quotaGb: null, mode: 'UNLIMITED', download: null, upload: null, label: 'Unlimited (no quota)' };
    if (!dl && !ul) return { quotaGb: quota, mode: 'NO_THROTTLE', download: null, upload: null, label: `${quota} GB quota, no FUP speeds — not enforced by the sweep` };
    return { quotaGb: quota, mode: 'THROTTLE', download: dl, upload: ul, label: `${quota} GB then ↓${dl ?? '—'} ↑${ul ?? '—'} Mbps` };
  }

  /** Derive health/configuration checks from real package data. */
  private healthChecks(pkg: any, detail: { subscribers: number; resellers: number; hasPool: boolean }): any[] {
    const checks: any[] = [];
    if (!pkg.isActive) checks.push({ level: 'warn', code: 'INACTIVE', message: 'Package is deactivated — new sign-ups are blocked.' });
    if (detail.subscribers === 0) checks.push({ level: 'info', code: 'NO_SUBSCRIBERS', message: 'No subscribers are currently on this package.' });
    if (!detail.hasPool) checks.push({ level: 'warn', code: 'NO_POOL', message: 'No IP pool assigned — dynamic address assignment may fall back to the NAS default.' });
    if (!pkg.dataQuotaGb) checks.push({ level: 'info', code: 'NO_QUOTA', message: 'No data quota — usage is unlimited.' });
    const quota = pkg.dataQuotaGb;
    const dl = pkg.fupDownloadSpeed;
    const ul = pkg.fupUploadSpeed;
    if (quota && ((dl && dl > pkg.downloadSpeed) || (ul && ul > pkg.uploadSpeed))) {
      checks.push({ level: 'warn', code: 'FUP_ABOVE_PACKAGE', message: 'FUP speed is faster than the package speed — the throttle would never engage.' });
    }
    if ((dl || ul) && !quota) checks.push({ level: 'warn', code: 'FUP_NO_QUOTA', message: 'FUP speeds set without a data quota — the throttle would never trigger.' });
    if (!(pkg.settings?.policyIds?.length)) checks.push({ level: 'info', code: 'NO_POLICIES', message: 'No RADIUS policies linked — standard rate limit only.' });
    if (detail.resellers === 0) checks.push({ level: 'info', code: 'NO_RESELLERS', message: 'No reseller price assignments yet.' });
    return checks;
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
    const groupFilter = query?.group;
    const groupId = groupFilter && groupFilter !== 'ALL' && groupFilter !== 'UNGROUPED'
      ? Number(groupFilter)
      : null;

    // ⚡ Phase 0: DB hit cached for 30s (filters below run in-memory on the cached list)
    const packages = await this.cache.wrap('packages:list', 30, () =>
      this.prisma.package.findMany({
        orderBy: { price: 'asc' },
        include: {
          pool:   true,
          _count: { select: { subscribers: true } },
          accessGroups: { select: { groupId: true } },
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
        const groupPass = !groupFilter || groupFilter === 'ALL'
          ? true
          : groupFilter === 'UNGROUPED'
            ? (pkg.accessGroups?.length || 0) === 0
            : groupId !== null && pkg.accessGroups?.some((ag: any) => ag.groupId === groupId);

        return statusPass && searchPass && serviceTypePass && durationTypePass && groupPass;
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
  /** Loop-create for bulk import — validate-and-continue, report per-row errors. */
  async importMany(rows: any[]) {
    let success = 0, failed = 0;
    const errors: Array<{ index: number; name?: string; error: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        if (!rows[i]?.name) throw new Error('name is required');
        await this.create(rows[i]);
        success++;
      } catch (e: any) {
        failed++;
        errors.push({ index: i, name: rows[i]?.name, error: e?.message || 'Import failed' });
      }
    }
    return { total: rows.length, success, failed, errors };
  }

  async create(data: any, actor?: Actor) {
    const poolId = data.poolId ? parseInt(data.poolId) : null;

    // ── Numeric validation before anything hits the DB
    const { warnings, numbers } = this.validateNumbers(data);

    // ── One-pool-per-package check
    if (poolId) {
      await this.ipPoolService.checkPoolAvailable(poolId);
      // throws ConflictException if the pool is already taken
    }

    // Duplicate-name check — warn, don't hard-block, but make it visible.
    const nameClash = await this.prisma.package.findFirst({
      where: { name: { equals: data.name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (nameClash) {
      warnings.push(`A package named "${nameClash.name}" already exists (id ${nameClash.id}). Duplicate names confuse subscribers being assigned plans.`);
    }

    const created = await this.prisma.package.create({
      data: {
        name:           data.name,
        price:          numbers.price !== undefined && numbers.price !== null ? numbers.price
                          : (() => { throw new BadRequestException('Price is required'); })(),
        description:    data.description   || null,
        duration:       numbers.duration ?? 30,
        isActive:       data.isActive !== undefined ? data.isActive : true,

        // Speed fields (Mbps)
        downloadSpeed:  numbers.downloadSpeed ?? 10,
        uploadSpeed:    numbers.uploadSpeed ?? 5,
        burstDownload:  numbers.burstDownload ?? null,
        burstUpload:    numbers.burstUpload ?? null,
        burstThreshold: numbers.burstThreshold ?? null,
        burstTime:      numbers.burstTime ?? null,

        // FUP: allowance and the reduced speed applied once it is used up.
        // These live on the Package table (not just the settings store)
        // because the hourly enforcement sweep reads them straight from the
        // database — a value only in settings would never be enforced.
        dataQuotaGb:      numbers.dataQuotaGb ?? null,
        fupDownloadSpeed: numbers.fupDownloadSpeed ?? null,
        fupUploadSpeed:   numbers.fupUploadSpeed ?? null,

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
    await this.audit('PACKAGE_CREATE', created.id, {
      name: created.name, price: created.price, downloadSpeed: created.downloadSpeed,
      uploadSpeed: created.uploadSpeed, dataQuotaGb: created.dataQuotaGb, poolId,
      ...(warnings.length ? { warnings } : {}),
    }, actor);
    return {
      ...created,
      serviceType: settings.serviceType,
      durationType: settings.durationType,
      invoiceDescription: settings.invoiceDescription,
      dataQuotaGb: created.dataQuotaGb ?? settings.dataQuotaGb,
      settings,
      warnings,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE
  // If poolId changes, check the new pool is not taken by another package
  // ─────────────────────────────────────────────────────────────
  async update(id: number, data: any, actor?: Actor) {
    const existing = await this.prisma.package.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Package not found');

    // ── Numeric validation — undefined keys keep their current value
    const { warnings, numbers } = this.validateNumbers(data, existing);

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
        // Required, non-nullable fields: null was already rejected by
        // validateNumbers, so ?undefined here just satisfies TS.
        price:          numbers.price ?? undefined,
        description:    data.description,
        duration:       numbers.duration ?? undefined,
        isActive:       data.isActive,

        // Speed fields
        downloadSpeed:  numbers.downloadSpeed ?? undefined,
        uploadSpeed:    numbers.uploadSpeed ?? undefined,
        burstDownload:  numbers.burstDownload ?? undefined,
        burstUpload:    numbers.burstUpload ?? undefined,
        burstThreshold: numbers.burstThreshold ?? undefined,
        burstTime:      numbers.burstTime ?? undefined,

        // FUP — see create(). Mirrored onto the table so the sweep can read it.
        dataQuotaGb:      numbers.dataQuotaGb ?? undefined,
        fupDownloadSpeed: numbers.fupDownloadSpeed ?? undefined,
        fupUploadSpeed:   numbers.fupUploadSpeed ?? undefined,

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
    await this.audit('PACKAGE_UPDATE', id, {
      name: updated.name,
      changed: Object.keys(data).filter((k) => data[k] !== undefined),
      ...(warnings.length ? { warnings } : {}),
    }, actor);
    return {
      ...updated,
      serviceType: settings.serviceType,
      durationType: settings.durationType,
      invoiceDescription: settings.invoiceDescription,
      dataQuotaGb: updated.dataQuotaGb ?? settings.dataQuotaGb,
      settings,
      warnings,
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
    await this.audit('PACKAGE_DELETE', id, { name: deleted.name, price: deleted.price }, actor);
    return deleted;
  }

  // ─────────────────────────────────────────────────────────────
  // TOGGLE STATUS
  // ─────────────────────────────────────────────────────────────
  async toggleStatus(id: number, actor?: Actor) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    const next = await this.prisma.package.update({
      where: { id },
      data:  { isActive: !pkg.isActive },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });
    this.invalidateCache();
    await this.audit(next.isActive ? 'PACKAGE_ACTIVATE' : 'PACKAGE_ARCHIVE', id,
      { name: pkg.name, from: pkg.isActive, to: next.isActive }, actor);
    return next;
  }

  /**
   * Explicit archive: deactivates so existing subscribers keep running but no
   * new sign-ups are possible. The spec prefers Archive over permanent delete
   * for packages that are still in use; the UI disables delete in that case.
   */
  async archive(id: number, actor?: Actor) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    const updated = await this.prisma.package.update({
      where: { id },
      data:  { isActive: false },
      include: {
        pool:   true,
        _count: { select: { subscribers: true } },
      },
    });
    this.invalidateCache();
    await this.audit('PACKAGE_ARCHIVE', id, { name: pkg.name, subscribers: updated._count.subscribers }, actor);
    return updated;
  }

  async duplicate(id: number, actor?: Actor) {
    const original = await this.findOne(id);
    const nameClash = await this.prisma.package.findFirst({
      where: { name: { equals: `${original.name} (Copy)`, mode: 'insensitive' } },
      select: { id: true },
    });
    const copy = await this.create({
      name: nameClash ? `${original.name} (Copy ${Date.now().toString().slice(-4)})` : `${original.name} (Copy)`,
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
    }, actor);
    await this.audit('PACKAGE_DUPLICATE', copy.id,
      { fromPackageId: id, name: copy.name }, actor);
    return copy;
  }

  async subscribersByPackage(id: number, actor?: Actor) {
    const pkg = await this.prisma.package.findUnique({ where: { id } });
    if (!pkg) throw new NotFoundException('Package not found');
    // Scope to the caller's own customers (same rule as the table + stats).
    const where: any = { packageId: id };
    if (actor && !this.scope.isAdmin(actor.role)) {
      const own = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.userId = { in: own };
    }
    const [subs, total] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          username: true,
          phone: true,
          status: true,
          sellPrice: true,
          createdAt: true,
          serviceSettings: { select: { expiryDate: true, ipAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subscriber.count({ where }),
    ]);
    return { subscribers: subs, total };
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

  // ─────────────────────────────────────────────────────────────
  // OVERVIEW  — one real-data response for the package detail
  // screen: base plan + pricing chain + revenue + impact + audit.
  // No fabricated numbers: every figure is a DB or store query.
  // ─────────────────────────────────────────────────────────────
  async overview(id: number, actor?: Actor) {
    const pkg = await this.findOne(id);
    const settings: any = pkg.settings || {};
    const store = this.readStore();

    // Visibility: a non-admin may only open the drawer for a package they can
    // actually see/sell — same rule as the list (owns it or has a direct price
    // row). This stops a reseller from guessing ids to read other accounts'
    // reseller prices and revenue.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const visible = await this.scopeToActor([{ id }], actor);
      if (!visible.length) throw new NotFoundException('Package not found');
    }

    // Scope everything to the caller's own organisation (same as stats).
    const own = actor && !this.scope.isAdmin(actor.role)
      ? await this.scope.descendantIds(await this.scope.rootId(actor))
      : null;
    const subWhere: any = { packageId: id };
    if (own) subWhere.userId = { in: own };

    // ── Real revenue: what ACTIVE subscribers actually pay (sellPrice is the
    // per-subscriber price; list price is only a fallback — same rule as the
    // analytics packageMix so the product page can never disagree with reports).
    const revenueSubs = await this.prisma.subscriber.findMany({
      where: subWhere,
      select: { status: true, sellPrice: true },
    });
    const active = revenueSubs.filter((s) => s.status === 'ACTIVE');
    const monthlyRevenue = Math.round(
      active.reduce((sum, s) => sum + Number(s.sellPrice ?? pkg.price ?? 0), 0),
    );

    // ── Expiring-soon count (7-day window) from real service settings.
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [statusBreakdown, expiringSoon, resellerPrices, audit, impact] = await Promise.all([
      this.prisma.subscriber.groupBy({
        by: ['status'], where: subWhere, _count: { _all: true },
      }),
      this.prisma.subscriber.count({
        where: { ...subWhere, serviceSettings: { expiryDate: { gte: now, lte: soon } } },
      }),
      this.prisma.resellerPackagePrice.findMany({
        where: { packageId: id },
        select: {
          id: true, price: true, retailPrice: true, subresellerProfit: true,
          subscriberProfit: true, createdAt: true,
          user: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.activityLog.findMany({
        where: { entity: 'Package', entityId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, action: true, details: true, createdAt: true,
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
      (async () => {
        const [subscribers, resellers, groups] = await Promise.all([
          this.prisma.subscriber.count({ where: subWhere }),
          this.prisma.resellerPackagePrice.count({ where: { packageId: id } }),
          this.prisma.accessGroupPackage.count({ where: { packageId: id } }),
        ]);
        return { subscribers, resellers, groups };
      })(),
    ]);

    // ── Pricing chain from real data: base (list) + linked taxes/fees.
    const taxRows = (settings.taxIds || [])
      .map((tid: number) => store.taxes.find((t) => t.id === tid))
      .filter((t: any) => t && t.isActive);
    const basePrice = Number(pkg.price) || 0;
    let taxTotal = 0;
    const taxDetail = taxRows.map((t: any) => {
      let amount = 0;
      if (t.type === 'FIXED') amount = Number(t.value) || 0;
      else if (t.type === 'PERCENTAGE') amount = Math.round(basePrice * ((Number(t.value) || 0) / 100) * 100) / 100;
      taxTotal += amount;
      return { ...t, appliedAmount: amount };
    });
    const finalWithTax = Math.round((basePrice + taxTotal) * 100) / 100;

    const linkedPolicies = (settings.policyIds || [])
      .map((pid: number) => store.policies.find((p) => p.id === pid))
      .filter(Boolean);
    const linkedAllocations = (settings.allocationIds || [])
      .map((aid: number) => store.allocations.find((a) => a.id === aid))
      .filter(Boolean);

    // ── IP pool capacity is honest: subnet math gives capacity; "used" is the
    // subscriber count, which is an ESTIMATE of consumption (subscribers may
    // hold static IPs from elsewhere) — labelled as such.
    let pool: any = null;
    if (pkg.pool) {
      const subnet = Number(pkg.pool.subnet) || 24;
      pool = {
        ...pkg.pool,
        capacity: Math.pow(2, 32 - subnet) - 2,
        estimatedUsed: impact.subscribers,
        utilizationPct: impact.subscribers > 0
          ? Math.min(100, Math.round((impact.subscribers / (Math.pow(2, 32 - subnet) - 2)) * 1000) / 10)
          : 0,
        note: 'Used = subscribers on this package (estimate; static holders excluded).',
      };
    }

    // ── RADIUS preview mirrors the real sync: same rate-limit string the
    // radius-sync service writes (burst-aware), plus linked policy attributes.
    const dl = pkg.downloadSpeed; const ul = pkg.uploadSpeed;
    let rateLimit = `${dl}M/${ul}M`;
    if (pkg.burstDownload && pkg.burstUpload) {
      const bDl = pkg.burstDownload;
      const bUl = pkg.burstUpload;
      const bThr = pkg.burstThreshold ?? Math.floor(dl * 0.5);
      const bT = pkg.burstTime ?? 10;
      rateLimit = `${dl}M/${ul}M ${bDl}M/${bUl}M ${bThr}M/${bThr}M ${bT}`;
    }
    const radius = {
      rateLimit,
      poolName: pkg.pool?.name || null,
      policyAttributes: linkedPolicies.map((p: any) => ({
        attribute: p.attributeName, op: p.attributeOp, value: p.attributeValue,
      })),
      note: 'Preview: exactly what radius-sync writes on activation. Live enforcement is verified on the NAS, not assumed.',
    };

    const subStatus: any = { total: impact.subscribers };
    for (const row of statusBreakdown) subStatus[row.status] = row._count._all;

    const health = this.healthChecks(pkg, {
      subscribers: impact.subscribers, resellers: impact.resellers, hasPool: !!pkg.pool,
    });

    return {
      package: pkg,
      pricing: {
        basePrice, taxDetail, taxTotal: Math.round(taxTotal * 100) / 100,
        finalWithTax, resellerPrices, note: 'Reseller rows are buy/wholesale prices set per account; profit is theirs, not wallet credit.',
      },
      revenue: {
        monthlyRevenue, arpu: active.length ? Math.round(monthlyRevenue / active.length) : 0,
        active: active.length, note: 'ACTIVE subscribers × their actual sellPrice (fallback: list price).',
      },
      fup: this.fupInfo(pkg),
      pool,
      radius,
      impact: { ...impact, subStatus, expiringSoon, note: 'Who this package affects — shown before archive/delete.' },
      policies: linkedPolicies,
      allocations: linkedAllocations,
      audit,
      health,
      warnings: health.filter((c) => c.level === 'warn'),
    };
  }
}