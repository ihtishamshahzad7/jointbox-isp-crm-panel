import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DemoService } from './demo.service';

/**
 * Keeps the shared demo account usable after hierarchy distribution.
 *
 * The hierarchy is still created for demonstration, but the shared demo login
 * must be able to show the complete synthetic dataset. This repair only ever
 * touches rows owned by demo accounts and never changes real-tenant rows.
 */
@Injectable()
export class DemoRepairService implements OnModuleInit {
  private readonly log = new Logger('DemoRepair');

  constructor(
    private readonly prisma: PrismaService,
    private readonly demo: DemoService,
  ) {}

  async onModuleInit() {
    // DemoService also initializes on module startup. Delay this repair so its
    // normal seed/hierarchy pass can finish before ownership is normalized.
    setTimeout(() => this.repair().catch((e) => this.log.warn(`Demo repair failed: ${e?.message || e}`)), 5000);
  }

  private async repair() {
    if (process.env.DEMO_PUBLIC === '0') return;

    await this.demo.ensureShared();
    const email = (process.env.DEMO_EMAIL || 'demo@jointbox.net').trim().toLowerCase();
    const root = await this.prisma.user.findFirst({ where: { email, isDemo: true }, select: { id: true } });
    if (!root) return;

    const rows = await this.prisma.$queryRaw<Array<{ id: number }>>`
      WITH RECURSIVE t AS (
        SELECT id FROM "User" WHERE id = ${root.id} AND "isDemo" = true
        UNION ALL
        SELECT u.id FROM "User" u JOIN t ON u."parentId" = t.id WHERE u."isDemo" = true
      )
      SELECT id FROM t`;
    const ids = rows.map((r) => Number(r.id));
    if (!ids.length) return;

    const [subscriberCount, nasCount, poolCount, packageCount, areaCount] = await Promise.all([
      this.prisma.subscriber.count({ where: { userId: { in: ids } } }),
      this.prisma.nas.count({ where: { ownerId: { in: ids } } }),
      this.prisma.ipPool.count({ where: { ownerId: { in: ids } } }),
      this.prisma.package.count({ where: { ownerId: { in: ids } } }),
      this.prisma.area.count({ where: { ownerId: { in: ids } } }),
    ]);

    // Normalize ownership back to the shared demo root so the existing
    // production ScopeService exposes the entire demo dataset to demo@...
    // without weakening isolation for real users.
    if (subscriberCount) await this.prisma.subscriber.updateMany({ where: { userId: { in: ids }, NOT: { userId: root.id } }, data: { userId: root.id } });
    if (nasCount) await this.prisma.nas.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (poolCount) await this.prisma.ipPool.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (packageCount) await this.prisma.package.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });
    if (areaCount) await this.prisma.area.updateMany({ where: { ownerId: { in: ids }, NOT: { ownerId: root.id } }, data: { ownerId: root.id } });

    this.log.log(`Shared demo visibility repaired for #${root.id}: ${subscriberCount} subscribers, ${nasCount} NAS, ${poolCount} pools, ${packageCount} packages, ${areaCount} areas.`);
  }
}
