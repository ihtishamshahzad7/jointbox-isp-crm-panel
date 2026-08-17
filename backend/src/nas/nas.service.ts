import { Injectable, NotFoundException, Logger, ConflictException, InternalServerErrorException, BadRequestException, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';
import { NasType } from '@prisma/client';
import { Prisma } from '@prisma/client'; // ⚠️ ADD THIS IMPORT
import { MikrotikSyncService } from './mikrotik-sync.service';
import { RadiusSyncService } from './radius-sync.service';
import { SecretsService } from '../common/secrets.service';
import { sanitizeNas, sanitizeNasList, encField, isMask } from './nas-credentials';

@Injectable()
export class NasService implements OnModuleInit {
  private readonly logger = new Logger(NasService.name);

  constructor(
    private prisma: PrismaService,
    private mikrotikSync: MikrotikSyncService,
    private radiusSync: RadiusSyncService,
    private scope: ScopeService,
    private secrets: SecretsService,
  ) {}

  // ───────────────────────────────────────────────────────────────
  // FreeRADIUS reads its client list from this same `nas` table and matches an
  // incoming request on `nasname`, which therefore MUST be the NAS IP address.
  // Older rows (and any written by the previous buggy code path) put the
  // friendly name there, which makes FreeRADIUS silently ignore the router —
  // it looks exactly like a "RADIUS timeout" with no logs at all.
  // Self-heal on boot so this never has to be repaired by hand over SSH again.
  // ───────────────────────────────────────────────────────────────
  async onModuleInit() {
    try {
      await this.normalizeNasRecords();
    } catch (err: any) {
      this.logger.warn(`NAS normalization skipped: ${err?.message || err}`);
    }
  }

  async normalizeNasRecords() {
    const rows = await this.prisma.nas.findMany();
    let fixed = 0;

    for (const n of rows) {
      const data: any = {};

      // nasname must equal the IP.
      if (n.nasIp && n.nasname !== n.nasIp) {
        data.nasname = n.nasIp;
        // Don't lose the friendly name — keep it as the shortname.
        if (!n.shortname || this.isIpv4(n.shortname)) data.shortname = n.nasname;
      }

      // Legacy rows written by the old RADIUS-side insert have nasname = IP but
      // no nasIp. Promote it so the panel and log matching can find them.
      if (!n.nasIp && this.isIpv4(n.nasname)) data.nasIp = n.nasname;

      if (Object.keys(data).length) {
        await this.prisma.nas.update({ where: { id: n.id }, data });
        fixed++;
        this.logger.warn(
          `NAS #${n.id} repaired for FreeRADIUS: nasname "${n.nasname}" -> "${data.nasname ?? n.nasname}"`,
        );
      }
    }

    if (fixed) {
      this.logger.log(`✅ Normalized ${fixed} NAS record(s). Restart FreeRADIUS to load them.`);
    }
    return { fixed, total: rows.length };
  }

  private isIpv4(value?: string | null): boolean {
    if (!value) return false;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
    return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  }

  /** Reject placeholders/hostnames early with a message the GUI can show. */
  private assertValidNasIp(ip?: string) {
    if (!ip || !this.isIpv4(ip.trim())) {
      throw new BadRequestException(
        `"${ip ?? ''}" is not a valid IPv4 address. Enter the router's IP as seen by the RADIUS server (e.g. 192.168.1.127) — no name, no placeholder, no subnet mask.`,
      );
    }
  }

  async findAll(query: any, actor?: any) {
    const groupFilter = query?.group;
    const groupId = groupFilter && groupFilter !== 'ALL' && groupFilter !== 'UNGROUPED'
      ? Number(groupFilter)
      : null;

    // A reseller sees its own routers, its ancestors' routers, and any router
    // explicitly assigned to it. The ISP sees everything.
    const where = await this.scope.nasWhere(actor);
    const options: any = {
      where,
      orderBy: { id: 'desc' },
      include: {
        _count: { select: { subscribers: true } },
        owner: { select: { id: true, name: true, role: true } },
        assignments: { select: { userId: true, user: { select: { id: true, name: true } } } },
      },
    };

    if (groupFilter && groupFilter !== 'ALL') {
      if (groupFilter === 'UNGROUPED') {
        options.where = { AND: [where, { accessGroups: { none: {} } }] };
      } else if (groupId !== null && !Number.isNaN(groupId)) {
        options.where = { AND: [where, { accessGroups: { some: { groupId } } }] };
      }
      options.include.accessGroups = { select: { groupId: true } };
    }

    // Credentials never leave the server — the list returns masks plus a
    // has<Field> flag so the UI can show "configured" and a Change button.
    return sanitizeNasList(await this.prisma.nas.findMany(options));
  }

  /**
   * Register a NAS. Self-registration is permission-gated: a reseller may only
   * add its own router if the ISP granted `canAddNas`. Otherwise routers must
   * be assigned down from the ISP or parent.
   */
  private async assertMayAddNas(actor?: any) {
    if (!actor || this.scope.isAdmin(actor.role)) return; // ISP always may
    const me = await this.prisma.user.findUnique({
      where: { id: this.scope.actorId(actor) },
      select: { canAddNas: true },
    });
    if (!me?.canAddNas) {
      throw new ForbiddenException(
        'You do not have permission to add a router. Ask the ISP to enable it, or to assign you a NAS.',
      );
    }
  }

  /**
   * Assign a router to a downline account so their subscribers can use it.
   *
   * `propagate` controls reach:
   *   • true  — the account and everyone below it may use the router.
   *   • false — only that exact account, so a franchise can give a router to
   *             Booni without Mastuj (a sibling dealer) ever seeing it.
   *
   * Who may share: the OWNER, or an account that HOLDS the router (it was shared
   * directly to them). The second case is what lets a franchise re-share the
   * ISP's router down to a specific dealer — previously impossible, because only
   * the owner could assign, so a franchise could never sub-delegate.
   */
  async assignToUser(nasId: number, userId: number, actor?: any, propagate: boolean = true) {
    const nas = await this.prisma.nas.findUnique({ where: { id: nasId } });
    if (!nas) throw new NotFoundException(`NAS with ID ${nasId} not found`);

    if (actor && !this.scope.isAdmin(actor.role)) {
      const meId = this.scope.actorId(actor);
      const owns = nas.ownerId === meId;
      // Do I hold this router myself (shared directly to me)? Then I may pass it on.
      const holds = owns
        ? true
        : (await this.prisma.nasAssignment.count({ where: { nasId, userId: meId } })) > 0;
      if (!holds) {
        throw new ForbiddenException(
          'You can only share a router that you own or that has been shared with you.',
        );
      }
      if (userId === meId) {
        throw new ForbiddenException('You cannot share a router with yourself.');
      }
      await this.scope.assertUser(actor, userId); // target must be inside your subtree
    }

    await this.prisma.nasAssignment.upsert({
      where:  { nasId_userId: { nasId, userId } },
      update: { propagate },
      create: { nasId, userId, propagate, assignedById: actor ? this.scope.actorId(actor) : null },
    });
    this.logger.log(`NAS #${nasId} assigned to user #${userId} (propagate=${propagate})`);
    return { assigned: true, nasId, userId, propagate };
  }

  /**
   * Assign MANY routers to MANY accounts in one action — e.g. handing a
   * franchise's three routers to two new dealers. Each pair is attempted
   * independently so one failure doesn't abort the rest.
   */
  async assignBulk(nasIds: number[], userIds: number[], actor?: any, propagate: boolean = true) {
    const results: any[] = [];
    for (const nasId of nasIds || []) {
      for (const userId of userIds || []) {
        try {
          results.push(await this.assignToUser(Number(nasId), Number(userId), actor, propagate));
        } catch (e: any) {
          results.push({ assigned: false, nasId, userId, error: e?.message || String(e) });
        }
      }
    }
    return {
      requested: (nasIds?.length || 0) * (userIds?.length || 0),
      assigned: results.filter((r) => r.assigned).length,
      results,
    };
  }

  async unassignFromUser(nasId: number, userId: number, actor?: any) {
    if (actor && !this.scope.isAdmin(actor.role)) {
      const meId = this.scope.actorId(actor);
      const nas = await this.prisma.nas.findUnique({ where: { id: nasId } });
      // The owner may revoke any share; a re-sharer may revoke the shares they
      // themselves created (so a franchise can take a router back off Booni).
      const owns = nas?.ownerId === meId;
      const mine = owns
        ? true
        : (await this.prisma.nasAssignment.count({ where: { nasId, userId, assignedById: meId } })) > 0;
      if (!mine) {
        throw new ForbiddenException('You can only revoke a share you own or that you granted.');
      }
    }
    await this.prisma.nasAssignment
      .delete({ where: { nasId_userId: { nasId, userId } } })
      .catch(() => null);
    return { assigned: false, nasId, userId };
  }

  /**
   * One router.
   *
   * SECURITY: this had no ownership check and returns the full record —
   * including the RADIUS `secret` and the API username and password. Any
   * logged-in account could enumerate ids and read the credentials for every
   * router on the network, which is enough to take control of them.
   */
  async findOne(id: number, actor?: any) {
    const w = await this.scope.nasWhere(actor);
    const nas = await this.prisma.nas.findFirst({
      where: Object.keys(w).length ? { AND: [w, { id }] } : { id },
      include: {
        subscribers: true,
        _count: { select: { subscribers: true } },
      },
    });
    // Deliberately the same message whether it is missing or simply not
    // theirs — otherwise the difference tells them which ids exist.
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    return sanitizeNas(nas);
  }

  /**
   * Register which interfaces/ports to monitor on a NAS. Pass an array of
   * interface names or ifIndexes; only these are polled by the SNMP monitor.
   * An empty array clears the restriction (monitor all again).
   */
  async setMonitoredPorts(id: number, ports: string[]) {
    const clean = (ports || []).map((p) => String(p).trim()).filter(Boolean);
    await this.prisma.nas.update({
      where: { id },
      data: { monitoredPorts: clean.length ? JSON.stringify(clean) : null },
    });
    return { id, monitoredPorts: clean, monitorsAll: clean.length === 0 };
  }

  /** Group NAS by owner, type or site — clear classification with counts. */
  async groupedBy(by: string, actor?: any) {
    const where = await this.scope.nasWhere(actor);
    const field = ({ owner: 'ownerId', type: 'type', site: 'description' } as Record<string, string>)[by] || 'ownerId';
    const groups = await this.prisma.nas.groupBy({ by: [field as any], where, _count: { _all: true } });
    const active = await this.prisma.nas.groupBy({ by: [field as any], where: { AND: [where, { isActive: true }] }, _count: { _all: true } });
    const activeMap = new Map(active.map((g: any) => [g[field], g._count._all]));

    const labels = new Map<any, string>();
    if (field === 'ownerId') {
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
          label: field === 'ownerId'
            ? (labels.get(key) ?? (key == null ? 'ISP-owned' : `#${key}`))
            : String(key ?? 'Unspecified'),
          total: g._count._all,
          active: activeMap.get(key) ?? 0,
        };
      }).sort((a, b) => b.total - a.total),
    };
  }

  private resolveNasType(raw?: string): NasType {
    const map: Record<string, NasType> = {
      CISCO: NasType.CISCO, HUAWEI: NasType.HUAWEI,
      OTHER: NasType.OTHER, MIKROTIK: NasType.MIKROTIK,
    };
    return map[raw?.toUpperCase() ?? ''] ?? NasType.MIKROTIK;
  }

  /** Bulk import routers/NAS from a file. Each row loops through create(). */
  async importMany(rows: any[], actor?: any) {
    let success = 0, failed = 0;
    const errors: Array<{ index: number; name?: string; error: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      try {
        await this.create({
          nasIp: r.nasIp || r.nasName,
          nasName: r.nasName || r.nasIp,
          secret: r.secret,
          shortname: r.shortname,
          apiPort: r.apiPort ? Number(r.apiPort) : undefined,
          incomingPort: r.incomingPort ? Number(r.incomingPort) : undefined,
          apiUsername: r.apiUsername,
          apiPassword: r.apiPassword,
          nasType: r.nasType,
          description: r.description,
          nasIdentifier: r.nasIdentifier,
          deviceType: r.deviceType,
        }, actor);
        success++;
      } catch (e: any) {
        failed++;
        errors.push({ index: i, name: r.nasName || r.nasIp, error: e?.message || 'Import failed' });
      }
    }
    return { total: rows.length, success, failed, errors };
  }

  async create(data: {
    nasIp: string; nasName: string; secret: string;
    shortname?: string;
    apiPort?: number; incomingPort?: number;
    apiUsername?: string; apiPassword?: string;
    nasType?: string; isActive?: boolean; description?: string;
    nasIdentifier?: string;
    deviceType?: string;
    apiEnabled?: boolean; apiPollSec?: number;
    snmpEnabled?: boolean; snmpPort?: number; snmpCommunity?: string; snmpVersion?: string; snmpPollSec?: number;
    syslogEnabled?: boolean; syslogPort?: number;
  }, actor?: any) {
    // Self-registration is permission-gated (see assertMayAddNas).
    await this.assertMayAddNas(actor);

    // Validate before writing: a bad IP here silently breaks RADIUS auth.
    this.assertValidNasIp(data.nasIp);
    data.nasIp  = data.nasIp.trim();
    // Trailing whitespace in a secret produces "invalid Message-Authenticator"
    // and is almost impossible to spot in a GUI field.
    data.secret = (data.secret ?? '').trim();
    if (!data.secret) throw new BadRequestException('RADIUS secret is required and cannot be blank.');

    const existing = await this.prisma.nas.findFirst({ where: { nasIp: data.nasIp } });
    if (existing) {
      throw new ConflictException(
        `A NAS with IP ${data.nasIp} already exists ("${existing.shortname || existing.nasname}"). Edit that device instead of adding a duplicate.`,
      );
    }

    const nas = await this.prisma.nas.create({
      data: {
        nasIp:        data.nasIp,
        // FreeRADIUS reads its client list from THIS table and matches an
        // incoming request by `nasname`, so it MUST hold the NAS IP address.
        // The human-friendly name lives in `shortname`.
        nasname:      data.nasIp,
        shortname:    data.shortname ?? data.nasName,
        secret:       data.secret,
        apiPort:      data.apiPort      ?? 8728,
        incomingPort: data.incomingPort ?? 3799,
        nasIdentifier: data.nasIdentifier?.trim() || null,
        apiUsername:  data.apiUsername,
        apiPassword:  data.apiPassword,
        type:         this.resolveNasType(data.nasType),
        isActive:     data.isActive ?? true,
        description:  data.description,
        // Optional link-tracing collectors (each independent, off by default
        // except the MikroTik API which stays on to preserve current behaviour).
        deviceType:    (data.deviceType as any) ?? undefined,
        apiEnabled:    data.apiEnabled ?? undefined,
        apiPollSec:    data.apiPollSec ?? undefined,
        snmpEnabled:   data.snmpEnabled ?? undefined,
        snmpPort:      data.snmpPort ?? undefined,
        // Encrypted at rest — only our pollers read it, and the API returns a mask.
        snmpCommunity: encField(this.secrets, data.snmpCommunity) ?? undefined,
        snmpVersion:   (data.snmpVersion as any) ?? undefined,
        snmpPollSec:   data.snmpPollSec ?? undefined,
        syslogEnabled: data.syslogEnabled ?? undefined,
        syslogPort:    data.syslogPort ?? undefined,
        // Stamp ownership so scoping and edit-rights work.
        ownerId:      actor ? this.scope.actorId(actor) : null,
      },
    });

    // The row above IS the FreeRADIUS client — there is nothing extra to insert.
    // (Previously this also called addNasToRadius(), which INSERTed a second row
    // into the same `nas` table and made every NAS appear twice.) FreeRADIUS
    // only loads clients at startup, so just ask it to reload.
    try {
      await this.radiusSync.reloadFreeradius();
      this.logger.log(`✅ NAS "${data.nasName}" (${data.nasIp}) registered as a FreeRADIUS client`);
    } catch (error: any) {
      this.logger.warn(`NAS saved, but FreeRADIUS reload failed: ${error.message}`);
    }
    return nas;
  }

  async update(id: number, data: {
    nasIp?: string; nasName?: string; secret?: string;
    shortname?: string;
    apiPort?: number; incomingPort?: number;
    apiUsername?: string; apiPassword?: string;
    nasType?: string; isActive?: boolean; description?: string;
    nasIdentifier?: string;
    deviceType?: string;
    apiEnabled?: boolean; apiPollSec?: number;
    snmpEnabled?: boolean; snmpPort?: number; snmpCommunity?: string; snmpVersion?: string; snmpPollSec?: number;
    syslogEnabled?: boolean; syslogPort?: number;
  }) {
    const existingNas = await this.prisma.nas.findUnique({ where: { id } });
    if (!existingNas) throw new NotFoundException(`NAS with ID ${id} not found`);

    const updateData: any = {};
    // `nasname` is the FreeRADIUS client key and must always equal the IP.
    if (data.nasIp !== undefined) {
      this.assertValidNasIp(data.nasIp);
      updateData.nasIp   = data.nasIp.trim();
      updateData.nasname = data.nasIp.trim();
    }
    if (data.secret !== undefined) {
      const s = data.secret.trim();
      if (!s) throw new BadRequestException('RADIUS secret cannot be blank.');
      data.secret = s;
    }
    // The friendly name is stored in `shortname`, never in `nasname`.
    if (data.nasName !== undefined)     updateData.shortname    = data.nasName;
    if (data.shortname !== undefined)   updateData.shortname    = data.shortname;
    // Masked values are the form echoing back what we sent it — never save them
    // over the real credential. (RADIUS `secret` stays plaintext at rest because
    // FreeRADIUS reads this table directly; it is masked in responses only.)
    if (data.secret !== undefined && !isMask(data.secret)) updateData.secret = data.secret;
    if (data.apiPort !== undefined)     updateData.apiPort      = data.apiPort;
    if (data.incomingPort !== undefined) updateData.incomingPort = data.incomingPort;
    if (data.nasIdentifier !== undefined) updateData.nasIdentifier = (data.nasIdentifier || '').trim() || null;
    if (data.apiUsername !== undefined) updateData.apiUsername  = data.apiUsername;
    if (data.apiPassword !== undefined && !isMask(data.apiPassword)) updateData.apiPassword = data.apiPassword;
    if (data.nasType !== undefined)     updateData.type         = this.resolveNasType(data.nasType);
    if (data.isActive !== undefined)    updateData.isActive     = data.isActive;
    if (data.description !== undefined) updateData.description  = data.description;
    if (data.deviceType !== undefined)    updateData.deviceType    = data.deviceType as any;
    if (data.apiEnabled !== undefined)    updateData.apiEnabled    = data.apiEnabled;
    if (data.apiPollSec !== undefined)    updateData.apiPollSec    = data.apiPollSec;
    if (data.snmpEnabled !== undefined)   updateData.snmpEnabled   = data.snmpEnabled;
    if (data.snmpPort !== undefined)      updateData.snmpPort      = data.snmpPort;
    // A masked value means the operator didn't retype it — leave the stored
    // secret alone instead of overwriting it with bullet characters.
    if (data.snmpCommunity !== undefined && !isMask(data.snmpCommunity)) {
      updateData.snmpCommunity = encField(this.secrets, data.snmpCommunity);
    }
    if (data.snmpVersion !== undefined)   updateData.snmpVersion   = data.snmpVersion as any;
    if (data.snmpPollSec !== undefined)   updateData.snmpPollSec   = data.snmpPollSec;
    if (data.syslogEnabled !== undefined) updateData.syslogEnabled = data.syslogEnabled;
    if (data.syslogPort !== undefined)    updateData.syslogPort    = data.syslogPort;

    const updatedNas = await this.prisma.nas.update({ where: { id }, data: updateData });

    const ipChanged     = data.nasIp   && data.nasIp   !== existingNas.nasIp;
    const secretChanged = data.secret  && data.secret  !== existingNas.secret;
    const nameChanged   = data.nasName && data.nasName !== existingNas.nasname;

    // The updated row IS the FreeRADIUS client, so no delete/re-insert is needed
    // (that pair is what produced duplicate NAS entries). FreeRADIUS caches its
    // client list at startup, so a reload is required for changes to take effect
    // — especially a changed IP or shared secret.
    if (ipChanged || secretChanged || nameChanged) {
      try {
        await this.radiusSync.reloadFreeradius();
        this.logger.log(`✅ NAS "${updatedNas.shortname}" (${updatedNas.nasIp}) updated; FreeRADIUS reloaded`);
      } catch (error: any) {
        this.logger.warn(`NAS updated, but FreeRADIUS reload failed: ${error.message}`);
      }
    }
    return updatedNas;
  }

  /**
   * Remove a NAS device with proper cascade deletion
   * Handles related records: network logs, sessions, and subscribers
   */
  async remove(id: number) {
    try {
      // First, check if the NAS exists and get related record counts
      const nas = await this.prisma.nas.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              networkLogs: true,
              pppoeSessions: true,
              subscribers: true,
              ipPools: true
            }
          }
        }
      });

      if (!nas) {
        throw new NotFoundException(`NAS with ID ${id} not found`);
      }

      this.logger.log(`Deleting NAS "${nas.nasname}" (ID: ${id})`);
      this.logger.log(`  - ${nas._count.networkLogs} network logs to delete`);
      this.logger.log(`  - ${nas._count.pppoeSessions} PPPoE sessions to delete`);
      this.logger.log(`  - ${nas._count.subscribers} subscribers to update (set nasId to null)`);
      this.logger.log(`  - ${nas._count.ipPools} IP pools to update (set nasId to null)`);

      // Use a transaction to ensure all operations succeed or fail together
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Remove from RADIUS (try, but don't fail if it doesn't work)
        if (nas.nasIp) {
          try {
            await this.radiusSync.removeNasFromRadius(nas.nasIp);
            this.logger.log(`✅ NAS "${nas.nasname}" removed from FreeRADIUS`);
          } catch (error: any) {
            this.logger.warn(`Failed to remove NAS from RADIUS: ${error.message}`);
            // Continue with deletion even if RADIUS removal fails
          }
        }

        // 2. Delete all network logs associated with this NAS
        if (nas._count.networkLogs > 0) {
          const deletedLogs = await tx.networkLog.deleteMany({
            where: { nasId: id }
          });
          this.logger.log(`✅ Deleted ${deletedLogs.count} network logs`);
        }

        // 3. Delete all PPPoE sessions associated with this NAS
        if (nas._count.pppoeSessions > 0) {
          const deletedSessions = await tx.pppoeSession.deleteMany({
            where: { nasId: id }
          });
          this.logger.log(`✅ Deleted ${deletedSessions.count} PPPoE sessions`);
        }

        // 4. Update subscribers to set nasId to null (instead of deleting them)
        if (nas._count.subscribers > 0) {
          const updatedSubscribers = await tx.subscriber.updateMany({
            where: { nasId: id },
            data: { nasId: null }
          });
          this.logger.log(`✅ Updated ${updatedSubscribers.count} subscribers (set nasId to null)`);
        }

        // 5. Update IP pools to set nasId to null (instead of deleting them)
        if (nas._count.ipPools > 0) {
          const updatedPools = await tx.ipPool.updateMany({
            where: { nasId: id },
            data: { nasId: null }
          });
          this.logger.log(`✅ Updated ${updatedPools.count} IP pools (set nasId to null)`);
        }

        // 6. Finally, delete the NAS itself
        // Verify the record still exists before deletion (prevent race condition)
        const nasStillExists = await tx.nas.findUnique({ where: { id } });
        if (!nasStillExists) {
          this.logger.warn(`⚠️ NAS ${id} was already deleted by another process; skipping final delete`);
          return nas; // Return the original NAS that was fetched
        }

        const deletedNas = await tx.nas.delete({
          where: { id }
        });

        this.logger.log(`✅ NAS "${nas.nasname}" deleted successfully`);
        return deletedNas;
      });

      return result;

    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      // Handle Prisma known errors
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2003') {
          this.logger.error(`Foreign key constraint failed for NAS ${id}: ${error.meta?.constraint}`);
          throw new ConflictException(
            `Cannot delete NAS: It has existing related records. Please ensure all network logs and sessions are removed first.`
          );
        }
        // P2025 = record not found (already deleted or didn't exist)
        // This can happen with race conditions. Treat as successful.
        if (error.code === 'P2025') {
          this.logger.warn(`⚠️ NAS ${id} not found during delete (may have been deleted by another process); treating as successful`);
          return null; // Return null to indicate already deleted
        }
      }
      
      this.logger.error(`Failed to delete NAS ${id}:`, error);
      throw new InternalServerErrorException('Failed to delete NAS device');
    }
  }

  async toggleStatus(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    return this.prisma.nas.update({ where: { id }, data: { isActive: !nas.isActive } });
  }

  /**
   * Router counts.
   *
   * Took no actor, so a franchise's dashboard showed the ISP's routers in its
   * totals — "1 online NAS" for a router it does not own and cannot see in the
   * list. The list was scoped and the count was not, which is worse than
   * either being wrong on its own: the two disagreed.
   */
  async getStats(actor?: any) {
    const w = await this.scope.nasWhere(actor);
    const and = (extra: any) => (Object.keys(w).length ? { AND: [w, extra] } : extra);

    const [total, active, inactive, mikrotik, cisco, other] = await Promise.all([
      this.prisma.nas.count({ where: w }),
      this.prisma.nas.count({ where: and({ isActive: true }) }),
      this.prisma.nas.count({ where: and({ isActive: false }) }),
      this.prisma.nas.count({ where: and({ type: 'MIKROTIK' }) }),
      this.prisma.nas.count({ where: and({ type: 'CISCO' }) }),
      this.prisma.nas.count({ where: and({ type: { notIn: ['MIKROTIK', 'CISCO'] } }) }),
    ]);
    return { total, active, inactive, mikrotik, cisco, other };
  }

  /**
   * Router health board. Also unscoped — this is what put "1 online NAS"
   * on a franchise's screen for a router belonging to the ISP. It even
   * reached out and polled it.
   */
  async getOverview(actor?: any) {
    const nasList = await this.prisma.nas.findMany({
      where: await this.scope.nasWhere(actor),
      orderBy: { id: 'desc' },
      include: { _count: { select: { subscribers: true } } },
    });

    const radiusStats = await this.getRadiusStats();

    const checks = await Promise.all(
      nasList.map(async (nas) => {
        if (!nas.isActive || !nas.nasIp || !nas.apiUsername || !nas.apiPassword) {
          return { id: nas.id, online: false };
        }

        try {
          // Cap the live router probe — an unreachable/firewalled NAS IP would
          // otherwise hang the TCP connect until the OS timeout and freeze the
          // whole /nas/overview response (page stuck on "Loading…").
          const quick = await Promise.race([
            this.mikrotikSync.quickCheck(
              nas.nasIp,
              nas.apiPort ?? 8728,
              nas.apiUsername,
              nas.apiPassword,
            ),
            new Promise<{ online: boolean }>((resolve) =>
              setTimeout(() => resolve({ online: false }), 4000),
            ),
          ]);
          return { id: nas.id, online: quick.online };
        } catch {
          return { id: nas.id, online: false };
        }
      }),
    );

    const onlineNas = checks.filter((item) => item.online).length;
    const totalNas = nasList.length;

    return {
      totalNas,
      onlineNas,
      offlineNas: Math.max(0, totalNas - onlineNas),
      activeSessions: radiusStats.activeSessionCount ?? 0,
      radiusAlive: radiusStats.alive ?? false,
      radiusNasCount: radiusStats.nasCount ?? 0,
    };
  }

  // ── Reachability: DB-based, no UDP probing ──────────────────
  async checkReachability(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) throw new Error('NAS IP address not configured');

    const apiPort     = nas.apiPort     ?? 8728;
    const incomingPort = (nas as any).incomingPort ?? 3799;

    this.logger.log(`Checking reachability for ${nas.nasname} (${nas.nasIp})`);

    // FIX: only call quickCheck when credentials exist, else skip
    const hasCredentials = !!nas.apiUsername && !!nas.apiPassword;

    const [apiCheck, radiusCheck, nasRegistered] = await Promise.all([
      hasCredentials
        ? this.mikrotikSync.quickCheck(
            nas.nasIp, apiPort,
            nas.apiUsername as string,   // safe — checked above
            nas.apiPassword as string,
          )
        : Promise.resolve({ online: false, identity: '', version: '', cpuLoad: '', uptime: '', activeConnections: 0 }),
      this.radiusSync.isRadiusAlive(),
      this.radiusSync.isNasRegistered(nas.nasIp),
    ]);

    return {
      apiPortOpen:        apiCheck.online,
      radiusPortOpen:     radiusCheck.alive,
      incomingPortOpen:   nasRegistered,
      nasRegistered,
      activeSessionCount: radiusCheck.activeSessionCount,
      radiusNasCount:     radiusCheck.nasCount,
      responseTimeMs:     null,
      lastChecked:        new Date(),
      radiusIp:           process.env.RADIUS_SERVER_IP || '127.0.0.1',
      radiusPort:         parseInt(process.env.RADIUS_AUTH_PORT || '1812'),
      coaPort:            incomingPort,
      // MikroTik details (if API available)
      identity:           apiCheck.identity,
      version:            apiCheck.version,
      cpuLoad:            apiCheck.cpuLoad,
      uptime:             apiCheck.uptime,
      activeConnections:  apiCheck.activeConnections,
    };
  }

  // ── ICMP ping: is the router even reachable from this server? ──────
  async ping(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) throw new BadRequestException('NAS IP address not configured');
    if (!this.isIpv4(nas.nasIp)) throw new BadRequestException(`"${nas.nasIp}" is not a valid IPv4 address.`);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFile } = require('child_process') as typeof import('child_process');
    const ip = nas.nasIp;

    return new Promise((resolve) => {
      // 4 packets, 1s each, 6s overall cap. -n numeric, -w total deadline.
      execFile('ping', ['-n', '-c', '4', '-w', '6', ip], { timeout: 8000 }, (err, stdout: string) => {
        const out = String(stdout || '');
        const lossM = out.match(/([\d.]+)% packet loss/);
        const rttM = out.match(/=\s*[\d.]+\/([\d.]+)\//); // avg
        const loss = lossM ? parseFloat(lossM[1]) : 100;
        const reachable = loss < 100;
        resolve({
          ip,
          reachable,
          packetLoss: loss,
          avgMs: rttM ? parseFloat(rttM[1]) : null,
          message: reachable
            ? `Reachable — ${loss}% loss${rttM ? `, avg ${parseFloat(rttM[1])} ms` : ''}.`
            : `No reply from ${ip}. Check the router is online and that ICMP isn't blocked between the server and the router.`,
          raw: out.trim().split('\n').slice(-4).join('\n'),
          checkedAt: new Date(),
        });
      });
    });
  }

  async syncDetails(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp) throw new Error('NAS IP address not configured');
    if (!nas.apiUsername || !nas.apiPassword) {
      throw new Error('API credentials not configured for this NAS');
    }
    const apiPort = nas.apiPort ?? 8728;
    this.logger.log(`Syncing details for ${nas.nasname} (${nas.nasIp})`);
    return this.mikrotikSync.syncDetails(
      nas.nasIp, apiPort,
      nas.apiUsername,   // string — checked above
      nas.apiPassword,
    );
  }

  async quickCheck(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);
    if (!nas.nasIp || !nas.apiUsername || !nas.apiPassword) {
      return { online: false, identity: '', version: '', cpuLoad: '', uptime: '', activeConnections: 0 };
    }
    const apiPort = nas.apiPort ?? 8728;
    return this.mikrotikSync.quickCheck(
      nas.nasIp, apiPort,
      nas.apiUsername,   // string — checked above
      nas.apiPassword,
    );
  }

  // ── Active sessions from radacct ────────────────────────────
  async getActiveSessions(id: number) {
    const nas = await this.prisma.nas.findUnique({ where: { id } });
    if (!nas) throw new NotFoundException(`NAS with ID ${id} not found`);

    /**
     * Prefer the router's OWN live session list over RADIUS accounting.
     *
     * radacct only knows what accounting packets told it, which is nothing when
     * a router authenticates but never sends accounting — the exact case where
     * "no active users show" despite people being connected. If the NAS has API
     * credentials, ask it directly; fall back to radacct when it doesn't or the
     * API is unreachable. The shape is normalised to what radacct returned so
     * the frontend needs no change.
     */
    if (nas.nasIp && nas.apiUsername) {
      try {
        const live = await this.mikrotikSync.getActivePppoeUsers(
          nas.nasIp, nas.apiPort || 8728, nas.apiUsername, nas.apiPassword || '',
        );
        if (Array.isArray(live) && live.length) {
          const toSecs = (up?: string | null) => {
            // MikroTik uptime like "1h2m3s" → seconds.
            if (!up) return 0;
            let s = 0;
            for (const [, n, u] of up.matchAll(/(\d+)([dhms])/g)) {
              const v = parseInt(n);
              s += u === 'd' ? v * 86400 : u === 'h' ? v * 3600 : u === 'm' ? v * 60 : v;
            }
            return s;
          };
          return live.map((u) => ({
            username:         u.username,
            nasipaddress:     nas.nasIp,
            framedipaddress:  u.address ?? null,
            callingstationid: u.callerId ?? null,
            acctstarttime:    null,
            duration_seconds: toSecs(u.uptime),
            upload_bytes:     u.uploadBytes ?? 0,
            download_bytes:   u.downloadBytes ?? 0,
            source:           'router',
          }));
        }
      } catch { /* API unreachable — fall through to accounting */ }
    }
    // Pass nasIp to filter sessions only for this NAS
    return this.radiusSync.getActiveSessions(nas.nasIp ?? undefined);
  }

  /** Accounting-pipeline health — see RadiusSyncService.accountingHealth. */
  async accountingHealth() {
    return this.radiusSync.accountingHealth();
  }

  // ── RADIUS-wide stats ───────────────────────────────────────
  async getRadiusStats(actor?: any) {
    const [alive, authStats] = await Promise.all([
      this.radiusSync.isRadiusAlive(),
      this.radiusSync.getAuthStats(),
    ]);
    // NEVER expose the real backend/RADIUS host to non-ISP accounts (resellers,
    // demo). They still get the live health + port numbers, but the address is
    // masked — the panel must not leak infrastructure to the downline.
    const isIsp = actor?.role === 'ADMIN' || actor?.role === 'SUPER_ADMIN';
    return {
      ...alive,
      ...authStats,
      serverIp:   isIsp ? (process.env.RADIUS_SERVER_IP || '127.0.0.1') : 'internal',
      radiusPort: parseInt(process.env.RADIUS_AUTH_PORT || '1812'),
      acctPort:   parseInt(process.env.RADIUS_ACCT_PORT || '1813'),
    };
  }

  // ── Debug helper ────────────────────────────────────────────
  async debugRadiusSync() {
    try {
      const [radiusNas, prismaNas] = await Promise.all([
        this.radiusSync.getAllNasFromRadius(),
        this.prisma.nas.findMany(),
      ]);
      return {
        success: true,
        radiusCount: radiusNas.length,
        prismaCount: prismaNas.length,
        radiusNas,
        prismaNas,
      };
    } catch (error: any) {
      this.logger.error(`Debug failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}