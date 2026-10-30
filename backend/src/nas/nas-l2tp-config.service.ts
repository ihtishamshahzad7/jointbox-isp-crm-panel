import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsService } from '../common/secrets.service';
import { ScopeService } from '../common/scope.service';
import { L2tpConfigInput, VpnService } from '../vpn/vpn.service';

export type NasL2tpConfigState =
  'draft' | 'validated' | 'approved' | 'active' | 'disabled' | 'failed';

export interface NasL2tpConfigRecord extends L2tpConfigInput {
  nasId: number;
  state: NasL2tpConfigState;
  revision: number;
  valid?: boolean;
  preview?: string;
  masked?: Record<string, unknown>;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  lastAppliedAt?: Date | string | null;
  lastVerifiedAt?: Date | string | null;
  lastError?: string | null;
}

interface NasRadiusSettings {
  server: string;
  authPort: number;
  acctPort: number;
  nasIdentifier: string | null;
  sharedSecret: string | null;
}

interface RouterOsCapabilityCheck {
  osVersion: string;
  supported: { l2tp: boolean; ipsec: boolean; radius: boolean };
  warnings: string[];
  conflicts: string[];
}

@Injectable()
export class NasL2tpConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly secrets: SecretsService,
    private readonly vpn: VpnService,
  ) {}

  private getActorUserId(actor: any): number | null {
    const raw = actor?.sub ?? actor?.id ?? null;
    return raw == null ? null : Number(raw);
  }

  private async ensureAccess(nasId: number, actor: any): Promise<any> {
    await this.scope.assertNas(actor, nasId);
    const nas = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: {
        id: true,
        ownerId: true,
        nasname: true,
        nasIp: true,
        nasIdentifier: true,
        secret: true,
        radiusSecretEnc: true,
      },
    });
    if (!nas) {
      throw new NotFoundException(`NAS ${nasId} not found`);
    }
    if (
      !this.scope.isPlatformOwner(actor) &&
      Number(nas.ownerId) !== this.scope.actorId(actor)
    ) {
      throw new ForbiddenException(
        'Only the NAS owner can manage its VPN configuration.',
      );
    }
    return nas;
  }

  private radiusSettings(nas: any, configRow?: any): NasRadiusSettings {
    const envPort = (name: string, fallback: number) => {
      const value = Number(process.env[name]);
      return Number.isInteger(value) && value > 0 && value <= 65535
        ? value
        : fallback;
    };
    const sharedSecret =
      this.decryptSecret(nas.radiusSecretEnc) ??
      this.decryptSecret(nas.secret) ??
      this.decryptSecret(configRow?.radiusSharedSecretEnc);

    return {
      server: process.env.RADIUS_SERVER_IP || '127.0.0.1',
      authPort: envPort('RADIUS_AUTH_PORT', 1812),
      acctPort: envPort('RADIUS_ACCT_PORT', 1813),
      nasIdentifier: nas.nasIdentifier || nas.nasname || null,
      sharedSecret,
    };
  }

  private useCentralRadius(
    input: L2tpConfigInput,
    settings: NasRadiusSettings,
  ): L2tpConfigInput {
    return {
      ...input,
      radiusServer: settings.server,
      radiusAuthPort: settings.authPort,
      radiusAcctPort: settings.acctPort,
      nasIdentifier: settings.nasIdentifier ?? undefined,
      radiusSharedSecret: settings.sharedSecret ?? undefined,
    };
  }

  private publicRadius(settings: NasRadiusSettings) {
    return {
      provider: 'FreeRADIUS',
      server: settings.server,
      authPort: settings.authPort,
      acctPort: settings.acctPort,
      nasIdentifier: settings.nasIdentifier,
      sharedSecretConfigured: Boolean(settings.sharedSecret),
      subscriberStore: 'central',
    };
  }

  private encryptSecret(value?: string): string | null {
    if (value == null || value === '') return null;
    return this.secrets.encryptValue(value);
  }

  private decryptSecret(value?: string | null): string | null {
    if (!value) return null;
    return this.secrets.decryptValue(value) ?? null;
  }

  private sanitizeRecord(row: any): NasL2tpConfigRecord | null {
    if (!row) return null;
    const masked = {
      configurationName: row.configurationName ?? undefined,
      nasName: row.nasName ?? undefined,
      publicHost: row.publicHost ?? undefined,
      routerManagementIp: row.routerManagementIp ?? undefined,
      ipsecPsk: row.ipsecPskEnc ? '********' : undefined,
      radiusSharedSecret: row.radiusSharedSecretEnc ? '********' : undefined,
      radiusServer: row.radiusServer ?? undefined,
      radiusSourceIp: row.radiusSourceIp ?? undefined,
      pppProfile: row.pppProfile ?? undefined,
      clientPool: row.clientPool ?? undefined,
    };

    return {
      nasId: Number(row.nasId),
      state: (row.state as NasL2tpConfigState) || 'draft',
      revision: Number(row.revision || 1),
      publicHost: row.publicHost ?? undefined,
      routerManagementIp: row.routerManagementIp ?? undefined,
      l2tpEnabled: row.l2tpEnabled ?? true,
      ipsecEnabled: row.ipsecEnabled ?? true,
      pppProfile: row.pppProfile ?? undefined,
      clientPool: row.clientPool ?? undefined,
      dnsServers: Array.isArray(row.dnsServers) ? row.dnsServers : [],
      mtu: row.mtu ?? undefined,
      mru: row.mru ?? undefined,
      maxSessions: row.maxSessions ?? undefined,
      idleTimeout: row.idleTimeout ?? undefined,
      sessionTimeout: row.sessionTimeout ?? undefined,
      radiusServer: row.radiusServer ?? undefined,
      radiusAuthPort: row.radiusAuthPort ?? 1812,
      radiusAcctPort: row.radiusAcctPort ?? 1813,
      nasIdentifier: row.nasIdentifier ?? undefined,
      radiusSourceIp: row.radiusSourceIp ?? undefined,
      masked,
      preview: row.preview ?? undefined,
      valid: row.state === 'validated' || row.state === 'active',
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      lastAppliedAt: row.lastAppliedAt ?? null,
      lastVerifiedAt: row.lastVerifiedAt ?? null,
      lastError: row.lastError ?? null,
    };
  }

  private buildInputFromDb(row: any): L2tpConfigInput {
    return {
      configurationName: row.configurationName ?? 'uplinko-l2tp',
      publicHost: row.publicHost ?? undefined,
      routerManagementIp: row.routerManagementIp ?? undefined,
      l2tpEnabled: row.l2tpEnabled ?? true,
      ipsecEnabled: row.ipsecEnabled ?? true,
      ipsecPsk: this.decryptSecret(row.ipsecPskEnc) ?? undefined,
      pppProfile: row.pppProfile ?? undefined,
      clientPool: row.clientPool ?? undefined,
      dnsServers: Array.isArray(row.dnsServers) ? row.dnsServers : [],
      mtu: row.mtu ?? undefined,
      mru: row.mru ?? undefined,
      maxSessions: row.maxSessions ?? undefined,
      idleTimeout: row.idleTimeout ?? undefined,
      sessionTimeout: row.sessionTimeout ?? undefined,
      radiusServer: row.radiusServer ?? undefined,
      radiusAuthPort: row.radiusAuthPort ?? 1812,
      radiusAcctPort: row.radiusAcctPort ?? 1813,
      nasIdentifier: row.nasIdentifier ?? undefined,
      radiusSourceIp: row.radiusSourceIp ?? undefined,
      radiusSharedSecret:
        this.decryptSecret(row.radiusSharedSecretEnc) ?? undefined,
    };
  }

  private normalizePayload(
    input: Partial<L2tpConfigInput>,
    actorUserId: number | null,
    state: 'draft' | 'validated' | 'failed' = 'draft',
  ) {
    const dnsServers = Array.isArray(input.dnsServers)
      ? input.dnsServers.filter(Boolean)
      : [];
    const data: any = {
      publicHost: input.publicHost ?? undefined,
      routerManagementIp: input.routerManagementIp ?? undefined,
      l2tpEnabled: input.l2tpEnabled ?? true,
      ipsecEnabled: input.ipsecEnabled ?? true,
      pppProfile: input.pppProfile ?? undefined,
      clientPool: input.clientPool ?? undefined,
      dnsServers,
      mtu: input.mtu ?? undefined,
      mru: input.mru ?? undefined,
      maxSessions: input.maxSessions ?? undefined,
      idleTimeout: input.idleTimeout ?? undefined,
      sessionTimeout: input.sessionTimeout ?? undefined,
      radiusServer: input.radiusServer ?? undefined,
      radiusAuthPort: input.radiusAuthPort ?? 1812,
      radiusAcctPort: input.radiusAcctPort ?? 1813,
      nasIdentifier: input.nasIdentifier ?? undefined,
      radiusSourceIp: input.radiusSourceIp ?? undefined,
      state,
      updatedById: actorUserId,
    };

    if (input.ipsecPsk !== undefined) {
      data.ipsecPskEnc = this.encryptSecret(input.ipsecPsk) ?? null;
    }
    if (input.configurationName !== undefined) {
      data.configurationName = input.configurationName;
    }

    return data;
  }

  async getForNas(
    nasId: number,
    actor: any,
  ): Promise<NasL2tpConfigRecord | null> {
    await this.ensureAccess(nasId, actor);
    const row = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    return this.sanitizeRecord(row);
  }

  async getRadiusForNas(nasId: number, actor: any) {
    const nas = await this.ensureAccess(nasId, actor);
    const config = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    return this.publicRadius(this.radiusSettings(nas, config));
  }

  async saveDraft(
    nasId: number,
    input: Partial<L2tpConfigInput>,
    actor: any,
  ): Promise<NasL2tpConfigRecord> {
    const nas = await this.ensureAccess(nasId, actor);
    const actorUserId = this.getActorUserId(actor);
    const current = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    const radius = this.radiusSettings(nas, current);
    const source = this.useCentralRadius(input, radius);
    const data = this.normalizePayload(source, actorUserId, 'draft');
    const row = await this.prisma.nasL2tpConfig.upsert({
      where: { nasId },
      create: {
        nasId,
        ...data,
        createdById: actorUserId,
        createdAt: new Date(),
      },
      update: {
        ...data,
        updatedById: actorUserId,
      },
    });

    return this.sanitizeRecord(row) as NasL2tpConfigRecord;
  }

  async validateForNas(
    nasId: number,
    input?: Partial<L2tpConfigInput>,
    actor?: any,
  ): Promise<any> {
    const nas = await this.ensureAccess(nasId, actor);
    const current = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    const proposed = input
      ? { ...this.buildInputFromDb(current ?? {}), ...input }
      : this.buildInputFromDb(current ?? {});
    const radius = this.radiusSettings(nas, current);
    const source = this.useCentralRadius(proposed, radius);
    const preview = this.vpn.validateL2tpConfig(source);
    const nextState = preview.valid ? 'validated' : 'failed';

    if (current || input) {
      const payload = this.normalizePayload(
        source,
        this.getActorUserId(actor),
        nextState,
      );
      await this.prisma.nasL2tpConfig.upsert({
        where: { nasId },
        create: {
          nasId,
          ...payload,
          createdById: this.getActorUserId(actor),
          createdAt: new Date(),
        },
        update: {
          ...payload,
          updatedById: this.getActorUserId(actor),
          lastError: preview.errors.join('; ') || null,
        },
      });
    }

    return {
      valid: preview.valid,
      state: nextState,
      warnings: preview.warnings,
      errors: preview.errors,
      preview: preview.preview,
      masked: preview.masked,
      authentication: this.publicRadius(radius),
      simulated: true,
    };
  }

  async previewChanges(
    nasId: number,
    input: Partial<L2tpConfigInput>,
    actor: any,
  ): Promise<any> {
    const nas = await this.ensureAccess(nasId, actor);

    const current = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    const base = current ? this.buildInputFromDb(current) : {};
    const radius = this.radiusSettings(nas, current);
    const proposed = this.useCentralRadius({ ...base, ...input }, radius);
    const preview = this.vpn.validateL2tpConfig(proposed);

    return {
      current: current ? this.sanitizeRecord(current) : null,
      proposed: preview.masked,
      valid: preview.valid,
      warnings: preview.warnings,
      errors: preview.errors,
      preview: preview.preview,
      authentication: this.publicRadius(radius),
      simulated: true,
    };
  }

  async approveForNas(nasId: number, actor: any): Promise<any> {
    const nas = await this.ensureAccess(nasId, actor);
    const row = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    if (!row) {
      throw new BadRequestException(
        'No L2TP/IPsec configuration exists for this NAS yet.',
      );
    }
    if (row.state !== 'validated') {
      throw new BadRequestException(
        'Configuration must be validated before it can be approved.',
      );
    }
    const radius = this.radiusSettings(nas, row);
    const preview = this.vpn.validateL2tpConfig(
      this.useCentralRadius(this.buildInputFromDb(row), radius),
    );
    if (!preview.valid) {
      throw new BadRequestException(
        'Configuration is not valid and cannot be approved.',
      );
    }
    const updated = await this.prisma.nasL2tpConfig.update({
      where: { nasId },
      data: {
        state: 'approved',
        updatedById: this.getActorUserId(actor),
        revision: (row.revision ?? 1) + 1,
      },
    });

    return {
      ...this.sanitizeRecord(updated),
      approvalRequired: false,
      approved: true,
    };
  }

  async applyApproved(nasId: number, actor: any): Promise<any> {
    const nas = await this.ensureAccess(nasId, actor);
    const row = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    if (!row) {
      throw new BadRequestException(
        'No L2TP/IPsec configuration exists for this NAS yet.',
      );
    }
    if (row.state !== 'approved') {
      throw new BadRequestException(
        'Configuration must be approved before an apply attempt.',
      );
    }
    const radius = this.radiusSettings(nas, row);
    const validation = this.vpn.validateL2tpConfig(
      this.useCentralRadius(this.buildInputFromDb(row), radius),
    );
    if (!validation.valid) {
      throw new BadRequestException(
        'Cannot apply invalid L2TP/IPsec configuration.',
      );
    }

    const cap = await this.capabilityCheck(nasId);
    const result = {
      applied: false,
      simulated: true,
      mode: 'simulated',
      deviceVerified: false,
      verificationStatus: 'not-verified',
      osVersion: cap.osVersion,
      capabilityWarnings: cap.warnings,
      conflicts: cap.conflicts,
      message:
        'Preview-only simulation — no live RouterOS command was executed and no device verification was claimed.',
    };

    return {
      ...this.sanitizeRecord(row),
      ...result,
      applyStatus: 'not_configured',
    };
  }

  async rollback(nasId: number, actor: any): Promise<any> {
    await this.ensureAccess(nasId, actor);
    const row = await this.prisma.nasL2tpConfig.findUnique({
      where: { nasId },
    });
    if (!row) {
      throw new BadRequestException(
        'No saved L2TP/IPsec configuration exists to roll back.',
      );
    }

    return {
      nasId,
      rolledBack: false,
      simulated: true,
      state: row.state,
      rollbackStatus: 'not_configured',
      message:
        'No live RouterOS rollback was executed; the saved configuration state is unchanged.',
    };
  }

  async getActivity(nasId: number, actor: any) {
    await this.ensureAccess(nasId, actor);
    const rows = await this.prisma.activityLog.findMany({
      where: { entity: 'nas', entityId: nasId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        action: true,
        details: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    const route = `/nas/${nasId}/`;
    return rows
      .filter(
        (row: any) =>
          typeof row.details === 'string' &&
          row.details.includes(route) &&
          /l2tp-config|\/tunnel|vpn\/discover-neighbors/.test(row.details),
      )
      .slice(0, 25)
      .map((row: any) => ({
        id: String(row.id),
        action: row.action,
        actor: row.user?.name ?? 'Operator',
        createdAt: row.createdAt,
      }));
  }

  private async capabilityCheck(
    nasId: number,
  ): Promise<RouterOsCapabilityCheck> {
    const row = await this.prisma.nas.findUnique({
      where: { id: nasId },
      select: { nasname: true, type: true },
    });
    return {
      osVersion: row?.type === 'MIKROTIK' ? 'unknown' : 'unknown',
      supported: { l2tp: false, ipsec: false, radius: false },
      warnings: [
        'No live RouterOS capability check was performed; actual support requires a verified device connection.',
      ],
      conflicts: [],
    };
  }
}
