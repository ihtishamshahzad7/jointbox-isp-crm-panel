import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { TopologyService } from '../topology/topology.service';
import { OnuProvisionService } from './onu-provision.service';

/**
 * FiberService — FTTH/OLT management.
 *
 * Manages the physical fibre network: OLT devices, PON ports, splitters,
 * ONU registrations, and subscriber-to-ONU binding. Provides CRUD for the
 * network inventory plus ONU provisioning commands.
 */
@Injectable()
export class FiberService {
  private readonly logger = new Logger(FiberService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private topology: TopologyService,
    private onuProvision: OnuProvisionService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // OLT CRUD
  // ─────────────────────────────────────────────────────────────

  async listOlts() {
    return this.prisma.olt.findMany({
      include: {
        nas: { select: { id: true, nasname: true, nasIp: true } },
        area: { select: { id: true, name: true } },
        _count: { select: { ports: true, onus: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getOlt(id: number) {
    const olt = await this.prisma.olt.findUnique({
      where: { id },
      include: {
        nas: { select: { id: true, nasname: true, nasIp: true } },
        area: { select: { id: true, name: true } },
        ports: {
          include: {
            _count: { select: { onus: true } },
            onus: {
              where: { subscriberId: { not: null } },
              select: { id: true, subscriberId: true, serialNumber: true, onuIndex: true },
              take: 20,
            },
          },
          orderBy: { portName: 'asc' },
        },
        onus: {
          include: { subscriber: { select: { id: true, fullName: true, username: true, phone: true, status: true } } },
          orderBy: { id: 'desc' },
          take: 50,
        },
      },
    });
    if (!olt) throw new NotFoundException('OLT not found');
    return olt;
  }

  async createOlt(data: {
    name: string; vendor?: string; model?: string; mgmtIp?: string;
    location?: string; nasId?: number; areaId?: number;
  }) {
    if (!data.name?.trim()) throw new BadRequestException('OLT name is required');
    const existing = await this.prisma.olt.findUnique({ where: { name: data.name.trim() } });
    if (existing) throw new BadRequestException('An OLT with this name already exists');

    return this.prisma.olt.create({
      data: {
        name: data.name.trim(),
        vendor: data.vendor || null,
        model: data.model || null,
        mgmtIp: data.mgmtIp || null,
        location: data.location || null,
        nasId: data.nasId || null,
        areaId: data.areaId || null,
      },
    });
  }

  async updateOlt(id: number, data: {
    name?: string; vendor?: string; model?: string; mgmtIp?: string;
    location?: string; nasId?: number; areaId?: number;
  }) {
    const olt = await this.prisma.olt.findUnique({ where: { id } });
    if (!olt) throw new NotFoundException('OLT not found');

    if (data.name && data.name.trim() !== olt.name) {
      const dup = await this.prisma.olt.findUnique({ where: { name: data.name.trim() } });
      if (dup) throw new BadRequestException('Another OLT already has this name');
    }

    return this.prisma.olt.update({
      where: { id },
      data: {
        ...(data.name ? { name: data.name.trim() } : {}),
        ...(data.vendor !== undefined ? { vendor: data.vendor || null } : {}),
        ...(data.model !== undefined ? { model: data.model || null } : {}),
        ...(data.mgmtIp !== undefined ? { mgmtIp: data.mgmtIp || null } : {}),
        ...(data.location !== undefined ? { location: data.location || null } : {}),
        ...(data.nasId !== undefined ? { nasId: data.nasId || null } : {}),
        ...(data.areaId !== undefined ? { areaId: data.areaId || null } : {}),
      },
    });
  }

  async deleteOlt(id: number) {
    const olt = await this.prisma.olt.findUnique({
      where: { id },
      include: { onus: { where: { subscriberId: { not: null } }, take: 1 } },
    });
    if (!olt) throw new NotFoundException('OLT not found');
    if (olt.onus.length > 0) {
      throw new BadRequestException('Cannot delete OLT — it has active subscriber ONUs. Unassign them first.');
    }
    await this.prisma.olt.delete({ where: { id } });
    return { deleted: true };
  }

  // ─────────────────────────────────────────────────────────────
  // PON PORT CRUD
  // ─────────────────────────────────────────────────────────────

  async listPorts(oltId?: number) {
    const where: any = {};
    if (oltId) where.oltId = oltId;
    return this.prisma.ponPort.findMany({
      where,
      include: {
        olt: { select: { id: true, name: true } },
        _count: { select: { onus: true } },
      },
      orderBy: [{ oltId: 'asc' }, { portName: 'asc' }],
    });
  }

  async createPort(data: {
    oltId: number; portName: string; slot?: string; port?: string;
    splitRatio?: number; splitterLocation?: string;
  }) {
    if (!data.oltId) throw new BadRequestException('OLT ID is required');
    if (!data.portName?.trim()) throw new BadRequestException('Port name is required');

    const olt = await this.prisma.olt.findUnique({ where: { id: data.oltId } });
    if (!olt) throw new NotFoundException('OLT not found');

    const existing = await this.prisma.ponPort.findUnique({
      where: { oltId_portName: { oltId: data.oltId, portName: data.portName.trim() } },
    });
    if (existing) throw new BadRequestException('This port already exists on the OLT');

    return this.prisma.ponPort.create({
      data: {
        oltId: data.oltId,
        portName: data.portName.trim(),
        slot: data.slot || null,
        port: data.port || null,
        splitRatio: data.splitRatio || null,
        splitterLocation: data.splitterLocation || null,
      },
    });
  }

  async updatePort(id: number, data: {
    portName?: string; slot?: string; port?: string;
    splitRatio?: number; splitterLocation?: string; isActive?: boolean;
  }) {
    const port = await this.prisma.ponPort.findUnique({ where: { id } });
    if (!port) throw new NotFoundException('PON port not found');

    return this.prisma.ponPort.update({
      where: { id },
      data: {
        ...(data.portName !== undefined ? { portName: data.portName.trim() } : {}),
        ...(data.slot !== undefined ? { slot: data.slot || null } : {}),
        ...(data.port !== undefined ? { port: data.port || null } : {}),
        ...(data.splitRatio !== undefined ? { splitRatio: data.splitRatio || null } : {}),
        ...(data.splitterLocation !== undefined ? { splitterLocation: data.splitterLocation || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  }

  async deletePort(id: number) {
    const port = await this.prisma.ponPort.findUnique({
      where: { id },
      include: { onus: { where: { subscriberId: { not: null } }, take: 1 } },
    });
    if (!port) throw new NotFoundException('PON port not found');
    if (port.onus.length > 0) {
      throw new BadRequestException('Port has active ONUs — unassign them first');
    }
    await this.prisma.ponPort.delete({ where: { id } });
    return { deleted: true };
  }

  // ─────────────────────────────────────────────────────────────
  // ONU CRUD
  // ─────────────────────────────────────────────────────────────

  async listOnus(query: {
    oltId?: number; portId?: number; subscriberId?: number;
    unassigned?: boolean; page?: number; limit?: number;
  }, actor?: Actor) {
    const where: any = {};
    if (query.oltId) where.oltId = query.oltId;
    if (query.portId) where.ponPortId = query.portId;
    if (query.subscriberId) where.subscriberId = query.subscriberId;
    if (query.unassigned) where.subscriberId = null;

    // TENANT ISOLATION: a reseller must only see ONUs that are unassigned OR
    // bound to a subscriber in their own subtree — never another tenant's
    // customer name/phone. OLT/PON infrastructure is shared, but this binding is
    // subscriber PII.
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.AND = [
        ...(where.AND || []),
        { OR: [{ subscriberId: null }, { subscriber: { userId: { in: ids.length ? ids : [-1] } } }] },
      ];
    }

    const limit = Math.min(Number(query.limit) || 50, 200);
    const page = Math.max(Number(query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.onu.findMany({
        where,
        include: {
          olt: { select: { id: true, name: true, vendor: true } },
          ponPort: { select: { id: true, portName: true } },
          subscriber: { select: { id: true, fullName: true, username: true, phone: true, status: true } },
        },
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.onu.count({ where }),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async assignOnu(onuId: number, subscriberId: number) {
    const onu = await this.prisma.onu.findUnique({ where: { id: onuId } });
    if (!onu) throw new NotFoundException('ONU not found');

    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId } });
    if (!sub) throw new NotFoundException('Subscriber not found');

    // Check if subscriber already has an ONU
    const existing = await this.prisma.onu.findUnique({ where: { subscriberId } });
    if (existing) {
      throw new BadRequestException('Subscriber already has an ONU assigned. Unassign the old one first.');
    }

    return this.prisma.onu.update({
      where: { id: onuId },
      data: { subscriberId, autoDetected: false },
      include: {
        olt: { select: { id: true, name: true } },
        ponPort: { select: { id: true, portName: true, splitterLocation: true } },
        subscriber: { select: { id: true, fullName: true, username: true } },
      },
    });
  }

  async unassignOnu(onuId: number) {
    const onu = await this.prisma.onu.findUnique({ where: { id: onuId } });
    if (!onu) throw new NotFoundException('ONU not found');
    if (!onu.subscriberId) return onu; // already unassigned

    return this.prisma.onu.update({
      where: { id: onuId },
      data: { subscriberId: null },
    });
  }

  async updateOnu(id: number, data: {
    serialNumber?: string; macAddress?: string; model?: string;
    onuIndex?: string; isActive?: boolean; notes?: string;
  }) {
    const onu = await this.prisma.onu.findUnique({ where: { id } });
    if (!onu) throw new NotFoundException('ONU not found');

    return this.prisma.onu.update({
      where: { id },
      data: {
        ...(data.serialNumber !== undefined ? { serialNumber: data.serialNumber || null } : {}),
        ...(data.macAddress !== undefined ? { macAddress: data.macAddress || null } : {}),
        ...(data.model !== undefined ? { model: data.model || null } : {}),
        ...(data.onuIndex !== undefined ? { onuIndex: data.onuIndex || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      },
    });
  }

  async deleteOnu(id: number) {
    const onu = await this.prisma.onu.findUnique({ where: { id } });
    if (!onu) throw new NotFoundException('ONU not found');
    if (onu.subscriberId) {
      throw new BadRequestException('ONU is assigned to a subscriber. Unassign it first.');
    }
    await this.prisma.onu.delete({ where: { id } });
    return { deleted: true };
  }

  // ─────────────────────────────────────────────────────────────
  // ONU PROVISIONING COMMANDS
  // ─────────────────────────────────────────────────────────────

  async generateProvisionCommands(onuId: number, vlan?: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { olt: true, ponPort: true },
    });
    if (!onu) throw new NotFoundException('ONU not found');
    if (!onu.ponPort) throw new BadRequestException('ONU is not attached to a PON port');

    return this.onuProvision.generateProvisionCommands(
      onu.olt,
      onu.ponPort.portName,
      {
        onuIndex: onu.onuIndex || '0',
        serialNumber: onu.serialNumber || undefined,
        vlan: vlan || 100,
      },
    );
  }

  async generateUnprovisionCommands(onuId: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { olt: true, ponPort: true },
    });
    if (!onu) throw new NotFoundException('ONU not found');
    if (!onu.ponPort) throw new BadRequestException('ONU is not attached to a PON port');

    return this.onuProvision.generateUnprovisionCommands(
      onu.olt,
      onu.ponPort.portName,
      onu.onuIndex || '0',
    );
  }

  async generateDiagnosticCommands(onuId: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { olt: true, ponPort: true },
    });
    if (!onu) throw new NotFoundException('ONU not found');
    if (!onu.ponPort) throw new BadRequestException('ONU is not attached to a PON port');

    return this.onuProvision.generateDiagnosticCommands(
      onu.olt,
      onu.ponPort.portName,
      onu.onuIndex || '0',
    );
  }

  // ─────────────────────────────────────────────────────────────
  // FIBER DISTRIBUTION & TOPOLOGY
  // ─────────────────────────────────────────────────────────────

  async getFiberSummary() {
    const [olts, ports, onus, assignedOnus, activeOnus] = await Promise.all([
      this.prisma.olt.count(),
      this.prisma.ponPort.count(),
      this.prisma.onu.count(),
      this.prisma.onu.count({ where: { subscriberId: { not: null } } }),
      this.prisma.onu.count({
        where: { subscriberId: { not: null }, isActive: true },
      }),
    ]);

    return {
      totalOlts: olts,
      totalPorts: ports,
      totalOnus: onus,
      assignedOnus,
      activeOnus,
      utilizationPercent: ports > 0 ? Math.round((assignedOnus / ports) * 100) : 0,
    };
  }

  async getFiberTree(oltId: number) {
    const olt = await this.prisma.olt.findUnique({
      where: { id: oltId },
      include: {
        ports: {
          include: {
            onus: {
              where: { subscriberId: { not: null } },
              include: {
                subscriber: { select: { id: true, fullName: true, username: true, status: true } },
              },
            },
          },
          orderBy: {
            portName: 'asc',
          },
        },
      },
    });
    if (!olt) throw new NotFoundException('OLT not found');

    return {
      olt: { id: olt.id, name: olt.name, vendor: olt.vendor, model: olt.model, location: olt.location },
      ports: olt.ports.map((p) => ({
        id: p.id,
        portName: p.portName,
        splitRatio: p.splitRatio,
        splitterLocation: p.splitterLocation,
        subscriberCount: p.onus.length,
        onus: p.onus.map((o) => ({
          id: o.id,
          onuIndex: o.onuIndex,
          serialNumber: o.serialNumber,
          subscriber: o.subscriber,
        })),
      })),
    };
  }

  /**
   * Parse a Circuit-ID string.
   * Delegates to the existing TopologyService parser.
   */
  parseCircuitId(raw: string) {
    return this.topology.parseCircuitId(raw);
  }

  // ─────────────────────────────────────────────────────────────
  // SUBSCRIBER FIBER INSTALLATION DETAILS
  // ─────────────────────────────────────────────────────────────

  async getSubscriberFiber(subscriberId: number) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: {
        serviceSettings: {
          select: {
            boxNumber: true, boxAddress: true, switchBoard: true, switchPort: true,
            electricSocket: true, cableType: true, uplinkPort: true,
            fiberCode: true, fiberColor: true, onuNote: true,
          },
        },
        onu: {
          include: {
            olt: { select: { id: true, name: true, vendor: true, mgmtIp: true, location: true } },
            ponPort: { select: { id: true, portName: true, splitRatio: true, splitterLocation: true } },
          },
        },
      },
    });
    if (!sub) throw new NotFoundException('Subscriber not found');
    return sub;
  }

  async updateSubscriberFiber(subscriberId: number, data: {
    boxNumber?: string; boxAddress?: string; switchBoard?: string; switchPort?: string;
    electricSocket?: string; cableType?: string; uplinkPort?: string;
    fiberCode?: string; fiberColor?: string; onuNote?: string;
  }) {
    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId } });
    if (!sub) throw new NotFoundException('Subscriber not found');

    const ss = await this.prisma.serviceSettings.upsert({
      where: { subscriberId },
      create: { subscriberId, ...data },
      update: data,
    });
    return ss;
  }
}