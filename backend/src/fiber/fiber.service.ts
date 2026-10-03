import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  // TENANCY
  // ─────────────────────────────────────────────────────────────
  //
  // An OLT has no owner column: it belongs to whoever may use the NAS (BRAS)
  // its traffic terminates on, so it is scoped through that NAS. An OLT with
  // no NAS is installation-level — the platform owner's alone. Ports inherit
  // from their OLT. An ONU bound to a subscriber is decided by that subscriber
  // (the binding is subscriber PII — see listOnus); an unassigned ONU by its
  // OLT.
  //
  // `actor` is optional on the service so internal callers keep their
  // unscoped path; every controller route passes req.user. Out-of-scope ids
  // answer "not found", never "forbidden", so they cannot be enumerated.

  /** OLTs the actor may see. null = no filter (platform owner / internal). */
  private async oltWhere(actor?: Actor): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return { nas: { is: await this.scope.nasWhere(actor) } };
  }

  /** Subscribers whose ONU binding the actor may see. null = no filter. */
  private async subscriberFilter(actor?: Actor): Promise<any | null> {
    if (!actor || this.scope.isPlatformOwner(actor)) return null;
    return this.scope.subscriberWhere(actor);
  }

  /**
   * ONUs the actor may see: bound to one of its own subscribers, or
   * unassigned on an OLT it may see. null = no filter.
   */
  private async onuWhere(actor?: Actor): Promise<any | null> {
    const olt = await this.oltWhere(actor);
    if (!olt) return null;
    const subs = await this.scope.subscriberWhere(actor);
    return { OR: [{ subscriber: { is: subs } }, { subscriberId: null, olt: { is: olt } }] };
  }

  private async canSeeOlt(actor: Actor, oltId: number): Promise<boolean> {
    if (!actor || this.scope.isPlatformOwner(actor)) return true;
    const olt = await this.prisma.olt.findUnique({ where: { id: oltId }, select: { nasId: true } });
    // No NAS => installation-level OLT, reachable by the platform owner only.
    if (!olt || olt.nasId == null) return false;
    return this.scope.canAccessNas(actor, olt.nasId);
  }

  private async assertOlt(actor: Actor, oltId: number): Promise<void> {
    if (!(await this.canSeeOlt(actor, oltId))) throw new NotFoundException('OLT not found');
  }

  private async assertPort(actor: Actor, portId: number): Promise<void> {
    if (!actor || this.scope.isPlatformOwner(actor)) return;
    const port = await this.prisma.ponPort.findUnique({ where: { id: portId }, select: { oltId: true } });
    if (!port || !(await this.canSeeOlt(actor, port.oltId))) {
      throw new NotFoundException('PON port not found');
    }
  }

  private async assertOnu(actor: Actor, onuId: number): Promise<void> {
    if (!actor || this.scope.isPlatformOwner(actor)) return;
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      select: { oltId: true, subscriberId: true },
    });
    const ok = !!onu && (onu.subscriberId != null
      ? await this.scope.canAccessSubscriber(actor, onu.subscriberId)
      : await this.canSeeOlt(actor, onu.oltId));
    if (!ok) throw new NotFoundException('ONU not found');
  }

  /**
   * The NAS / area an OLT is being pointed at must be the caller's own. A
   * tenant may not create an installation-level (NAS-less) OLT: nobody but
   * the platform owner could ever see it again.
   */
  private async assertOltRefs(actor: Actor, data: { nasId?: any; areaId?: any }, creating: boolean) {
    if (!actor || this.scope.isPlatformOwner(actor)) return;
    if (creating || data.nasId !== undefined) {
      if (!data.nasId) {
        throw new ForbiddenException(
          'Choose the NAS this OLT connects to. Only the platform owner can keep an OLT without one.',
        );
      }
      if (!(await this.scope.canAccessNas(actor, Number(data.nasId)))) {
        throw new NotFoundException('NAS not found');
      }
    }
    if (data.areaId) {
      const area = await this.prisma.area.findUnique({
        where: { id: Number(data.areaId) },
        select: { ownerId: true },
      });
      if (!area) throw new NotFoundException('Area not found');
      await this.scope.assertOwnerInScope(actor, area.ownerId, 'Area');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // OLT CRUD
  // ─────────────────────────────────────────────────────────────

  async listOlts(actor?: Actor) {
    const where = await this.oltWhere(actor);
    return this.prisma.olt.findMany({
      ...(where ? { where } : {}),
      include: {
        nas: { select: { id: true, nasname: true, nasIp: true } },
        area: { select: { id: true, name: true } },
        _count: { select: { ports: true, onus: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getOlt(id: number, actor?: Actor) {
    await this.assertOlt(actor, id);
    // A shared OLT carries other accounts' customers too; the ONU→customer
    // binding stays limited to the caller's own subscribers.
    const subs = await this.subscriberFilter(actor);
    const olt = await this.prisma.olt.findUnique({
      where: { id },
      include: {
        nas: { select: { id: true, nasname: true, nasIp: true } },
        area: { select: { id: true, name: true } },
        ports: {
          include: {
            _count: { select: { onus: true } },
            onus: {
              where: subs
                ? { subscriberId: { not: null }, subscriber: { is: subs } }
                : { subscriberId: { not: null } },
              select: { id: true, subscriberId: true, serialNumber: true, onuIndex: true },
              take: 20,
            },
          },
          orderBy: { portName: 'asc' },
        },
        onus: {
          ...(subs ? { where: { OR: [{ subscriberId: null }, { subscriber: { is: subs } }] } } : {}),
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
  }, actor?: Actor) {
    if (!data.name?.trim()) throw new BadRequestException('OLT name is required');
    await this.assertOltRefs(actor, data, true);
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
  }, actor?: Actor) {
    await this.assertOlt(actor, id);
    await this.assertOltRefs(actor, data, false);
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

  async deleteOlt(id: number, actor?: Actor) {
    await this.assertOlt(actor, id);
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

  async listPorts(oltId?: number, actor?: Actor) {
    const where: any = {};
    if (oltId) where.oltId = oltId;
    const olt = await this.oltWhere(actor);
    if (olt) where.olt = { is: olt };
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
  }, actor?: Actor) {
    if (!data.oltId) throw new BadRequestException('OLT ID is required');
    if (!data.portName?.trim()) throw new BadRequestException('Port name is required');
    await this.assertOlt(actor, data.oltId);

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
  }, actor?: Actor) {
    await this.assertPort(actor, id);
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

  async deletePort(id: number, actor?: Actor) {
    await this.assertPort(actor, id);
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

    // TENANT ISOLATION: a reseller must only see ONUs bound to a subscriber in
    // their own subtree — never another tenant's customer name/phone — or
    // unassigned ONUs on an OLT they may use (one whose NAS they can see).
    // Unassigned ONUs on another company's OLT used to be listed too.
    const scoped = await this.onuWhere(actor);
    if (scoped) {
      where.AND = [...(where.AND || []), scoped];
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

  async assignOnu(onuId: number, subscriberId: number, actor?: Actor) {
    // The subscriber is checked by the controller; the ONU must be ours too —
    // not an unassigned ONU on another company's OLT, nor one already bound to
    // another company's customer.
    await this.assertOnu(actor, onuId);
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

  async unassignOnu(onuId: number, actor?: Actor) {
    await this.assertOnu(actor, onuId);
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
  }, actor?: Actor) {
    await this.assertOnu(actor, id);
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

  async deleteOnu(id: number, actor?: Actor) {
    await this.assertOnu(actor, id);
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

  // The generated CLI reveals the OLT's vendor, port layout and the ONU serial,
  // so the same ONU check as every other per-ONU route applies.
  async generateProvisionCommands(onuId: number, vlan?: number, actor?: Actor) {
    await this.assertOnu(actor, onuId);
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

  async generateUnprovisionCommands(onuId: number, actor?: Actor) {
    await this.assertOnu(actor, onuId);
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

  async generateDiagnosticCommands(onuId: number, actor?: Actor) {
    await this.assertOnu(actor, onuId);
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

  async getFiberSummary(actor?: Actor) {
    // Same visibility as the lists: OLTs/ports through the NAS, ONUs through
    // their subscriber (or their OLT when unassigned). Platform owner: no filter.
    const olt = await this.oltWhere(actor);
    const onu = await this.onuWhere(actor);
    const oltW = olt ?? {};
    const portW = olt ? { olt: { is: olt } } : {};
    const onuW = (extra: any) => (onu ? { AND: [onu, extra] } : extra);
    const [olts, ports, onus, assignedOnus, activeOnus] = await Promise.all([
      this.prisma.olt.count({ where: oltW }),
      this.prisma.ponPort.count({ where: portW }),
      this.prisma.onu.count({ where: onu ?? {} }),
      this.prisma.onu.count({ where: onuW({ subscriberId: { not: null } }) }),
      this.prisma.onu.count({
        where: onuW({ subscriberId: { not: null }, isActive: true }),
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

  async getFiberTree(oltId: number, actor?: Actor) {
    await this.assertOlt(actor, oltId);
    // As getOlt(): on a shared OLT only the caller's own customers are shown.
    const subs = await this.subscriberFilter(actor);
    const olt = await this.prisma.olt.findUnique({
      where: { id: oltId },
      include: {
        ports: {
          include: {
            onus: {
              where: subs
                ? { subscriberId: { not: null }, subscriber: { is: subs } }
                : { subscriberId: { not: null } },
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