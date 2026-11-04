import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import { ScopeService, type Actor } from '../common/scope.service';

const EMPLOYEE_STATUSES = new Set(['ACTIVE', 'ON_LEAVE', 'INACTIVE']);

export type EmployeeInput = {
  employeeNumber?: unknown;
  name?: unknown;
  department?: unknown;
  designation?: unknown;
  hiredAt?: unknown;
  status?: unknown;
  userId?: unknown;
};

@Injectable()
export class HrEmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
  ) {}

  private async companyId(actor: Actor): Promise<number> {
    if (!actor || actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Sign in as a company account to access employee profiles.',
      );
    }
    return (await this.entitlements.assertEnabled(actor, 'crm-advanced'))
      .companyId;
  }

  private assertCompanyAdmin(actor: Actor, companyId: number) {
    if (actor?.role !== 'ADMIN' || this.scope.actorId(actor) !== companyId) {
      throw new ForbiddenException(
        'Only the company administrator can manage employee profiles.',
      );
    }
  }

  private text(
    value: unknown,
    field: string,
    maximum: number,
    required = false,
  ): string | null {
    if (value == null || value === '') {
      if (required) throw new BadRequestException(`${field} is required.`);
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be text.`);
    }
    const clean = value.trim();
    if (!clean && required) {
      throw new BadRequestException(`${field} is required.`);
    }
    if (clean.length > maximum) {
      throw new BadRequestException(
        `${field} must be ${maximum} characters or fewer.`,
      );
    }
    return clean || null;
  }

  private data(input: EmployeeInput, creating: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Employee profile must be an object.');
    }
    const data: {
      employeeNumber?: string;
      name?: string;
      department?: string | null;
      designation?: string | null;
      hiredAt?: Date | null;
      status?: string;
      userId?: number | null;
    } = {};
    if (creating || input.employeeNumber !== undefined) {
      data.employeeNumber = this.text(
        input.employeeNumber,
        'Employee number',
        40,
        true,
      )!;
    }
    if (creating || input.name !== undefined) {
      data.name = this.text(input.name, 'Name', 120, true)!;
    }
    if (creating || input.department !== undefined) {
      data.department = this.text(input.department, 'Department', 80);
    }
    if (creating || input.designation !== undefined) {
      data.designation = this.text(input.designation, 'Designation', 80);
    }
    if (input.hiredAt !== undefined || creating) {
      if (input.hiredAt == null || input.hiredAt === '') {
        data.hiredAt = null;
      } else if (typeof input.hiredAt === 'string') {
        const hiredAt = new Date(input.hiredAt);
        if (Number.isNaN(hiredAt.getTime())) {
          throw new BadRequestException('Hire date must be a valid date.');
        }
        data.hiredAt = hiredAt;
      } else {
        throw new BadRequestException('Hire date must be a date string.');
      }
    }
    if (input.status !== undefined || creating) {
      const status = input.status ?? 'ACTIVE';
      if (
        typeof status !== 'string' ||
        !EMPLOYEE_STATUSES.has(status.toUpperCase())
      ) {
        throw new BadRequestException(
          'Status must be ACTIVE, ON_LEAVE, or INACTIVE.',
        );
      }
      data.status = status.toUpperCase();
    }
    if (input.userId !== undefined || creating) {
      if (input.userId == null || input.userId === '') {
        data.userId = null;
      } else {
        const userId = Number(input.userId);
        if (!Number.isSafeInteger(userId) || userId < 1) {
          throw new BadRequestException(
            'Linked user ID must be a positive integer.',
          );
        }
        data.userId = userId;
      }
    }
    return data;
  }

  private async assertLinkedUserInCompany(
    userId: number | null | undefined,
    companyId: number,
  ) {
    if (userId == null) return;
    const companyUserIds = await this.scope.descendantIds(companyId);
    if (!companyUserIds.includes(userId)) {
      throw new NotFoundException('Linked user not found in this company.');
    }
  }

  async findAll(
    actor: Actor,
    query: { search?: string; status?: string } = {},
  ) {
    const companyId = await this.companyId(actor);
    if (query.search != null && typeof query.search !== 'string') {
      throw new BadRequestException('Search must be text.');
    }
    if (query.status != null && typeof query.status !== 'string') {
      throw new BadRequestException('Status must be text.');
    }
    const search = query.search?.trim() ?? '';
    if (search.length > 100) {
      throw new BadRequestException('Search must be 100 characters or fewer.');
    }
    const status = query.status?.trim().toUpperCase();
    if (status && !EMPLOYEE_STATUSES.has(status)) {
      throw new BadRequestException('Unknown employee status.');
    }
    return this.prisma.employeeProfile.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { employeeNumber: { contains: search, mode: 'insensitive' } },
                { department: { contains: search, mode: 'insensitive' } },
                { designation: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
    });
  }

  async create(actor: Actor, input: EmployeeInput) {
    const companyId = await this.companyId(actor);
    this.assertCompanyAdmin(actor, companyId);
    const data = this.data(input, true);
    const employeeNumber = data.employeeNumber;
    const name = data.name;
    if (!employeeNumber || !name) {
      throw new BadRequestException('Employee number and name are required.');
    }
    await this.assertLinkedUserInCompany(data.userId, companyId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.entitlements.assertEnabledForTransaction(
          tx,
          companyId,
          'crm-advanced',
        );
        const profile = await tx.employeeProfile.create({
          data: { ...data, companyId, employeeNumber, name },
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        });
        await tx.activityLog.create({
          data: {
            userId: this.scope.actorId(actor),
            action: 'HR_EMPLOYEE_PROFILE_CREATED',
            entity: 'EmployeeProfile',
            entityId: profile.id,
          },
        });
        return profile;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Employee number or linked user is already assigned.',
        );
      }
      throw error;
    }
  }

  async update(actor: Actor, id: number, input: EmployeeInput) {
    const companyId = await this.companyId(actor);
    this.assertCompanyAdmin(actor, companyId);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BadRequestException('Employee ID must be a positive integer.');
    }
    const data = this.data(input, false);
    if (!Object.keys(data).length) {
      throw new BadRequestException('At least one employee field is required.');
    }
    await this.assertLinkedUserInCompany(data.userId, companyId);
    const existing = await this.prisma.employeeProfile.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Employee profile not found.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.entitlements.assertEnabledForTransaction(
          tx,
          companyId,
          'crm-advanced',
        );
        const profile = await tx.employeeProfile.update({
          where: { id },
          data,
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        });
        await tx.activityLog.create({
          data: {
            userId: this.scope.actorId(actor),
            action: 'HR_EMPLOYEE_PROFILE_UPDATED',
            entity: 'EmployeeProfile',
            entityId: profile.id,
          },
        });
        return profile;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Employee number or linked user is already assigned.',
        );
      }
      throw error;
    }
  }

  async remove(actor: Actor, id: number) {
    const companyId = await this.companyId(actor);
    this.assertCompanyAdmin(actor, companyId);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BadRequestException('Employee ID must be a positive integer.');
    }
    const existing = await this.prisma.employeeProfile.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Employee profile not found.');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.entitlements.assertEnabledForTransaction(
          tx,
          companyId,
          'crm-advanced',
        );
        await tx.employeeProfile.delete({ where: { id } });
        await tx.activityLog.create({
          data: {
            userId: this.scope.actorId(actor),
            action: 'HR_EMPLOYEE_PROFILE_DELETED',
            entity: 'EmployeeProfile',
            entityId: id,
          },
        });
        return { success: true };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new ConflictException(
          'This employee has retained leave records and cannot be deleted.',
        );
      }
      throw error;
    }
  }
}
