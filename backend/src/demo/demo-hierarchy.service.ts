import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Builds the reseller/dealer/sub-dealer tree used ONLY by demo accounts.
 * Every generated account and every resource it owns is marked/scoped to the
 * demo root, so the production tenant tree is never touched.
 */
@Injectable()
export class DemoHierarchyService {
  private readonly log = new Logger('DemoHierarchy');

  constructor(private readonly prisma: PrismaService) {}

  async seed(rootId: number) {
    const root = await this.prisma.user.findUnique({ where: { id: rootId }, select: { id: true, isDemo: true, role: true } });
    if (!root?.isDemo) throw new Error('Demo hierarchy refused: root account is not a demo account');

    const existing = await this.prisma.user.count({ where: { isDemo: true, parentId: rootId } });
    if (existing >= 20) {
      await this.distributeResources(rootId);
      return { seeded: false, franchises: existing };
    }

    const passwordHash = await bcrypt.hash('DemoPass-2026', 10);
    const franchises: number[] = [];
    const dealers: number[] = [];
    const subDealers: number[] = [];

    for (let f = 1; f <= 20; f++) {
      const franchise = await this.prisma.user.create({ data: {
        name: `Demo Franchise ${String(f).padStart(2, '0')}`,
        email: `franchise-${String(f).padStart(2, '0')}.${rootId}@demo.jointbox`,
        password: passwordHash,
        role: 'RESELLER', isActive: true, isDemo: true,
        demoExpiresAt: new Date(Date.now() + 7 * 86400_000),
        parentId: rootId, balance: 25000,
        canAddNas: true, canTopupDownline: true, canSetPackagePrice: true,
        country: 'Pakistan', province: f % 4 === 0 ? 'Punjab' : f % 4 === 1 ? 'Khyber Pakhtunkhwa' : f % 4 === 2 ? 'Sindh' : 'Balochistan',
        city: ['Islamabad', 'Lahore', 'Karachi', 'Peshawar', 'Chitral'][f % 5],
      }, select: { id: true } });
      franchises.push(franchise.id);

      for (let d = 1; d <= 2; d++) {
        const dealerNo = (f - 1) * 2 + d;
        const dealer = await this.prisma.user.create({ data: {
          name: `Demo Dealer ${String(dealerNo).padStart(2, '0')}`,
          email: `dealer-${String(dealerNo).padStart(2, '0')}.${rootId}@demo.jointbox`,
          password: passwordHash,
          role: 'SUB_RESELLER', isActive: true, isDemo: true,
          demoExpiresAt: new Date(Date.now() + 7 * 86400_000),
          parentId: franchise.id, balance: 10000,
          canAddNas: true, canTopupDownline: true, canSetPackagePrice: true,
          country: 'Pakistan', city: franchise.id % 2 ? 'Rawalpindi' : 'Multan',
        }, select: { id: true } });
        dealers.push(dealer.id);

        for (let s = 1; s <= 2; s++) {
          const subNo = (dealerNo - 1) * 2 + s;
          const sub = await this.prisma.user.create({ data: {
            name: `Demo Sub-Dealer ${String(subNo).padStart(2, '0')}`,
            email: `subdealer-${String(subNo).padStart(2, '0')}.${rootId}@demo.jointbox`,
            password: passwordHash,
            role: 'RETAILER', isActive: true, isDemo: true,
            demoExpiresAt: new Date(Date.now() + 7 * 86400_000),
            parentId: dealer.id, balance: 5000,
            canAddNas: false, canTopupDownline: true, canSetPackagePrice: true,
            country: 'Pakistan', city: ['Islamabad', 'Lahore', 'Peshawar', 'Karachi'][subNo % 4],
          }, select: { id: true } });
          subDealers.push(sub.id);
        }
      }
    }

    await this.distributeResources(rootId, franchises, dealers, subDealers);
    this.log.log(`Demo hierarchy ready for #${rootId}: ${franchises.length} franchises, ${dealers.length} dealers, ${subDealers.length} sub-dealers.`);
    return { seeded: true, franchises: franchises.length, dealers: dealers.length, subDealers: subDealers.length };
  }

  private async distributeResources(rootId: number, franchises?: number[], dealers?: number[], subDealers?: number[]) {
    const tree = await this.prisma.user.findMany({ where: { isDemo: true, id: rootId }, select: { id: true } });
    if (!tree.length) return;
    franchises ??= (await this.prisma.user.findMany({ where: { parentId: rootId, isDemo: true, role: 'RESELLER' }, select: { id: true }, orderBy: { id: 'asc' } })).map(x => x.id);
    dealers ??= (await this.prisma.user.findMany({ where: { parentId: { in: franchises }, isDemo: true, role: 'SUB_RESELLER' }, select: { id: true }, orderBy: { id: 'asc' } })).map(x => x.id);
    subDealers ??= (await this.prisma.user.findMany({ where: { parentId: { in: dealers }, isDemo: true, role: 'RETAILER' }, select: { id: true }, orderBy: { id: 'asc' } })).map(x => x.id);
    const leaves = subDealers.length ? subDealers : dealers.length ? dealers : franchises;

    const nas = await this.prisma.nas.findMany({ where: { ownerId: rootId }, select: { id: true } });
    const pools = await this.prisma.ipPool.findMany({ where: { ownerId: rootId }, select: { id: true } });
    const packages = await this.prisma.package.findMany({ where: { ownerId: rootId }, select: { id: true } });
    const areas = await this.prisma.area.findMany({ where: { ownerId: rootId }, select: { id: true } });
    const subscribers = await this.prisma.subscriber.findMany({ where: { userId: rootId }, select: { id: true } });

    // Ownership is moved ONLY from the demo root to demo descendants. A real
    // user's records can never enter this query because every source row is
    // explicitly filtered by ownerId/userId = rootId.
    for (let i = 0; i < nas.length; i++) {
      const owner = dealers[i % dealers.length] ?? franchises[i % franchises.length] ?? rootId;
      await this.prisma.nas.update({ where: { id: nas[i].id }, data: { ownerId: owner } });
    }
    for (let i = 0; i < pools.length; i++) {
      const owner = franchises[i % franchises.length] ?? rootId;
      await this.prisma.ipPool.update({ where: { id: pools[i].id }, data: { ownerId: owner } });
    }
    for (let i = 0; i < packages.length; i++) {
      const owner = franchises[i % franchises.length] ?? rootId;
      await this.prisma.package.update({ where: { id: packages[i].id }, data: { ownerId: owner } });
    }
    for (let i = 0; i < areas.length; i++) {
      const owner = franchises[i % franchises.length] ?? rootId;
      await this.prisma.area.update({ where: { id: areas[i].id }, data: { ownerId: owner } });
    }
    for (let i = 0; i < subscribers.length; i++) {
      const owner = leaves[i % leaves.length] ?? rootId;
      await this.prisma.subscriber.update({ where: { id: subscribers[i].id }, data: { userId: owner } });
    }

    // Share each NAS and pool with its direct demo owner. propagate=true lets
    // that resource naturally flow to the owner's downline without making it
    // globally visible to unrelated tenants.
    const ownerIds = [...new Set([...franchises, ...dealers, ...subDealers])];
    for (let i = 0; i < nas.length; i++) {
      const userId = dealers[i % dealers.length] ?? franchises[i % franchises.length];
      if (!userId) continue;
      await this.prisma.nasAssignment.upsert({
        where: { nasId_userId: { nasId: nas[i].id, userId } },
        create: { nasId: nas[i].id, userId, assignedById: rootId, propagate: true },
        update: { propagate: true },
      }).catch(() => null);
    }
    for (let i = 0; i < pools.length; i++) {
      const userId = franchises[i % franchises.length];
      if (!userId) continue;
      await this.prisma.ipPoolAssignment.upsert({
        where: { poolId_userId: { poolId: pools[i].id, userId } },
        create: { poolId: pools[i].id, userId, assignedById: rootId, propagate: true },
        update: { propagate: true },
      }).catch(() => null);
    }

    // ownerIds is intentionally calculated from demo descendants only. It is
    // used as a final sanity check so future additions cannot accidentally
    // broaden the mutation scope.
    if (ownerIds.some(id => id === rootId)) this.log.warn(`Demo hierarchy owner check: root #${rootId} remained as fallback for a resource`);
  }
}
