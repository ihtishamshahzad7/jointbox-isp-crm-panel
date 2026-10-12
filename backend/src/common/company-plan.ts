import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ScopeService, Actor } from './scope.service';

/**
 * WHAT THE PLATFORM ALLOWS ONE COMPANY.
 *
 * The licence caps the whole installation, so before this one company growing
 * to the plan's limit stopped every other company from adding a customer. The
 * platform account now sets each company's own caps (Companies → Plan &
 * limits): subscribers, routers, sub-accounts, and an end date. NULL = no cap.
 * The end date is enforced at sign-in and on every request (account-status);
 * the caps here, when something is created.
 *
 * Plain functions over (prisma, scope) rather than an injected service, so the
 * services that create things keep their constructors — and a test double
 * without a `companyPlan` table simply has no limits.
 */

export type LimitKind = 'subscribers' | 'nas' | 'accounts';

export interface PlanRow {
  companyId: number;
  maxSubscribers: number | null;
  maxNas: number | null;
  maxAccounts: number | null;
  expiresAt: Date | null;
  note: string | null;
  updatedAt?: Date;
}

export interface Usage {
  subscribers: number;
  nas: number;
  accounts: number;
}

const LABEL: Record<LimitKind, [string, string]> = {
  subscribers: ['subscriber', 'subscribers'],
  nas: ['router', 'routers'],
  accounts: ['sub-account', 'sub-accounts (franchises, dealers, retailers and staff)'],
};
const COLUMN: Record<LimitKind, keyof PlanRow> = {
  subscribers: 'maxSubscribers',
  nas: 'maxNas',
  accounts: 'maxAccounts',
};

const TTL_MS = 30_000;
const planCache = new Map<number, { row: PlanRow | null; at: number }>();

export function invalidateCompanyPlan(companyId?: number): void {
  if (companyId == null) planCache.clear();
  else planCache.delete(Number(companyId));
}

function hasTable(prisma: any): boolean {
  return typeof prisma?.companyPlan?.findUnique === 'function';
}

export async function planFor(prisma: any, companyId: number): Promise<PlanRow | null> {
  if (!hasTable(prisma) || !companyId) return null;
  const hit = planCache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  let row: PlanRow | null = null;
  try {
    row = await prisma.companyPlan.findUnique({ where: { companyId } });
  } catch {
    row = null; // table not migrated yet: no limits, never a lock-out
  }
  planCache.set(companyId, { row, at: Date.now() });
  return row;
}

/** What the company (its whole tree) has right now. */
export async function usageFor(prisma: any, companyId: number): Promise<Usage> {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE t AS (
      SELECT id, 0 AS depth FROM "User" WHERE id = ${companyId}
      UNION ALL
      SELECT u.id, t.depth + 1 FROM "User" u JOIN t ON u."parentId" = t.id WHERE t.depth < 20
    )
    SELECT
      (SELECT COUNT(*) FROM "Subscriber" s WHERE s."userId" IN (SELECT id FROM t))::int AS subscribers,
      (SELECT COUNT(*) FROM nas n WHERE n."ownerId" IN (SELECT id FROM t))::int AS nas,
      (SELECT COUNT(*) FROM t WHERE id <> ${companyId})::int AS accounts`;
  const r = (rows as any[])?.[0] || {};
  return {
    subscribers: Number(r.subscribers) || 0,
    nas: Number(r.nas) || 0,
    accounts: Number(r.accounts) || 0,
  };
}

/**
 * Refuse creating `count` more of `kind` when it would take the caller's
 * company past its cap. The platform account (no company) and companies with
 * no plan row pass straight through.
 */
export async function assertCompanyCanAdd(
  prisma: any,
  scope: ScopeService,
  actor: Actor | undefined,
  kind: LimitKind,
  count = 1,
): Promise<void> {
  if (!actor || !hasTable(prisma) || count <= 0) return;
  let company: number | null = null;
  try {
    company = await scope.companyRootId(scope.actorId(actor));
  } catch {
    return;
  }
  if (company == null) return;
  const plan = await planFor(prisma, company);
  const limit = plan ? (plan[COLUMN[kind]] as number | null) : null;
  if (limit == null) return;
  const used = (await usageFor(prisma, company))[kind];
  if (used + count > limit) {
    const [one, many] = LABEL[kind];
    const room = Math.max(0, limit - used);
    throw new ForbiddenException({
      statusCode: 403,
      code: 'COMPANY_LIMIT',
      message:
        `Your company's plan allows ${limit} ${limit === 1 ? one : many}; you have ${used}` +
        (count > 1 ? ` and this would add ${count} (room for ${room})` : '') +
        '. Ask the platform owner to raise the limit.',
    });
  }
}

/** The company (top account under the platform) a user belongs to, or null. */
export async function companyOfUser(prisma: any, userId: number): Promise<number | null> {
  if (!userId || typeof prisma?.$queryRaw !== 'function') return null;
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE up AS (
      SELECT id, "parentId", role, 0 AS depth FROM "User" WHERE id = ${Number(userId)}
      UNION ALL
      SELECT p.id, p."parentId", p.role, up.depth + 1 FROM "User" p JOIN up ON p.id = up."parentId"
      WHERE up.depth < 20 AND p.role <> 'SUPER_ADMIN'
    )
    SELECT id FROM up WHERE role <> 'SUPER_ADMIN' ORDER BY depth DESC LIMIT 1`;
  const id = Number((rows as any[])?.[0]?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Same cap, for a record owned by `ownerUserId` when there is no operator (customer self-signup). */
export async function assertOwnerCompanyCanAdd(prisma: any, ownerUserId: number | null, kind: LimitKind, count = 1): Promise<void> {
  if (!ownerUserId || !hasTable(prisma)) return;
  let company: number | null = null;
  try {
    company = await companyOfUser(prisma, ownerUserId);
  } catch {
    return;
  }
  if (company == null) return;
  const plan = await planFor(prisma, company);
  const limit = plan ? (plan[COLUMN[kind]] as number | null) : null;
  if (limit == null) return;
  const used = (await usageFor(prisma, company))[kind];
  if (used + count > limit) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'COMPANY_LIMIT',
      message: 'Sign-up is closed right now — this provider is not taking new customers online. Please contact them directly.',
    });
  }
}

/** A company account: role ADMIN directly under a platform account. */
export async function assertIsCompany(prisma: any, companyId: number): Promise<{ id: number; name: string }> {
  const u = await prisma.user.findUnique({
    where: { id: Number(companyId) },
    select: { id: true, name: true, role: true, parent: { select: { role: true } } },
  });
  if (!u || u.role !== 'ADMIN' || (u.parent && u.parent.role !== 'SUPER_ADMIN')) {
    throw new NotFoundException('Company not found');
  }
  return { id: u.id, name: u.name };
}

const capOrNull = (v: any, field: string): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
    throw new BadRequestException(`${field} must be a whole number of 0 or more, or empty for no limit.`);
  }
  return n;
};

/** Platform account only (the route is on the platform allow-list and checks the role). */
export async function savePlan(
  prisma: any,
  actorId: number,
  companyId: number,
  body: any,
): Promise<PlanRow> {
  await assertIsCompany(prisma, companyId);
  let expiresAt: Date | null = null;
  if (body?.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('The end date is not a valid date.');
    expiresAt = d;
  }
  const data = {
    maxSubscribers: capOrNull(body?.maxSubscribers, 'Subscribers'),
    maxNas: capOrNull(body?.maxNas, 'Routers'),
    maxAccounts: capOrNull(body?.maxAccounts, 'Sub-accounts'),
    expiresAt,
    note: body?.note ? String(body.note).slice(0, 300) : null,
    updatedById: actorId || null,
  };
  const row = await prisma.companyPlan.upsert({
    where: { companyId: Number(companyId) },
    update: data,
    create: { companyId: Number(companyId), ...data },
  });
  invalidateCompanyPlan(companyId);
  return row;
}
