import { Injectable, Logger } from '@nestjs/common';
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

  async create(subscriberId: number, data: any) {
    const created = await this.prisma.serviceSettings.create({
      data: {
        subscriberId,
        ipAddress:      data.ipAddress,
        ipType:         data.ipType         || 'DYNAMIC',
        macAddress:     data.macAddress,
        ipv6Prefix:          data.ipv6Prefix || null,
        ipv6DelegatedPrefix: data.ipv6DelegatedPrefix || null,
        quota:          data.quota,
        quotaUsed:      data.quotaUsed      ? parseFloat(data.quotaUsed)  : 0,
        quotaResetDate: data.quotaResetDate ? new Date(data.quotaResetDate) : null,
        expiryDate:     data.expiryDate     ? new Date(data.expiryDate)   : null,
        duration:       data.duration       ? parseInt(data.duration)     : null,
        discountType:   data.discountType   || 'NONE',
        discountValue:  parseFloat(data.discountValue)  || 0,
        customPrice:    data.customPrice    ? parseFloat(data.customPrice) : null,
        ontSerial:      data.ontSerial,
        ontModel:       data.ontModel,
        signalLevel:    data.signalLevel    ? parseFloat(data.signalLevel) : null,
        rxPower:        data.rxPower        ? parseFloat(data.rxPower)    : null,
        txPower:        data.txPower        ? parseFloat(data.txPower)    : null,
        uploadSpeed:    data.uploadSpeed,
        downloadSpeed:  data.downloadSpeed,
        vlanId:         data.vlanId         ? parseInt(data.vlanId)       : null,
        pptpUsername:   data.pptpUsername,
        pptpPassword:   data.pptpPassword,
        notes:          data.notes,
        technicalNotes: data.technicalNotes,
        isStaticIp:     data.isStaticIp  === 'true' || data.isStaticIp  === true,
        hasBackup:      data.hasBackup   === 'true' || data.hasBackup   === true,
        isBlocked:      data.isBlocked   === 'true' || data.isBlocked   === true,
        /**
         * Auto-renewal opt-in. Tri-state on purpose, unlike the booleans
         * above: those coerce a missing value to `false`, which here would
         * silently switch auto-renewal OFF for a subscriber every time any
         * unrelated field was saved from a form that does not include it.
         * `undefined` leaves the column alone; only an explicit value changes
         * it.
         */
        autoRenew:
          data.autoRenew === undefined
            ? undefined
            : data.autoRenew === 'true' || data.autoRenew === true,
      },
    });
    await this.syncAfterWrite(subscriberId);
    return created;
  }

  async update(subscriberId: number, data: any) {
    const updated = await this.prisma.serviceSettings.update({
      where: { subscriberId },
      data: {
        ipAddress:      data.ipAddress,
        ipType:         data.ipType,
        macAddress:     data.macAddress,
        ipv6Prefix:          data.ipv6Prefix ?? undefined,
        ipv6DelegatedPrefix: data.ipv6DelegatedPrefix ?? undefined,
        quota:          data.quota,
        quotaUsed:      data.quotaUsed      ? parseFloat(data.quotaUsed)  : 0,
        quotaResetDate: data.quotaResetDate ? new Date(data.quotaResetDate) : null,
        expiryDate:     data.expiryDate     ? new Date(data.expiryDate)   : null,
        duration:       data.duration       ? parseInt(data.duration)     : null,
        discountType:   data.discountType,
        discountValue:  parseFloat(data.discountValue)  || 0,
        customPrice:    data.customPrice    ? parseFloat(data.customPrice) : null,
        ontSerial:      data.ontSerial,
        ontModel:       data.ontModel,
        signalLevel:    data.signalLevel    ? parseFloat(data.signalLevel) : null,
        rxPower:        data.rxPower        ? parseFloat(data.rxPower)    : null,
        txPower:        data.txPower        ? parseFloat(data.txPower)    : null,
        uploadSpeed:    data.uploadSpeed,
        downloadSpeed:  data.downloadSpeed,
        vlanId:         data.vlanId         ? parseInt(data.vlanId)       : null,
        pptpUsername:   data.pptpUsername,
        pptpPassword:   data.pptpPassword,
        notes:          data.notes,
        technicalNotes: data.technicalNotes,
        isStaticIp:     data.isStaticIp  === 'true' || data.isStaticIp  === true,
        hasBackup:      data.hasBackup   === 'true' || data.hasBackup   === true,
        isBlocked:      data.isBlocked   === 'true' || data.isBlocked   === true,
        /**
         * Auto-renewal opt-in. Tri-state on purpose, unlike the booleans
         * above: those coerce a missing value to `false`, which here would
         * silently switch auto-renewal OFF for a subscriber every time any
         * unrelated field was saved from a form that does not include it.
         * `undefined` leaves the column alone; only an explicit value changes
         * it.
         */
        autoRenew:
          data.autoRenew === undefined
            ? undefined
            : data.autoRenew === 'true' || data.autoRenew === true,
      },
    });
    await this.syncAfterWrite(subscriberId);
    return updated;
  }

  async upsert(subscriberId: number, data: any) {
    const existing = await this.findBySubscriber(subscriberId);
    if (existing) return this.update(subscriberId, data);
    return this.create(subscriberId, data);
  }
}
