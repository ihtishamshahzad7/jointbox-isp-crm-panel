import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { allocateIpv6, ipv6AutoConfig } from '../nas/ipv6-alloc';

@Injectable()
export class ServiceSettingsService {
  constructor(private prisma: PrismaService) {}

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
    return this.prisma.serviceSettings.create({
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
      },
    });
  }

  async update(subscriberId: number, data: any) {
    return this.prisma.serviceSettings.update({
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
      },
    });
  }

  async upsert(subscriberId: number, data: any) {
    const existing = await this.findBySubscriber(subscriberId);
    if (existing) return this.update(subscriberId, data);
    return this.create(subscriberId, data);
  }
}
