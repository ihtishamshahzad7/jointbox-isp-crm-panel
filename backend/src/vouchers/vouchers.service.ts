import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

@Injectable()
export class VouchersService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Vouchers this account may see.
   *
   * Was unscoped, which is worse here than elsewhere: an unused voucher is
   * bearer value. Reading another dealer's unredeemed codes is the same as
   * being handed their money.
   */
  async findAll(actor?: Actor) {
    const where: any = {};
    if (actor && !this.scope.isAdmin(actor.role)) {
      const ids = await this.scope.descendantIds(await this.scope.rootId(actor));
      where.OR = [
        { createdBy: { in: ids } },
        { subscriber: { userId: { in: ids } } },
      ];
    }
    return this.prisma.voucher.findMany({
      where,
      include: { subscriber: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    return this.prisma.voucher.findUnique({
      where: { id },
      include: { subscriber: true },
    });
  }

  async findByCode(code: string) {
    return this.prisma.voucher.findUnique({
      where: { code },
      include: { subscriber: true },
    });
  }

  async getStats() {
    const total = await this.prisma.voucher.count();
    const unused = await this.prisma.voucher.count({ where: { status: 'UNUSED' } });
    const used = await this.prisma.voucher.count({ where: { status: 'USED' } });
    const expired = await this.prisma.voucher.count({ where: { status: 'EXPIRED' } });
    
    const totalAmount = await this.prisma.voucher.aggregate({
      where: { status: 'USED' },
      _sum: { amount: true },
    });
    
    return { total, unused, used, expired, totalRedeemed: totalAmount._sum.amount || 0 };
  }

  async generateVoucherCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 4 === 0) code += '-';
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async createBulk(data: any) {
    const batchNo = `BATCH-${Date.now()}`;
    const vouchers: any[] = [];
    
    for (let i = 0; i < data.quantity; i++) {
      const code = await this.generateVoucherCode();
      const pin = await this.generatePin();
      
      vouchers.push({
        code,
        pin,
        type: data.type,
        amount: parseFloat(data.amount),
        dataQuota: data.dataQuota,
        validityDays: parseInt(data.validityDays),
        batchId: batchNo,
        createdBy: data.createdBy,
        expireDate: new Date(Date.now() + parseInt(data.validityDays) * 24 * 60 * 60 * 1000),
      });
    }
    
    await this.prisma.voucher.createMany({
      data: vouchers,
    });
    
    return { batchNo, count: vouchers.length };
  }

  async redeemVoucher(code: string, pin: string, subscriberId: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code },
    });
    
    if (!voucher) {
      throw new NotFoundException('Voucher not found');
    }
    
    if (voucher.pin !== pin) {
      throw new Error('Invalid PIN');
    }
    
    if (voucher.status !== 'UNUSED') {
      throw new Error(`Voucher is already ${voucher.status}`);
    }
    
    if (voucher.expireDate && new Date() > voucher.expireDate) {
      await this.prisma.voucher.update({
        where: { id: voucher.id },
        data: { status: 'EXPIRED' },
      });
      throw new Error('Voucher has expired');
    }
    
    const subscriber = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
    });
    
    if (!subscriber) {
      throw new NotFoundException('Subscriber not found');
    }
    
    return this.prisma.voucher.update({
      where: { id: voucher.id },
      data: {
        status: 'USED',
        usedBy: subscriberId,
        usedAt: new Date(),
        activatedAt: new Date(),
      },
    });
  }

  async deleteVoucher(id: number) {
    return this.prisma.voucher.delete({ where: { id } });
  }
}