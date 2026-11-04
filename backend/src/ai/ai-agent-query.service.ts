import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, type Actor } from '../common/scope.service';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import { parseAiQuestion, type AiQueryTopic } from './ai-agent-query';

const PERMISSIONS_BY_TOPIC: Record<AiQueryTopic, string[]> = {
  subscribers: ['subscribers.read'],
  collections: ['payments.read'],
  tickets: ['tickets.read'],
  sessions: ['network.read'],
  packages: ['packages.read', 'subscribers.read'],
  inventory: ['inventory.read'],
  'stock-movements': ['inventory.read'],
  'field-jobs': ['field-jobs.read'],
  expenses: ['accounting.read', 'cashflow.read'],
  'network-events': ['network.read'],
  employees: ['hr.read'],
  attendance: ['hr.attendance.read'],
};

const TOPIC_LABEL: Record<AiQueryTopic, string> = {
  subscribers: 'subscribers',
  collections: 'collections',
  tickets: 'tickets',
  sessions: 'sessions',
  packages: 'packages',
  inventory: 'inventory',
  'stock-movements': 'stock movements',
  'field-jobs': 'field jobs',
  expenses: 'expenses',
  'network-events': 'network events',
  employees: 'employees',
  attendance: 'attendance',
};

export type AiAgentVisual = {
  title: string;
  unit:
    | 'count'
    | 'amount'
    | `amount (${string})`
    | 'recorded amount (currency not stored)';
  series: Array<{
    label: string;
    points: Array<{ label: string; value: number }>;
  }>;
};

export type AiAgentSummary = {
  window: { label: string; start: Date | null; end: Date };
  metrics: Record<string, unknown>;
  omittedTopics: string[];
  visuals: AiAgentVisual[];
  language: 'en' | 'ur' | 'roman-ur';
};

@Injectable()
export class AiAgentQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
  ) {}

  private async permissionState(actor: Actor, topics: AiQueryTopic[]) {
    if (!actor?.role || !topics.length) {
      return { grants: new Set<string>(), denied: new Set<string>() };
    }
    const permissions = [
      ...topics.flatMap((topic) => PERMISSIONS_BY_TOPIC[topic]),
      'invoices.read',
    ];
    const [roleRows, chain] = await Promise.all([
      this.prisma.rolePermission.findMany({
        where: { role: actor.role },
        select: { permission: true },
      }),
      this.scope.ancestorIds(this.scope.actorId(actor)),
    ]);
    const grants = new Set(roleRows.map((row) => row.permission));
    const deniedRows = chain.length
      ? await this.prisma.userPermission.findMany({
          where: {
            userId: { in: chain },
            allowed: false,
            permission: { in: permissions },
          },
          select: { permission: true },
        })
      : [];
    const denied = new Set(deniedRows.map((row) => row.permission));
    return { grants, denied };
  }

  private hasPermission(
    permission: string,
    grants: Set<string>,
    denied: Set<string>,
  ): boolean {
    const resource = permission.slice(0, permission.lastIndexOf('.'));
    return (
      !denied.has(permission) &&
      (grants.has('*') ||
        grants.has(`${resource}.*`) ||
        grants.has(permission) ||
        grants.has(`${resource}.write`))
    );
  }

  private readableTopics(
    topics: AiQueryTopic[],
    permissionState: { grants: Set<string>; denied: Set<string> },
  ): AiQueryTopic[] {
    return topics.filter((topic) => {
      const permissions = PERMISSIONS_BY_TOPIC[topic];
      return topic === 'expenses'
        ? permissions.some((permission) =>
            this.hasPermission(
              permission,
              permissionState.grants,
              permissionState.denied,
            ),
          )
        : permissions.every((permission) =>
            this.hasPermission(
              permission,
              permissionState.grants,
              permissionState.denied,
            ),
          );
    });
  }

  private periodFilter(
    start: Date | null,
    end: Date,
  ): { gte?: Date; lt: Date } {
    return start ? { gte: start, lt: end } : { lt: end };
  }

  private attendanceDateFilter(
    start: Date | null,
    end: Date,
    now: Date,
  ): { gte?: Date; lt: Date } {
    const startDate = start
      ? new Date(`${this.karachiDate(start)}T00:00:00.000Z`)
      : undefined;
    const endLabel = start ? this.karachiDate(end) : this.karachiDate(now);
    const [year, month, day] = endLabel.split('-').map(Number);
    const exclusiveEnd = new Date(
      Date.UTC(year, month - 1, day + (start ? 0 : 1)),
    );
    return {
      ...(startDate ? { gte: startDate } : {}),
      lt: exclusiveEnd,
    };
  }

  async summarize(
    actor: Actor,
    question: string,
    now = new Date(),
  ): Promise<AiAgentSummary> {
    const parsed = parseAiQuestion(question, now);
    const requested = parsed.topics.length
      ? parsed.topics
      : (['subscribers', 'collections', 'tickets'] satisfies AiQueryTopic[]);
    const permissions = await this.permissionState(actor, requested);
    const companyState = requested.some(
      (topic) => topic === 'employees' || topic === 'attendance',
    )
      ? await this.entitlements.companyState(actor, 'crm-advanced')
      : null;
    const accessible = this.readableTopics(requested, permissions);
    const allowed = accessible.filter(
      (topic) =>
        (topic !== 'employees' && topic !== 'attendance') ||
        companyState?.enabled === true,
    );
    const omittedTopics = requested
      .filter((topic) => !allowed.includes(topic))
      .map((topic) => TOPIC_LABEL[topic]);
    if (!allowed.length) {
      throw new ForbiddenException(
        'Access or the required product entitlement is unavailable for the requested business records.',
      );
    }

    const subscriberWhere = (await this.scope.subscriberWhere(
      actor,
    )) as Prisma.SubscriberWhereInput;
    const rootId = await this.scope.rootId(actor);
    const userIds = await this.scope.descendantIds(rootId);
    const time = this.periodFilter(parsed.window.start, parsed.window.end);
    const attendanceTime = this.attendanceDateFilter(
      parsed.window.start,
      parsed.window.end,
      now,
    );
    const metrics: Record<string, unknown> = {};
    const visuals: AiAgentVisual[] = [];

    const periodLength =
      parsed.window.start == null
        ? 0
        : parsed.window.end.getTime() - parsed.window.start.getTime();
    const previousWindow =
      parsed.comparePeriods && parsed.window.start
        ? {
            start: new Date(parsed.window.start.getTime() - periodLength),
            end: parsed.window.start,
          }
        : null;
    const previousTime = previousWindow
      ? this.periodFilter(previousWindow.start, previousWindow.end)
      : null;
    const previousLabel = previousWindow
      ? `${this.karachiDate(previousWindow.start)} to ${this.karachiDate(
          new Date(previousWindow.end.getTime() - 1),
        )}`
      : null;

    const companyId = companyState?.companyId ?? rootId;

    for (const topic of allowed) {
      switch (topic) {
        case 'subscribers': {
          const [total, active, expired, suspended, newInPeriod] =
            await Promise.all([
              this.prisma.subscriber.count({ where: subscriberWhere }),
              this.prisma.subscriber.count({
                where: { AND: [subscriberWhere, { status: 'ACTIVE' }] },
              }),
              this.prisma.subscriber.count({
                where: { AND: [subscriberWhere, { status: 'EXPIRED' }] },
              }),
              this.prisma.subscriber.count({
                where: { AND: [subscriberWhere, { status: 'SUSPENDED' }] },
              }),
              this.prisma.subscriber.count({
                where: { AND: [subscriberWhere, { createdAt: time }] },
              }),
            ]);
          metrics.subscribers = {
            total,
            active,
            expired,
            suspended,
            newInPeriod,
          };
          visuals.push({
            title: 'Current subscriber status',
            unit: 'count',
            series: [
              {
                label: 'Current',
                points: [
                  { label: 'Active', value: active },
                  { label: 'Expired', value: expired },
                  { label: 'Suspended', value: suspended },
                ],
              },
            ],
          });
          if (parsed.comparePeriods && previousTime) {
            const previous = await this.prisma.subscriber.count({
              where: { AND: [subscriberWhere, { createdAt: previousTime }] },
            });
            visuals.push({
              title: 'New subscribers',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: [{ label: 'Created', value: newInPeriod }],
                },
                {
                  label: previousLabel!,
                  points: [{ label: 'Created', value: previous }],
                },
              ],
            });
          }
          break;
        }
        case 'collections': {
          const rows = await this.prisma.payment.groupBy({
            by: ['currency'],
            where: {
              subscriber: { is: subscriberWhere },
              paymentDate: time,
            },
            _sum: { amount: true },
            _count: { _all: true },
          });
          const collectionMetrics: Record<string, unknown> = {
            receivedByCurrency: rows.map((row) => ({
              currency: row.currency || 'Unspecified',
              amount: Number(row._sum.amount ?? 0),
              payments: row._count._all,
            })),
          };
          if (parsed.comparePeriods && previousTime) {
            const previousRows = await this.prisma.payment.groupBy({
              by: ['currency'],
              where: {
                subscriber: { is: subscriberWhere },
                paymentDate: previousTime,
              },
              _sum: { amount: true },
            });
            const currentByCurrency = new Map(
              rows.map((row) => [
                row.currency || 'Unspecified',
                Number(row._sum.amount ?? 0),
              ]),
            );
            const previousByCurrency = new Map(
              previousRows.map((row) => [
                row.currency || 'Unspecified',
                Number(row._sum.amount ?? 0),
              ]),
            );
            const currencies = new Set([
              ...currentByCurrency.keys(),
              ...previousByCurrency.keys(),
            ]);
            for (const currency of currencies) {
              visuals.push({
                title: `Collections received (${currency})`,
                unit: `amount (${currency})`,
                series: [
                  {
                    label: parsed.window.label,
                    points: [
                      {
                        label: 'Received',
                        value: currentByCurrency.get(currency) ?? 0,
                      },
                    ],
                  },
                  {
                    label: previousLabel!,
                    points: [
                      {
                        label: 'Received',
                        value: previousByCurrency.get(currency) ?? 0,
                      },
                    ],
                  },
                ],
              });
            }
          } else if (rows.length) {
            for (const row of rows) {
              const currency = row.currency || 'Unspecified';
              visuals.push({
                title: `Collections received (${currency})`,
                unit: `amount (${currency})`,
                series: [
                  {
                    label: parsed.window.label,
                    points: [
                      {
                        label: 'Received',
                        value: Number(row._sum.amount ?? 0),
                      },
                    ],
                  },
                ],
              });
            }
          }
          if (
            this.hasPermission(
              'invoices.read',
              permissions.grants,
              permissions.denied,
            )
          ) {
            const invoices = await this.prisma.invoice.groupBy({
              where: {
                subscriber: { is: subscriberWhere },
                invoiceDate: time,
                status: { not: 'PAID' },
              },
              by: ['currency'],
              _sum: { dueAmount: true },
              _count: { _all: true },
            });
            collectionMetrics.unpaidByCurrency = invoices.map((row) => ({
              currency: row.currency || 'Unspecified',
              invoices: row._count._all,
              dueAmount: Number(row._sum.dueAmount ?? 0),
            }));
          }
          metrics.collections = collectionMetrics;
          break;
        }
        case 'tickets': {
          const [total, open, overdueSla] = await Promise.all([
            this.prisma.ticket.count({
              where: { subscriber: { is: subscriberWhere }, createdAt: time },
            }),
            this.prisma.ticket.count({
              where: {
                subscriber: { is: subscriberWhere },
                createdAt: time,
                status: { in: ['OPEN', 'IN_PROGRESS'] },
              },
            }),
            this.prisma.ticket.count({
              where: { subscriber: { is: subscriberWhere }, slaBreached: true },
            }),
          ]);
          metrics.tickets = {
            createdInPeriod: total,
            openInPeriod: open,
            slaBreached: overdueSla,
          };
          visuals.push({
            title: 'Tickets created in selected period',
            unit: 'count',
            series: [
              {
                label: parsed.window.label,
                points: [
                  { label: 'Created', value: total },
                  { label: 'Still open now', value: open },
                ],
              },
            ],
          });
          if (parsed.comparePeriods && previousTime) {
            const previous = await this.prisma.ticket.count({
              where: {
                subscriber: { is: subscriberWhere },
                createdAt: previousTime,
              },
            });
            visuals.push({
              title: 'Tickets created',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: [{ label: 'Created', value: total }],
                },
                {
                  label: previousLabel!,
                  points: [{ label: 'Created', value: previous }],
                },
              ],
            });
          }
          break;
        }
        case 'sessions': {
          const active = await this.prisma.pppoeSession.count({
            where: { isActive: true, subscriber: { is: subscriberWhere } },
          });
          metrics.sessions = { active };
          visuals.push({
            title: 'Active PPPoE sessions',
            unit: 'count',
            series: [
              {
                label: 'Current',
                points: [{ label: 'Active', value: active }],
              },
            ],
          });
          break;
        }
        case 'packages': {
          const counts = await this.prisma.subscriber.groupBy({
            by: ['packageId'],
            where: {
              AND: [
                subscriberWhere,
                { status: 'ACTIVE' },
                { packageId: { not: null } },
              ],
            },
            _count: { _all: true },
          });
          const packageIds = counts
            .map((row) => row.packageId)
            .filter((id): id is number => id !== null);
          const visiblePackages = packageIds.length
            ? await this.prisma.package.findMany({
                where: {
                  AND: [
                    { id: { in: packageIds } },
                    (await this.scope.packageWhere(
                      actor,
                    )) as Prisma.PackageWhereInput,
                  ],
                },
                select: { id: true, name: true },
              })
            : [];
          const names = new Map(
            visiblePackages.map((row) => [row.id, row.name]),
          );
          const packageMetrics = counts
            .filter((row) => row.packageId != null && names.has(row.packageId))
            .map((row) => ({
              package: names.get(row.packageId as number),
              activeSubscribers: row._count._all,
            }));
          metrics.packages = packageMetrics;
          const topPackages = [...packageMetrics]
            .sort(
              (left, right) =>
                right.activeSubscribers - left.activeSubscribers,
            )
            .slice(0, 10);
          if (topPackages.length) {
            visuals.push({
              title: 'Top packages by active subscribers',
              unit: 'count',
              series: [
                {
                  label: 'Current',
                  points: topPackages.map((row) => ({
                    label: row.package ?? 'Package',
                    value: row.activeSubscribers,
                  })),
                },
              ],
            });
          }
          break;
        }
        case 'inventory': {
          const rows = await this.prisma.inventoryItem.groupBy({
            by: ['status'],
            where: { ownerId: { in: userIds } },
            _count: { _all: true },
          });
          metrics.inventory = rows.map((row) => ({
            status: row.status,
            count: row._count._all,
          }));
          if (rows.length) {
            visuals.push({
              title: 'Inventory by status',
              unit: 'count',
              series: [
                {
                  label: 'Current',
                  points: rows.map((row) => ({
                    label: row.status,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          break;
        }
        case 'stock-movements': {
          const rows = await this.prisma.inventoryMovement.groupBy({
            by: ['toStatus'],
            where: {
              item: { is: { ownerId: { in: userIds } } },
              createdAt: time,
            },
            _count: { _all: true },
          });
          metrics.stockMovements = rows.map((row) => ({
            status: row.toStatus,
            count: row._count._all,
          }));
          if (parsed.comparePeriods && previousTime) {
            const previousRows = await this.prisma.inventoryMovement.groupBy({
              by: ['toStatus'],
              where: {
                item: { is: { ownerId: { in: userIds } } },
                createdAt: previousTime,
              },
              _count: { _all: true },
            });
            const statuses = new Set([
              ...rows.map((row) => row.toStatus),
              ...previousRows.map((row) => row.toStatus),
            ]);
            for (const status of statuses) {
              visuals.push({
                title: `Stock movements (${status})`,
                unit: 'count',
                series: [
                  {
                    label: parsed.window.label,
                    points: [
                      {
                        label: 'Movements',
                        value:
                          rows.find((row) => row.toStatus === status)?._count
                            ._all ?? 0,
                      },
                    ],
                  },
                  {
                    label: previousLabel!,
                    points: [
                      {
                        label: 'Movements',
                        value:
                          previousRows.find(
                            (row) => row.toStatus === status,
                          )?._count._all ?? 0,
                      },
                    ],
                  },
                ],
              });
            }
          } else if (rows.length) {
            visuals.push({
              title: 'Stock movements by destination status',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: rows.map((row) => ({
                    label: row.toStatus,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          break;
        }
        case 'field-jobs': {
          const rows = await this.prisma.fieldJob.groupBy({
            by: ['status'],
            where: {
              createdAt: time,
              OR: [
                { subscriber: { is: subscriberWhere } },
                { assignedTo: { in: userIds } },
              ],
            },
            _count: { _all: true },
          });
          metrics.fieldJobs = rows.map((row) => ({
            status: row.status,
            count: row._count._all,
          }));
          if (parsed.comparePeriods && previousTime) {
            const previousCount = await this.prisma.fieldJob.count({
              where: {
                createdAt: previousTime,
                OR: [
                  { subscriber: { is: subscriberWhere } },
                  { assignedTo: { in: userIds } },
                ],
              },
            });
            visuals.push({
              title: 'Field jobs created',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: [
                    {
                      label: 'Created',
                      value: rows.reduce(
                        (total, row) => total + row._count._all,
                        0,
                      ),
                    },
                  ],
                },
                {
                  label: previousLabel!,
                  points: [{ label: 'Created', value: previousCount }],
                },
              ],
            });
          } else if (rows.length) {
            visuals.push({
              title: 'Field jobs by status',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: rows.map((row) => ({
                    label: row.status,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          break;
        }
        case 'expenses': {
          const result = await this.prisma.expense.aggregate({
            where: {
              createdBy: { in: userIds },
              expenseDate: time,
              status: 'APPROVED',
            },
            _sum: { amount: true },
            _count: { _all: true },
          });
          metrics.expenses = {
            approvedInPeriod: result._count._all,
            amount: Number(result._sum.amount ?? 0),
          };
          if (parsed.comparePeriods && previousTime) {
            const previous = await this.prisma.expense.aggregate({
              where: {
                createdBy: { in: userIds },
                expenseDate: previousTime,
                status: 'APPROVED',
              },
              _sum: { amount: true },
              _count: { _all: true },
            });
            visuals.push({
              title: 'Approved expenses',
              unit: 'recorded amount (currency not stored)',
              series: [
                {
                  label: parsed.window.label,
                  points: [
                    { label: 'Amount', value: Number(result._sum.amount ?? 0) },
                  ],
                },
                {
                  label: previousLabel!,
                  points: [
                    {
                      label: 'Amount',
                      value: Number(previous._sum.amount ?? 0),
                    },
                  ],
                },
              ],
            });
          } else {
            visuals.push({
              title: 'Approved expenses',
              unit: 'recorded amount (currency not stored)',
              series: [
                {
                  label: parsed.window.label,
                  points: [
                    { label: 'Amount', value: Number(result._sum.amount ?? 0) },
                  ],
                },
              ],
            });
          }
          break;
        }
        case 'employees': {
          const rows = await this.prisma.employeeProfile.groupBy({
            by: ['status'],
            where: { companyId },
            _count: { _all: true },
          });
          metrics.employees = rows.map((row) => ({
            status: row.status,
            count: row._count._all,
          }));
          if (rows.length) {
            visuals.push({
              title: 'Employees by status',
              unit: 'count',
              series: [
                {
                  label: 'Current',
                  points: rows.map((row) => ({
                    label: row.status,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          if (parsed.comparePeriods && previousTime) {
            const [currentHires, previousHires] = await Promise.all([
              this.prisma.employeeProfile.count({
                where: { companyId, hiredAt: time },
              }),
              this.prisma.employeeProfile.count({
                where: { companyId, hiredAt: previousTime },
              }),
            ]);
            visuals.push({
              title: 'New hires',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: [{ label: 'Hired', value: currentHires }],
                },
                {
                  label: previousLabel!,
                  points: [{ label: 'Hired', value: previousHires }],
                },
              ],
            });
          }
          break;
        }
        case 'attendance': {
          const rows = await this.prisma.employeeAttendance.groupBy({
            by: ['status'],
            where: { companyId, attendanceDate: attendanceTime },
            _count: { _all: true },
          });
          metrics.attendance = rows.map((row) => ({
            status: row.status,
            count: row._count._all,
          }));
          if (parsed.comparePeriods && previousTime) {
            const previousRows = await this.prisma.employeeAttendance.groupBy({
              by: ['status'],
              where: {
                companyId,
                attendanceDate: this.attendanceDateFilter(
                  previousWindow!.start,
                  previousWindow!.end,
                  now,
                ),
              },
              _count: { _all: true },
            });
            const statuses = new Set([
              ...rows.map((row) => row.status),
              ...previousRows.map((row) => row.status),
            ]);
            for (const status of statuses) {
              visuals.push({
                title: `Attendance (${status})`,
                unit: 'count',
                series: [
                  {
                    label: parsed.window.label,
                    points: [
                      {
                        label: 'Records',
                        value:
                          rows.find((row) => row.status === status)?._count
                            ._all ?? 0,
                      },
                    ],
                  },
                  {
                    label: previousLabel!,
                    points: [
                      {
                        label: 'Records',
                        value:
                          previousRows.find((row) => row.status === status)
                            ?._count._all ?? 0,
                      },
                    ],
                  },
                ],
              });
            }
          } else if (rows.length) {
            visuals.push({
              title: 'Attendance by status',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: rows.map((row) => ({
                    label: row.status,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          break;
        }
        case 'network-events': {
          const visibleNas = await this.prisma.nas.findMany({
            where: (await this.scope.nasWhere(actor)) as Prisma.NasWhereInput,
            select: { id: true },
          });
          const nasIds = visibleNas.map((nas) => nas.id);
          const rows = nasIds.length
            ? await this.prisma.networkLog.groupBy({
                by: ['eventType'],
                where: { nasId: { in: nasIds }, loggedAt: time },
                _count: { _all: true },
              })
            : [];
          metrics.networkEvents = rows.map((row) => ({
            event: row.eventType,
            count: row._count._all,
          }));
          if (parsed.comparePeriods && previousTime && nasIds.length) {
            const previousRows = await this.prisma.networkLog.groupBy({
              by: ['eventType'],
              where: { nasId: { in: nasIds }, loggedAt: previousTime },
              _count: { _all: true },
            });
            const events = new Set([
              ...rows.map((row) => row.eventType),
              ...previousRows.map((row) => row.eventType),
            ]);
            for (const event of events) {
              visuals.push({
                title: `Network events (${event})`,
                unit: 'count',
                series: [
                  {
                    label: parsed.window.label,
                    points: [
                      {
                        label: 'Events',
                        value:
                          rows.find((row) => row.eventType === event)?._count
                            ._all ?? 0,
                      },
                    ],
                  },
                  {
                    label: previousLabel!,
                    points: [
                      {
                        label: 'Events',
                        value:
                          previousRows.find((row) => row.eventType === event)
                            ?._count._all ?? 0,
                      },
                    ],
                  },
                ],
              });
            }
          } else if (rows.length) {
            visuals.push({
              title: 'Network events',
              unit: 'count',
              series: [
                {
                  label: parsed.window.label,
                  points: rows.map((row) => ({
                    label: row.eventType,
                    value: row._count._all,
                  })),
                },
              ],
            });
          }
          break;
        }
      }
    }

    const normalized = parsed.normalized;
    const language: AiAgentSummary['language'] = /[\u0600-\u06ff]/u.test(
      question,
    )
      ? 'ur'
      : /\b(kitne|kitni|batao|aaj|pichlay|mahine|hai|hain|wasooli|rasid|mulazim|hazri|muqabla)\b/.test(
            normalized,
          )
        ? 'roman-ur'
        : 'en';
    return {
      window: parsed.window,
      metrics,
      omittedTopics,
      visuals,
      language,
    };
  }

  private karachiDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }
}
