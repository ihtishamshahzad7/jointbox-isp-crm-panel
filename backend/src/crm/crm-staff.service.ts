import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { PermissionsGuard } from '../security/permissions.guard';
import { canRead, canWrite } from '../common/permission-check';

/**
 * ADVANCED CRM — STAFF: EMPLOYEE CODES, DESIGNATIONS, REPORTING LINES.
 *
 * Ported in behaviour from the reference CRM (crm_employee_codes.py,
 * crm_employee_hierarchy.py). Uplinko's people are its existing logins (the
 * company's user tree); this adds their HR side WITHOUT touching access:
 * roles, permissions and the parent tree that decides visibility are not
 * read or written here.
 *
 *   • Employee code — EMP-000001, per company, issued once and never reused:
 *     a row-locked counter (UPDATE … RETURNING) inside the same transaction,
 *     plus a unique index as the backstop.
 *   • Reporting manager — must be another person in the same company and may
 *     not create a loop. Checked under a per-company advisory lock, so two
 *     managers saving "A reports to B" and "B reports to A" at the same moment
 *     cannot both succeed.
 *   • Designations — the company's list of titles; switching one off stops new
 *     use but leaves people who hold it alone.
 *   • Availability — available / on duty / on leave (used to refuse assigning
 *     an equipment recovery to someone on leave).
 *
 * Private HR fields of the reference CRM (salary, CNIC, bank details) are NOT
 * ported: they need their own access rules and encryption — a separate task.
 */
const AVAILABILITY = ['AVAILABLE', 'ON_DUTY', 'ON_LEAVE'] as const;
const LOCK_NS = 0x55504c4b; // "UPLK" — advisory-lock namespace for staff hierarchy edits

@Injectable()
export class CrmStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly perms: PermissionsGuard,
  ) {}

  private async company(actor: Actor): Promise<number> {
    const c = await this.scope.companyRootId(this.scope.actorId(actor));
    if (c == null) throw new ForbiddenException('Staff records belong to a company account.');
    return c;
  }

  private async read(actor: Actor) {
    if (!(await canRead(this.perms, actor, 'users'))) throw new ForbiddenException('Missing permission: users.read');
  }

  private async write(actor: Actor) {
    if (!this.scope.isOwner(actor?.role)) throw new ForbiddenException('Only the company owner can change staff records.');
    if (!(await canWrite(this.perms, actor, 'users'))) throw new ForbiddenException('Missing permission: users.write');
  }

  /** The company's people (its whole login tree except the company account itself). */
  private async people(companyId: number) {
    const ids = (await this.scope.descendantIds(companyId)).filter((id) => id !== companyId);
    if (!ids.length) return [];
    return (await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, role: true, isActive: true },
      orderBy: { name: 'asc' },
      take: 5000,
    } as never)) as any[];
  }

  // ── designations ──────────────────────────────────────────────────────────

  async designations(actor: Actor) {
    await this.read(actor);
    return this.prisma.crmDesignation.findMany({ where: { companyId: await this.company(actor) }, orderBy: { name: 'asc' }, take: 500 } as never);
  }

  async createDesignation(actor: Actor, body: any) {
    await this.write(actor);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 150) throw new BadRequestException('Enter a designation of up to 150 characters.');
    try {
      return await this.prisma.crmDesignation.create({ data: { companyId: await this.company(actor), name } } as never);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`"${name}" already exists.`);
      throw e;
    }
  }

  async updateDesignation(actor: Actor, id: number, body: any) {
    await this.write(actor);
    const companyId = await this.company(actor);
    const data: Record<string, unknown> = {};
    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 150) throw new BadRequestException('Enter a designation of up to 150 characters.');
      data.name = name; // people hold it by id, so a rename follows them automatically
    }
    if (body?.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new BadRequestException('isActive must be true or false.');
      data.isActive = body.isActive;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change.');
    try {
      const r = (await this.prisma.crmDesignation.updateMany({ where: { id, companyId }, data } as never)) as any;
      if (r.count !== 1) throw new NotFoundException('Designation not found');
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`"${data.name}" already exists.`);
      throw e;
    }
    return this.prisma.crmDesignation.findUnique({ where: { id } } as never);
  }

  // ── people ────────────────────────────────────────────────────────────────

  async list(actor: Actor) {
    await this.read(actor);
    const companyId = await this.company(actor);
    const people = await this.people(companyId);
    if (!people.length) return [];
    const [profiles, titles] = await Promise.all([
      this.prisma.crmEmployeeProfile.findMany({ where: { companyId, userId: { in: people.map((p) => p.id) } } } as never) as Promise<any[]>,
      this.prisma.crmDesignation.findMany({ where: { companyId } } as never) as Promise<any[]>,
    ]);
    const byUser = new Map(profiles.map((p) => [p.userId, p]));
    const titleOf = new Map(titles.map((t) => [t.id, t.name]));
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return people.map((u) => {
      const p = byUser.get(u.id);
      return {
        userId: u.id,
        name: u.name,
        role: String(u.role),
        isActive: u.isActive,
        employeeCode: p?.employeeCode ?? null,
        designationId: p?.designationId ?? null,
        designation: p?.designationId ? titleOf.get(p.designationId) ?? null : null,
        department: p?.department ?? null,
        reportsToUserId: p?.reportsToUserId ?? null,
        reportsTo: p?.reportsToUserId ? nameOf.get(p.reportsToUserId) ?? null : null,
        availability: p?.availability ?? 'AVAILABLE',
      };
    });
  }

  /**
   * Save one person's HR record (creating it, with a fresh employee code, the
   * first time). Everything in one transaction under the company's lock.
   */
  async save(actor: Actor, userId: number, body: any) {
    await this.write(actor);
    const companyId = await this.company(actor);
    const people = await this.people(companyId);
    if (!people.some((p) => p.id === userId)) throw new NotFoundException('That person is not in your company.');

    const data: Record<string, unknown> = {};
    if (body?.department !== undefined) {
      const d = body.department === null ? '' : String(body.department).trim();
      if (d.length > 100) throw new BadRequestException('Department is longer than 100 characters.');
      data.department = d || null;
    }
    if (body?.availability !== undefined) {
      if (!(AVAILABILITY as readonly string[]).includes(String(body.availability))) throw new BadRequestException('Availability must be AVAILABLE, ON_DUTY or ON_LEAVE.');
      data.availability = String(body.availability);
    }
    let designationId: number | null | undefined;
    if (body?.designationId !== undefined) designationId = body.designationId === null || body.designationId === '' ? null : Number(body.designationId);
    let manager: number | null | undefined;
    if (body?.reportsToUserId !== undefined) manager = body.reportsToUserId === null || body.reportsToUserId === '' ? null : Number(body.reportsToUserId);
    if (manager !== undefined && manager !== null) {
      if (!Number.isInteger(manager) || !people.some((p) => p.id === manager)) throw new BadRequestException('Choose a reporting manager from your company.');
      if (manager === userId) throw new BadRequestException('A person cannot report to themselves.');
    }

    return this.prisma.$transaction(async (tx: any) => {
      // One hierarchy edit per company at a time (released at commit/rollback).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${companyId}::int)`;

      if (designationId !== undefined && designationId !== null) {
        const current = await tx.crmEmployeeProfile.findUnique({ where: { userId }, select: { designationId: true } });
        const t = await tx.crmDesignation.findFirst({ where: { id: designationId, companyId } });
        // A switched-off title may be kept by whoever has it, but not newly given.
        if (!t || (!t.isActive && current?.designationId !== designationId)) throw new BadRequestException('Choose an active designation.');
      }
      if (designationId !== undefined) data.designationId = designationId;

      if (manager !== undefined && manager !== null) {
        // Walk up from the new manager; reaching this person again is a loop.
        const seen = new Set<number>([userId]);
        let at: number | null = manager;
        while (at !== null) {
          if (seen.has(at)) throw new BadRequestException('That would make a reporting loop.');
          seen.add(at);
          const up: any = await tx.crmEmployeeProfile.findUnique({ where: { userId: at }, select: { reportsToUserId: true, companyId: true } });
          at = up && up.companyId === companyId ? up.reportsToUserId : null;
        }
      }
      if (manager !== undefined) data.reportsToUserId = manager;

      const existing = await tx.crmEmployeeProfile.findUnique({ where: { userId } });
      if (existing && existing.companyId !== companyId) throw new NotFoundException('That person is not in your company.');
      if (existing) {
        return tx.crmEmployeeProfile.update({ where: { userId }, data: { ...data, updatedAt: new Date() } });
      }
      // First record: take the next number for this company (row-locked).
      const [{ next }] = await tx.$queryRaw<Array<{ next: number }>>`
        INSERT INTO "crm_employee_counter" ("companyId", "next") VALUES (${companyId}, 2)
        ON CONFLICT ("companyId") DO UPDATE SET "next" = "crm_employee_counter"."next" + 1
        RETURNING "next" - 1 AS "next"`;
      const employeeCode = `EMP-${String(next).padStart(6, '0')}`;
      return tx.crmEmployeeProfile.create({ data: { userId, companyId, employeeCode, ...data } });
    });
  }

  /** Reporting tree for an org chart: people with nobody above them are roots. */
  async tree(actor: Actor) {
    const rows = await this.list(actor);
    type Node = (typeof rows)[number] & { reports: Node[] };
    const nodes = new Map<number, Node>(rows.map((r) => [r.userId, { ...r, reports: [] }]));
    const roots: Node[] = [];
    for (const n of nodes.values()) {
      const boss = n.reportsToUserId ? nodes.get(n.reportsToUserId) : undefined;
      if (boss) boss.reports.push(n);
      else roots.push(n);
    }
    return roots;
  }

  /** Is this person on leave? (Used before assigning them work.) */
  async isOnLeave(userId: number): Promise<boolean> {
    const p = (await this.prisma.crmEmployeeProfile.findUnique({ where: { userId }, select: { availability: true } } as never)) as any;
    return p?.availability === 'ON_LEAVE';
  }
}
