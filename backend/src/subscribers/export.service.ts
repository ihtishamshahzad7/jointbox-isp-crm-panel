import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import {
  PANEL_COLUMNS, CONNECTION_TYPE_CODE, PROFILE_STATUS_CODE, DISCOUNT_TYPE_CODE,
  formatPanelDate, flag, str, num,
} from './panel-format';

/**
 * ExportService — filtered subscriber extracts.
 *
 * WHY
 * The previous export took the current list and dumped fourteen fixed columns.
 * The real questions are narrower: "all 50 Mb customers under Dealer 1",
 * "everyone in Chitral expiring this week", "who is on the old package so we
 * can migrate them". Answering those meant exporting everything and filtering
 * in Excel, which defeats the point.
 *
 * Every filter is optional and they AND together, so conditions can be stacked
 * to whatever precision the question needs.
 */

export type ExportFilters = {
  packageIds?: number[];      // "all 50 Mb users"
  ownerIds?: number[];        // "...under Dealer 1"
  areaIds?: number[];
  nasIds?: number[];
  statuses?: string[];
  authMethods?: string[];
  connectionTypes?: string[];
  expiringWithinDays?: number;
  expiredOnly?: boolean;
  createdFrom?: string;
  createdTo?: string;
  onlineOnly?: boolean;
  offlineOnly?: boolean;
  hasStaticIp?: boolean;
  withoutCnic?: boolean;
  search?: string;
  columns?: string[];
  limit?: number;
};

/** Every field that can be exported, with the header used in the file. */
export const EXPORT_COLUMNS: Array<{ key: string; header: string; group: string }> = [
  { key: 'id',             header: 'ID',                group: 'Identity' },
  { key: 'fullName',       header: 'Full Name',         group: 'Identity' },
  { key: 'username',       header: 'Username',          group: 'Identity' },
  { key: 'password',       header: 'Password',          group: 'Identity' },
  { key: 'phone',          header: 'Phone',             group: 'Identity' },
  { key: 'email',          header: 'Email',             group: 'Identity' },
  { key: 'cnic',           header: 'CNIC',              group: 'Identity' },
  { key: 'address',        header: 'Address',           group: 'Identity' },

  { key: 'status',         header: 'Status',            group: 'Service' },
  { key: 'package',        header: 'Package',           group: 'Service' },
  { key: 'packagePrice',   header: 'Package Price',     group: 'Service' },
  { key: 'sellPrice',      header: 'Sell Price',        group: 'Service' },
  { key: 'speed',          header: 'Speed',             group: 'Service' },
  { key: 'authMethod',     header: 'Auth Method',       group: 'Service' },
  { key: 'connectionType', header: 'Connection Type',   group: 'Service' },
  { key: 'expiryDate',     header: 'Expiry Date',       group: 'Service' },
  { key: 'daysLeft',       header: 'Days Left',         group: 'Service' },

  { key: 'owner',          header: 'Owner / Dealer',    group: 'Network' },
  { key: 'ownerRole',      header: 'Owner Role',        group: 'Network' },
  { key: 'area',           header: 'Area',              group: 'Network' },
  { key: 'city',           header: 'City',              group: 'Network' },
  { key: 'nas',            header: 'Router',            group: 'Network' },
  { key: 'ipAddress',      header: 'IP Address',        group: 'Network' },
  { key: 'ipType',         header: 'IP Type',           group: 'Network' },
  { key: 'vlanId',         header: 'VLAN',              group: 'Network' },
  { key: 'macAddress',     header: 'MAC Address',       group: 'Network' },
  { key: 'online',         header: 'Online Now',        group: 'Network' },

  { key: 'balance',        header: 'Balance',           group: 'Billing' },
  { key: 'salesperson',    header: 'Salesperson',       group: 'Billing' },
  { key: 'installationDate', header: 'Installed On',    group: 'Billing' },
  { key: 'createdAt',      header: 'Created On',        group: 'Billing' },
];

const DEFAULT_COLUMNS = [
  'fullName', 'username', 'phone', 'status', 'package',
  'owner', 'area', 'expiryDate', 'daysLeft', 'online',
];

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  private async buildWhere(f: ExportFilters, actor?: Actor) {
    const where: any = {};

    // Scope first — a dealer must never be able to widen their way out of it
    // by passing ownerIds for accounts above them.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const allowed = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.userId = f.ownerIds?.length
        ? { in: f.ownerIds.filter((id) => allowed.includes(id)) }
        : { in: allowed };
    } else if (f.ownerIds?.length) {
      where.userId = { in: f.ownerIds };
    }

    if (f.packageIds?.length) where.packageId = { in: f.packageIds };
    if (f.areaIds?.length) where.areaId = { in: f.areaIds };
    if (f.nasIds?.length) where.nasId = { in: f.nasIds };
    if (f.statuses?.length) where.status = { in: f.statuses };
    if (f.authMethods?.length) where.authMethod = { in: f.authMethods };
    if (f.connectionTypes?.length) where.connectionType = { in: f.connectionTypes };
    if (f.withoutCnic) where.cnicNumber = null;

    if (f.createdFrom || f.createdTo) {
      where.createdAt = {};
      if (f.createdFrom) where.createdAt.gte = new Date(f.createdFrom);
      if (f.createdTo) where.createdAt.lte = new Date(f.createdTo);
    }

    // Expiry lives on the related settings row, so it is filtered there.
    if (f.expiredOnly) {
      where.serviceSettings = { is: { expiryDate: { lt: new Date() } } };
    } else if (f.expiringWithinDays != null) {
      const until = new Date();
      until.setDate(until.getDate() + Number(f.expiringWithinDays));
      where.serviceSettings = { is: { expiryDate: { gte: new Date(), lte: until } } };
    }

    if (f.hasStaticIp) where.staticIps = { some: {} };

    if (f.search) {
      const q = String(f.search).trim();
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
        { cnicNumber: { contains: q.replace(/\D/g, '') } },
      ];
    }

    return where;
  }

  /** Count only — powers the "this will export N subscribers" preview. */
  async preview(filters: ExportFilters, actor?: Actor) {
    const where = await this.buildWhere(filters, actor);
    const total = await this.prisma.subscriber.count({ where });
    return { total };
  }

  /** The rows themselves, shaped for a spreadsheet. */
  async run(filters: ExportFilters, actor?: Actor) {
    const where = await this.buildWhere(filters, actor);
    let columns = filters.columns?.length ? filters.columns : DEFAULT_COLUMNS;

    // Bulk credential extraction is restricted to the ISP owner.
    //
    // A dealer legitimately sees one customer's password on the subscriber
    // page when resetting a connection. Exporting every PPPoE credential in
    // their tree to a spreadsheet is a different act: it is the whole point of
    // an insider walking off with the customer base. Silently dropping the
    // column keeps the export working rather than failing the whole request.
    if (columns.includes('password') && actor && !this.scope.isAdmin(actor.role)) {
      columns = columns.filter((c) => c !== 'password');
      this.logger.warn(
        `Password column stripped from export by ${this.scope.actorId(actor)} — ISP owner only.`,
      );
    }

    // Every export is recorded. If a customer list turns up at a competitor,
    // this is the trail that says who took it and exactly what they took.
    await this.prisma.activityLog.create({
      data: {
        action: 'SUBSCRIBER_EXPORT',
        entity: 'Subscriber',
        details:
          `Exported columns [${columns.join(', ')}]` +
          (filters.packageIds?.length ? ` · packages ${filters.packageIds.join(',')}` : '') +
          (filters.ownerIds?.length ? ` · owners ${filters.ownerIds.join(',')}` : '') +
          (filters.search ? ` · search "${filters.search}"` : ''),
        userId: actor ? this.scope.actorId(actor) : null,
      },
    }).catch(() => null);

    const subs = await this.prisma.subscriber.findMany({
      where,
      include: {
        package: { select: { name: true, price: true, downloadSpeed: true, uploadSpeed: true } },
        area: { select: { name: true, city: true } },
        nas: { select: { nasname: true } },
        user: { select: { name: true, role: true } },
        salesperson: { select: { name: true } },
        serviceSettings: true,
        staticIps: { select: { ipAddress: true }, take: 1 },
      },
      orderBy: [{ userId: 'asc' }, { fullName: 'asc' }],
      take: Math.min(Number(filters.limit) || 10000, 50000),
    });

    // Live online state is only fetched when the column was asked for — it is
    // a separate query against accounting and pointless otherwise.
    let live = new Set<string>();
    if (columns.includes('online') && subs.length) {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT DISTINCT username FROM radacct WHERE acctstoptime IS NULL`,
      ).catch(() => [] as any[]);
      live = new Set(rows.map((r) => r.username));
    }

    const now = Date.now();
    const value = (s: any, key: string): any => {
      switch (key) {
        case 'id': return s.id;
        case 'fullName': return s.fullName;
        case 'username': return s.username;
        case 'password': return s.password;
        case 'phone': return s.phone;
        case 'email': return s.email ?? '';
        case 'cnic': return s.cnicNumber
          ? `${s.cnicNumber.slice(0, 5)}-${s.cnicNumber.slice(5, 12)}-${s.cnicNumber.slice(12)}` : '';
        case 'address': return s.address ?? '';
        case 'status': return s.status;
        case 'package': return s.package?.name ?? '';
        case 'packagePrice': return s.package?.price ?? '';
        case 'sellPrice': return s.sellPrice ?? s.package?.price ?? '';
        case 'speed': return s.package ? `${s.package.downloadSpeed}/${s.package.uploadSpeed} Mbps` : '';
        case 'authMethod': return s.authMethod;
        case 'connectionType': return s.connectionType;
        case 'expiryDate': return s.serviceSettings?.expiryDate ?? '';
        case 'daysLeft': {
          const e = s.serviceSettings?.expiryDate;
          return e ? Math.ceil((new Date(e).getTime() - now) / 86400_000) : '';
        }
        case 'owner': return s.user?.name ?? 'Direct (ISP)';
        case 'ownerRole': return s.user?.role ?? '';
        case 'area': return s.area?.name ?? '';
        case 'city': return s.area?.city ?? '';
        case 'nas': return s.nas?.nasname ?? '';
        case 'ipAddress': return s.staticIps?.[0]?.ipAddress ?? s.serviceSettings?.ipAddress ?? '';
        case 'ipType': return s.staticIps?.length ? 'STATIC' : s.serviceSettings?.ipType ?? '';
        case 'vlanId': return s.serviceSettings?.vlanId ?? '';
        case 'macAddress': return s.serviceSettings?.macAddress ?? '';
        case 'online': return s.username && live.has(s.username) ? 'Yes' : 'No';
        case 'balance': return s.balance ?? 0;
        case 'salesperson': return s.salesperson?.name ?? '';
        case 'installationDate': return s.installationDate ?? '';
        case 'createdAt': return s.createdAt;
        default: return '';
      }
    };

    const headers = columns.map(
      (k) => EXPORT_COLUMNS.find((c) => c.key === k)?.header ?? k,
    );
    const rows = subs.map((s) => columns.map((k) => value(s, k)));

    this.logger.log(`Export: ${rows.length} subscriber(s), ${columns.length} column(s)`);
    return { headers, rows, count: rows.length, columns };
  }

  /**
   * Export in the PANEL EXCHANGE FORMAT — the 46-column layout, in order.
   *
   * Separate from run() on purpose. run() is for a human picking the columns
   * they want to read; this one is a machine contract where the column set and
   * their order are fixed, so a file leaving here loads into other ISP tooling
   * and a file produced elsewhere loads back into this panel unchanged.
   *
   * Uses the same filters as run(), so you can still export "all 50 Mb users
   * under Dealer 1" in the standard layout.
   */
  async runPanelFormat(filters: ExportFilters, actor?: Actor) {
    const where = await this.buildWhere(filters, actor);

    const subs = await this.prisma.subscriber.findMany({
      where,
      include: {
        area: { select: { id: true } },
        serviceSettings: true,
        staticIps: { select: { ipAddress: true }, take: 1 },
      },
      orderBy: { id: 'asc' },
      take: Math.min(Number(filters.limit) || 10000, 50000),
    });

    // Passwords are part of this format — it is a migration file, and a
    // connection without its password is useless on the far side. Same
    // restriction as the flexible export: ISP owner only.
    const mayExportSecrets = !actor || this.scope.isAdmin(actor.role);

    const rows = subs.map((s) => {
      const ss: any = s.serviceSettings ?? {};
      const secret = mayExportSecrets ? str(s.password) : '';

      // Built as an ordered array, NOT an object keyed by name. Column position
      // is part of this contract, and an array cannot silently reorder itself
      // the way object key iteration can.
      return [
        num((s as any).ispId ?? ''),                       // isp_id
        num(s.branchId),                                   // branch_id
        str(s.fullName),                                   // full_name
        str(s.username),                                   // username
        secret,                                            // password
        secret,                                            // connection_password
        str(s.identity ?? s.cnicNumber),                   // identity
        str(s.phone),                                      // phone
        CONNECTION_TYPE_CODE[String(s.connectionType)] ?? '1', // connection_type
        num(s.nasId),                                      // nas_id
        num(s.salespersonId),                              // salesperson_id
        num(s.packageId),                                  // package_id
        formatPanelDate(ss.expiryDate),                    // expiration_date
        formatPanelDate(s.installationDate),               // join_date
        num(s.balance ?? 0),                               // previous_balance
        str(s.email),                                      // email
        str(s.address),                                    // address
        '',                                                // subarea_id — not modelled
        num(s.areaId),                                     // area_id
        '', '', '', '',                                    // city/province/country/department
        num(s.latitude),                                   // latitude
        num(s.longitude),                                  // longitude
        PROFILE_STATUS_CODE[String(s.status)] ?? '2',      // profile_status
        flag(ss.smsEnabled ?? true),                       // sms_status
        flag(ss.macLockEnabled),                           // mac_lock_status
        str(ss.macAddress),                                // mac_address
        str(s.staticIps?.[0]?.ipAddress ?? (ss.ipType === 'STATIC' ? ss.ipAddress : '')), // static_ip
        str(ss.quota),                                     // total_volume
        num(ss.quotaUsed),                                 // used_volume
        num(ss.totalSession),                              // total_session
        num(ss.usedSession),                               // used_session
        DISCOUNT_TYPE_CODE[String(ss.discountType)] ?? '', // discount_type
        num(ss.discountValue),                             // discount
        str(ss.boxNumber),                                 // box_number
        str(ss.boxAddress),                                // box_address
        str(ss.switchBoard),                               // switch_board
        str(ss.switchPort),                                // switch_port
        str(ss.electricSocket),                            // electric_socket
        str(ss.cableType),                                 // cable_type
        str(ss.uplinkPort),                                // uplink_port
        str(ss.fiberCode),                                 // fiber_code
        str(ss.fiberColor),                                // fiber_color
        str(ss.onuNote),                                   // onu_note
      ];
    });

    await this.prisma.activityLog.create({
      data: {
        action: 'SUBSCRIBER_EXPORT',
        entity: 'Subscriber',
        details: `Panel-format export · ${rows.length} row(s)` +
                 (mayExportSecrets ? ' · INCLUDING PASSWORDS' : ' · passwords omitted'),
        userId: actor ? this.scope.actorId(actor) : null,
      },
    }).catch(() => null);

    this.logger.log(`Panel-format export: ${rows.length} subscriber(s)`);
    return {
      headers: [...PANEL_COLUMNS],
      rows,
      count: rows.length,
      format: 'panel',
      passwordsIncluded: mayExportSecrets,
    };
  }

  /** Options for the filter builder, restricted to what the caller may see. */
  async filterOptions(actor?: Actor) {
    const isAdmin = !actor || this.scope.isAdmin(actor.role);
    const ids = isAdmin ? null : await this.scope.descendantIds(await this.scope.rootId(actor!));

    const [packages, areas, nas, owners] = await Promise.all([
      this.prisma.package.findMany({
        select: { id: true, name: true, price: true, downloadSpeed: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.area.findMany({ select: { id: true, name: true, city: true }, orderBy: { name: 'asc' } }),
      this.prisma.nas.findMany({ select: { id: true, nasname: true }, orderBy: { nasname: 'asc' } }),
      this.prisma.user.findMany({
        where: ids ? { id: { in: ids } } : {},
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      packages, areas, nas, owners,
      statuses: ['ACTIVE', 'EXPIRED', 'SUSPENDED', 'INACTIVE'],
      authMethods: ['PPPOE', 'HOTSPOT', 'STATIC', 'DHCP'],
      connectionTypes: ['FTTH', 'ADSL', 'G4_LTE', 'WIRELESS', 'FIBER'],
      columns: EXPORT_COLUMNS,
      defaultColumns: DEFAULT_COLUMNS,
    };
  }
}
