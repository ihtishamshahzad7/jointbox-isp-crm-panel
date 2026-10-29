import { LogsService } from './logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

describe('LogsService RADIUS records', () => {
  it('does not return password or CHAP material in authentication records', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn((query: string) =>
        query.includes('COUNT')
          ? [{ n: 1 }]
          : [
              {
                id: 'auth-1',
                authdate: new Date(),
                username: 'subscriber-1',
                reply: 'Access-Reject',
                pass: 'chap-response',
                subpass: 'subscriber-password',
                mac: null,
                port: null,
                nasip: null,
                nas: null,
              },
            ],
      ),
    };
    const scope = {
      isAdmin: () => true,
      demoSessionSql: () => '',
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getRadiusAuthLogs({
      sub: 1,
      role: 'SUPER_ADMIN',
    });
    const record = result.logs[0];

    expect(record).toMatchObject({ result: 'Reject', reason: 'Access-Reject' });
    expect(record).not.toHaveProperty('password');
    expect(record).not.toHaveProperty('chap');
    expect(record).not.toHaveProperty('pass');
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).not.toContain('p.pass');
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).not.toContain('s.password');
  });

  it('distinguishes fresh, stale, stopped, and untracked accounting sessions', async () => {
    const now = new Date();
    const minutesAgo = (minutes: number) =>
      new Date(now.getTime() - minutes * 60_000);
    const prisma = {
      radAcct: {
        findMany: jest.fn().mockResolvedValue([
          {
            radacctid: 1n,
            acctsessionid: 'fresh',
            acctstarttime: minutesAgo(50),
            acctstoptime: null,
          },
          {
            radacctid: 2n,
            acctsessionid: 'stale',
            acctstarttime: minutesAgo(90),
            acctstoptime: null,
          },
          {
            radacctid: 3n,
            acctsessionid: 'stopped',
            acctstarttime: minutesAgo(60),
            acctstoptime: minutesAgo(5),
          },
          {
            radacctid: 4n,
            acctsessionid: 'unknown',
            acctstarttime: minutesAgo(10),
            acctstoptime: null,
          },
        ]),
        count: jest.fn().mockResolvedValue(4),
      },
      pppoeSession: {
        findMany: jest.fn().mockResolvedValue([
          {
            sessionId: 'fresh',
            isActive: true,
            lastSeenAt: minutesAgo(2),
            endTime: null,
            disconnectReason: null,
          },
          {
            sessionId: 'stale',
            isActive: true,
            lastSeenAt: minutesAgo(40),
            endTime: null,
            disconnectReason: null,
          },
          {
            sessionId: 'stopped',
            isActive: false,
            lastSeenAt: minutesAgo(5),
            endTime: minutesAgo(5),
            disconnectReason: null,
          },
        ]),
      },
      nas: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const scope = {
      isAdmin: () => true,
      radiusWhere: jest.fn().mockResolvedValue({}),
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getRadiusSessions({
      sub: 1,
      role: 'SUPER_ADMIN',
    });

    expect(result.items.map((row) => row.sessionState)).toEqual([
      'active',
      'stale',
      'stopped',
      'unknown',
    ]);
    expect(result.items.map((row) => row.online)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(result.items[1].durationSec).toBe(50 * 60);
    expect(result.items[3].durationSec).toBeNull();
  });

  it('filters stopped accounting rows from the current-session query', async () => {
    let queryWhere: Record<string, unknown> | undefined;
    const prisma = {
      radAcct: {
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          queryWhere = where;
          return Promise.resolve([]);
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      pppoeSession: { findMany: jest.fn().mockResolvedValue([]) },
      nas: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const scope = {
      isAdmin: () => true,
      radiusWhere: jest.fn().mockResolvedValue({}),
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    await service.getRadiusSessions(
      { sub: 1, role: 'SUPER_ADMIN' },
      { cause: 'current' },
    );

    expect(queryWhere).toHaveProperty('acctstoptime', null);
  });
});

describe('LogsService audit and application-session responses', () => {
  const actor = { sub: 1, role: 'SUPER_ADMIN' };
  const scope = { isAdmin: () => true };

  it('keeps automated audit records out of the human activity view', async () => {
    let queryWhere: Record<string, unknown> | undefined;
    const prisma = {
      activityLog: {
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          queryWhere = where;
          return Promise.resolve([]);
        }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    await service.getActivityLogs(actor, { auditType: 'activity' });

    expect(queryWhere?.AND).toContainEqual({ userId: { not: null } });
  });

  it('filters administrative changes separately from system events', async () => {
    let queryWhere: Record<string, unknown> | undefined;
    const prisma = {
      activityLog: {
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          queryWhere = where;
          return Promise.resolve([]);
        }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    await service.getActivityLogs(actor, { auditType: 'changes' });

    expect(queryWhere?.entity).toEqual({ not: 'SYSTEM' });
  });

  it('returns failed activations using the selected account and query filters', async () => {
    const record = { id: 8, username: 'subscriber-8', reason: 'timeout' };
    const prisma = {
      failedActivation: {
        findMany: jest.fn().mockResolvedValue([record]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getFailedActivations(actor, {
      forUser: 7,
      q: ' timeout ',
      sinceHours: 24,
    });
    const where = prisma.failedActivation.findMany.mock.calls[0][0].where;

    expect(result).toEqual({ logs: [record], total: 1 });
    expect(where.createdById).toEqual({ in: [7] });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.OR).toContainEqual({
      reason: { contains: 'timeout', mode: 'insensitive' },
    });
  });

  it('redacts sensitive values from activity-log details', async () => {
    const prisma = {
      activityLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            details:
              'PATCH /settings · {"apiKey":"private-value","safe":"visible"}',
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getActivityLogs(actor);
    const response = JSON.stringify(result);

    expect(response).toContain('\\"apiKey\\":\\"[redacted]\\"');
    expect(response).not.toContain('private-value');
    expect(response).toContain('\\"safe\\":\\"visible\\"');
  });

  it('redacts sensitive values from activity entries in the unified timeline', async () => {
    const prisma = {
      activityLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            createdAt: new Date(),
            details: '{"token":"private-value"}',
          },
        ]),
      },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getTimeline(actor, { type: 'activity' });
    const response = JSON.stringify(result);

    expect(response).toContain('\\"token\\":\\"[redacted]\\"');
    expect(response).not.toContain('private-value');
  });

  it('does not select or return application session tokens', async () => {
    const session = {
      id: 1,
      ipAddress: '192.0.2.1',
      userAgent: 'test',
      loginAt: new Date(),
      expiresAt: new Date(),
    };
    const prisma = {
      sessionLog: { findMany: jest.fn().mockResolvedValue([session]) },
    };
    const service = new LogsService(
      prisma as unknown as PrismaService,
      scope as unknown as ScopeService,
      {} as MikrotikSyncService,
    );

    const result = await service.getSessions(actor);

    expect(prisma.sessionLog.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { loginAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        loginAt: true,
        expiresAt: true,
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});
