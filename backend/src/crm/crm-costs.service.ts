import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead, canWrite } from '../common/permission-check';
import { AccountingService } from '../accounting/accounting.service';

/**
 * ADVANCED CRM — WHAT A CUSTOMER COSTS TO SERVE.
 *
 * Ported in behaviour from the reference CRM (crm_costs.py). Uplinko already
 * runs expenses end to end (Accounting: create, approval threshold, approve /
 * reject, ledger posting) — none of that is redone here. Added:
 *
 *   • linking an expense to the customer it was spent on (crm_expense_link);
 *   • one view per customer: equipment at cost (from issues, Milestone 5),
 *     linked expenses, and the monthly margin from the package — so you can
 *     see how many months the connection takes to pay back.
 */
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

@Injectable()
export class CrmCostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
    private readonly accounting: AccountingService,
  ) {}

  private async need(actor: Actor, kind: 'read' | 'write', resource: string) {
    const ok = kind === 'read' ? await canRead(this.perms, actor, resource) : await canWrite(this.perms, actor, resource);
    if (!ok) throw new ForbiddenException(`Missing permission: ${resource}.${kind}`);
  }

  /** Link (or with null, unlink) an expense to a customer. Both must be the caller's. */
  async link(actor: Actor, expenseId: number, body: any) {
    await this.need(actor, 'write', 'accounting');
    await this.accounting.assertExpenseInScope(actor, expenseId);
    const raw = body?.subscriberId;
    if (raw === null || raw === undefined || raw === '') {
      await this.prisma.crmExpenseLink.deleteMany({ where: { expenseId } } as never);
      return { expenseId, subscriberId: null };
    }
    const subscriberId = Number(raw);
    if (!Number.isInteger(subscriberId) || subscriberId <= 0) throw new NotFoundException('Customer not found');
    await this.scope.assertSubscriberVisible(actor, subscriberId);
    const by = Number(actor?.sub ?? actor?.id) || null;
    return this.prisma.crmExpenseLink.upsert({
      where: { expenseId },
      update: { subscriberId, linkedById: by, linkedAt: new Date() },
      create: { expenseId, subscriberId, linkedById: by },
    } as never);
  }

  async costs(actor: Actor, subscriberId: number) {
    if (!Number.isInteger(subscriberId) || subscriberId <= 0) throw new NotFoundException('Customer not found');
    await this.need(actor, 'read', 'subscribers');
    await this.need(actor, 'read', 'accounting');
    await this.scope.assertSubscriberVisible(actor, subscriberId);

    const sub = (await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, fullName: true, costPrice: true, sellPrice: true, package: { select: { name: true, price: true } } },
    } as never)) as any;
    if (!sub) throw new NotFoundException('Customer not found');

    const issues = (await this.prisma.crmStockIssue.findMany({
      where: { subscriberId },
      select: { id: true, itemId: true, status: true, charge: true, issuedAt: true },
      orderBy: { issuedAt: 'desc' },
      take: 500,
    } as never)) as any[];
    const items = new Map<number, any>(
      ((await this.prisma.inventoryItem.findMany({
        where: { id: { in: issues.map((i) => i.itemId) } },
        select: { id: true, serialNumber: true, type: true, purchasePrice: true },
      } as never)) as any[]).map((i) => [i.id, i]),
    );
    const equipment = issues.map((i) => {
      const it = items.get(i.itemId);
      return {
        issueId: i.id,
        unit: it ? `${String(it.type)} · ${it.serialNumber}` : `#${i.itemId}`,
        status: i.status,
        cost: it?.purchasePrice == null ? null : r2(it.purchasePrice),
        charged: r2(i.charge),
        issuedAt: i.issuedAt,
      };
    });
    const sum = (f: (e: (typeof equipment)[number]) => boolean) => r2(equipment.filter(f).reduce((n, e) => n + (e.cost ?? 0), 0));

    const links = (await this.prisma.crmExpenseLink.findMany({ where: { subscriberId }, take: 1000 } as never)) as any[];
    const expenses = links.length
      ? ((await this.prisma.expense.findMany({
          where: { id: { in: links.map((l) => l.expenseId) } },
          select: { id: true, category: true, description: true, amount: true, status: true, expenseDate: true },
          orderBy: { expenseDate: 'desc' },
        } as never)) as any[])
      : [];
    const counted = expenses.filter((e) => String(e.status ?? 'APPROVED') !== 'REJECTED');

    const equipmentOut = sum((e) => e.status === 'ISSUED');
    const equipmentLost = sum((e) => e.status === 'LOST');
    const linkedExpenses = r2(counted.reduce((n, e) => n + Number(e.amount || 0), 0));
    const chargedToCustomer = r2(equipment.reduce((n, e) => n + e.charged, 0));
    const totalCost = r2(equipmentOut + equipmentLost + linkedExpenses - chargedToCustomer);
    const monthlyRevenue = r2(sub.sellPrice ?? sub.package?.price ?? 0);
    const monthlyCost = r2(sub.costPrice ?? 0);
    const monthlyMargin = r2(monthlyRevenue - monthlyCost);

    return {
      customer: { id: sub.id, name: sub.fullName, package: sub.package?.name ?? null },
      equipment,
      expenses: expenses.map((e) => ({ ...e, amount: r2(e.amount), counted: String(e.status ?? 'APPROVED') !== 'REJECTED' })),
      totals: {
        equipmentOut,
        equipmentRecovered: sum((e) => e.status === 'RECOVERED'),
        equipmentLost,
        unpricedUnits: equipment.filter((e) => e.cost === null && e.status !== 'RECOVERED').length,
        linkedExpenses,
        chargedToCustomer,
        totalCost,
        monthlyRevenue,
        monthlyCost,
        monthlyMargin,
        // null when the connection never pays back at this margin
        paybackMonths: totalCost <= 0 ? 0 : monthlyMargin > 0 ? Math.ceil(totalCost / monthlyMargin) : null,
      },
    };
  }
}
