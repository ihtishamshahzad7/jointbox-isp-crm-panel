import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { allocateIpv6, ipv6AutoConfig } from '../nas/ipv6-alloc';
import { SubscribersService } from '../subscribers/subscribers.service';

@Injectable()
export class ServiceSettingsService {
  private readonly logger = new Logger(ServiceSettingsService.name);

  constructor(
    private prisma: PrismaService,
    // Needed so a change to ipType/ipAddress/macAddress actually reaches
    // RADIUS — see syncAfterWrite() below.
    private subscribers: SubscribersService,
  ) {}

  /**
   * Push the subscriber's profile to RADIUS after a settings write.
   *
   * THE BUG THIS FIXES: this service wrote ipType/ipAddress/macAddress
   * straight to ServiceSettings and stopped there. Nothing re-synced RADIUS,
   * so setting a customer to STATIC with an address through the Service
   * Settings form updated the panel's own database and NOTHING ELSE — no
   * Framed-IP-Address in radreply, no MAC binding. The panel then displayed
   * the static IP it had faithfully saved while the NAS, which had never been
   * told, kept handing out a pool address on every reconnect.
   *
   * syncToRadius() rewrites the whole profile from current settings, so it
   * covers all three directions: DYNAMIC→STATIC writes Framed-IP-Address,
   * STATIC→DYNAMIC drops it and restores the package's Framed-Pool, and
   * changing the address just replaces the value.
   *
   * Deliberately non-fatal: a RADIUS hiccup must not make saving the form
   * fail and lose the operator's other edits. It is logged loudly, and the
   * nightly integrity sweep re-syncs anything that drifted.
   */
  private async syncAfterWrite(subscriberId: number) {
    try {
      await this.subscribers.syncToRadius(subscriberId);
    } catch (e: any) {
      this.logger.error(
        `Service settings saved for subscriber #${subscriberId}, but the RADIUS ` +
          `re-sync failed (${e?.message || e}). The addressing change will NOT ` +
          `apply until the profile is synced — use "Sync to RADIUS" on the subscriber.`,
      );
    }
  }

  async findBySubscriber(subscriberId: number) {
    return this.prisma.serviceSettings.findUnique({ where: { subscriberId } });
  }

  /**
   * The IPv6 the subscriber will actually receive: a manual override if set,
   * otherwise the auto-allocated prefix from the configured pool (or none if
   * IPv6 is off). Shown read-only on the profile so staff can see it.
   */
  async resolveIpv6(subscriberId: number) {
    const ss = await this.prisma.serviceSettings.findUnique({
      where: { subscriberId },
      select: { ipv6Prefix: true, ipv6DelegatedPrefix: true } as any,
    }).catch(() => null) as any;
    let framed = ss?.ipv6Prefix || null;
    let delegated = ss?.ipv6DelegatedPrefix || null;
    const manual = !!(framed || delegated);
    const cfg = ipv6AutoConfig();
    if (cfg.enabled) {
      if (!framed && cfg.framedBase) framed = allocateIpv6(cfg.framedBase, cfg.framedBaseBits, cfg.framedSize, subscriberId);
      if (!delegated && cfg.delegatedBase) delegated = allocateIpv6(cfg.delegatedBase, cfg.delegatedBaseBits, cfg.delegatedSize, subscriberId);
    }
    return {
      framedPrefix: framed,
      delegatedPrefix: delegated,
      source: manual ? 'manual' : (framed || delegated) ? 'auto' : 'none',
      autoEnabled: cfg.enabled,
    };
  }

  /**
   * Only the fields the caller actually sent. The subscriber screen saves one
   * toggle at a time ({ allowMultipleSessions }), and every missing field was
   * written as null/0/false — so flipping "multiple sessions" wiped the
   * customer's expiry date, duration, VLAN and static-IP flag (and the toggle
   * itself was never saved).
   */
  private toData(data: any): Record<string, any> {
    const d = data || {};
    const out: Record<string, any> = {};
    const has = (k: string) => d[k] !== undefined;
    const num = (v: any, int = false) => (v === null || v === '' ? null : int ? parseInt(v) : parseFloat(v));
    const date = (v: any) => (v ? new Date(v) : null);
    const bool = (v: any) => v === true || v === 'true';
    const str = (v: any) => (v === null || v === '' ? null : String(v));
    for (const k of ['ipAddress', 'macAddress', 'ipv6Prefix', 'ipv6DelegatedPrefix', 'ontSerial', 'ontModel',
      'uploadSpeed', 'downloadSpeed', 'pptpUsername', 'pptpPassword', 'notes', 'technicalNotes', 'quota']) {
      if (has(k)) out[k] = str(d[k]);
    }
    if (has('ipType')) out.ipType = d.ipType || 'DYNAMIC';
    if (has('discountType')) out.discountType = d.discountType || 'NONE';
    for (const k of ['quotaUsed', 'discountValue']) if (has(k)) out[k] = num(d[k]) ?? 0;
    for (const k of ['customPrice', 'signalLevel', 'rxPower', 'txPower']) if (has(k)) out[k] = num(d[k]);
    for (const k of ['duration', 'vlanId']) if (has(k)) out[k] = num(d[k], true);
    for (const k of ['quotaResetDate', 'expiryDate']) if (has(k)) out[k] = date(d[k]);
    for (const k of ['isStaticIp', 'hasBackup', 'isBlocked', 'autoRenew', 'allowMultipleSessions']) {
      if (has(k)) out[k] = bool(d[k]);
    }
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new BadRequestException(`${k} is not a valid number.`);
      if (v instanceof Date && isNaN(v.getTime())) throw new BadRequestException(`${k} is not a valid date.`);
    }
    return out;
  }

  /**
   * Expiry, term, price, discount, usage and addressing are what the customer
   * PAYS for. Activation / renewal / the static-IP register set them with the
   * wallet charge; editing them here skipped it (a dealer set expiry to 2035).
   * Only the company's own account may hand-correct them.
   */
  private static readonly BILLED = ['expiryDate', 'duration', 'customPrice', 'discountType', 'discountValue',
    'quotaUsed', 'quotaResetDate', 'quota', 'ipAddress', 'ipType', 'isStaticIp'];

  private assertMayEdit(actor: { role?: string } | undefined, data: Record<string, any>) {
    if (!actor || actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN') return;
    const hit = ServiceSettingsService.BILLED.filter((k) => data[k] !== undefined);
    if (hit.length) {
      throw new ForbiddenException(
        `Only your company account can change ${hit.join(', ')} here. Use Activate/Renew, or the Static IP screen.`,
      );
    }
  }

  async create(subscriberId: number, data: any, actor?: { role?: string }) {
    const fields = this.toData(data);
    this.assertMayEdit(actor, fields);
    const created = await this.prisma.serviceSettings.create({
      data: { subscriberId, ...fields } as any,
    });
    await this.syncAfterWrite(subscriberId);
    return created;
  }

  async update(subscriberId: number, data: any, actor?: { role?: string }) {
    const fields = this.toData(data);
    this.assertMayEdit(actor, fields);
    const updated = await this.prisma.serviceSettings.update({
      where: { subscriberId },
      data: fields,
    });
    await this.syncAfterWrite(subscriberId);
    return updated;
  }

  async upsert(subscriberId: number, data: any, actor?: { role?: string }) {
    const existing = await this.findBySubscriber(subscriberId);
    if (existing) return this.update(subscriberId, data, actor);
    return this.create(subscriberId, data, actor);
  }
}
