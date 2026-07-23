import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ServiceSettingsService {
  constructor(private prisma: PrismaService) {}

  async findBySubscriber(subscriberId: number) {
    return this.prisma.serviceSettings.findUnique({ where: { subscriberId } });
  }

  async create(subscriberId: number, data: any) {
    return this.prisma.serviceSettings.create({
      data: {
        subscriberId,
        ipAddress:      data.ipAddress,
        ipType:         data.ipType         || 'DYNAMIC',
        macAddress:     data.macAddress,
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
