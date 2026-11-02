import { readFileSync } from 'fs';
import { join } from 'path';
import type { EventsService } from '../../src/common/events.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { PgHarness, describePg } from '../pg';
import { SnmpMonitorService } from '../../src/telemetry/snmp-monitor.service';
import type {
  DeviceHealthService,
  SnmpPollResult,
} from '../../src/telemetry/device-health.service';

const LEASE_MIGRATION = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20261101150000_nas_snmp_poll_lease/migration.sql',
  ),
  'utf8',
);

type TestNas = {
  id: number;
  nasname: string;
  snmpPollSec: number;
  snmpTimeoutMs: number;
  snmpRetries: number;
  ownerId: number;
};

type SqlRow = Record<string, unknown>;
type TestPrisma = {
  $queryRaw: <T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
  nasSnmpState: {
    findUnique: (args: { where: { nasId: number } }) => Promise<SqlRow | null>;
    updateMany: (args: {
      where: { nasId: number; pollLeaseToken: string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  nasEvent: {
    create: () => Promise<never>;
    findFirst: () => Promise<null>;
  };
};

const device: TestNas = {
  id: 7001,
  nasname: 'integration-nas',
  snmpPollSec: 10,
  snmpTimeoutMs: 100,
  snmpRetries: 0,
  ownerId: 1,
};

function makeBarrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    allArrived,
    wait: async () => {
      arrived++;
      if (arrived === parties) release();
      await allArrived;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makePrisma(
  pg: PgHarness,
  beforeClaim?: () => Promise<void>,
): TestPrisma {
  return {
    $queryRaw: async <T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> => {
      await beforeClaim?.();
      const sql = strings.reduce(
        (query, part, index) =>
          query + part + (index < values.length ? `$${index + 1}` : ''),
        '',
      );
      const result = await pg.query<SqlRow>(sql, values);
      return result.rows as unknown as T;
    },
    nasSnmpState: {
      findUnique: async ({ where }) => {
        const result = await pg.query<SqlRow>(
          'SELECT * FROM "nas_snmp_state" WHERE "nasId" = $1',
          [where.nasId],
        );
        return result.rows[0] ?? null;
      },
      updateMany: async ({ where, data }) => {
        const entries = Object.entries(data);
        const assignments = entries.map(
          ([column], index) => `"${column}" = $${index + 1}`,
        );
        assignments.push('"updatedAt" = NOW()');
        const values = entries.map(([, value]) => value);
        values.push(where.nasId, where.pollLeaseToken);
        const idParam = entries.length + 1;
        const tokenParam = entries.length + 2;
        const result = await pg.query(
          `UPDATE "nas_snmp_state" SET ${assignments.join(', ')}
             WHERE "nasId" = $${idParam} AND "pollLeaseToken" = $${tokenParam}::uuid`,
          values,
        );
        return { count: result.rowCount ?? 0 };
      },
    },
    nasEvent: {
      create: () =>
        Promise.reject(
          new Error('Unexpected NAS event write in lease integration test.'),
        ),
      findFirst: () => Promise.resolve(null),
    },
  };
}

function makeWorker(
  pg: PgHarness,
  collectOne: (nas: TestNas) => Promise<SnmpPollResult>,
  beforeClaim?: () => Promise<void>,
) {
  const prisma = makePrisma(pg, beforeClaim);
  const health = { snmpAvailable: () => true, collectOne };
  const events = { broadcast: () => undefined };
  return {
    prisma,
    service: new SnmpMonitorService(
      prisma as unknown as PrismaService,
      health as unknown as DeviceHealthService,
      events as unknown as EventsService,
    ),
  };
}

function runPoll(service: SnmpMonitorService) {
  const pollable = service as unknown as {
    pollNas(nas: TestNas): Promise<void>;
  };
  return pollable.pollNas(device);
}

describePg('PostgreSQL SNMP polling lease', () => {
  const pg = new PgHarness('snmp_poll_lease');
  let migrationPreservedExistingState = false;

  beforeAll(async () => {
    await pg.setup([
      `CREATE TABLE "nas_snmp_state" (
        "nasId" INTEGER PRIMARY KEY,
        "status" VARCHAR(20) NOT NULL DEFAULT 'unknown',
        "lastPollAt" TIMESTAMP(3),
        "lastSuccessAt" TIMESTAMP(3),
        "lastErrorAt" TIMESTAMP(3),
        "lastError" VARCHAR(300),
        "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
        "nextPollAt" TIMESTAMP(3),
        "sysDescr" VARCHAR(300),
        "uptimeSec" INTEGER,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ]);
    await pg.query(
      `INSERT INTO "nas_snmp_state"
         ("nasId", "status", "lastPollAt", "lastSuccessAt", "consecutiveFailures", "nextPollAt", "sysDescr", "uptimeSec")
       VALUES (7001, 'ok', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute', 2,
         NOW() - INTERVAL '1 second', 'existing-device-description', 120)`,
    );
    const before = await pg.query<SqlRow>(
      `SELECT "nasId", "status", "lastPollAt", "lastSuccessAt", "consecutiveFailures",
              "nextPollAt", "sysDescr", "uptimeSec"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    await pg.query(LEASE_MIGRATION);
    const after = await pg.query<SqlRow>(
      `SELECT "nasId", "status", "lastPollAt", "lastSuccessAt", "consecutiveFailures",
              "nextPollAt", "sysDescr", "uptimeSec", "pollLeaseToken", "pollLeaseExpiresAt"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    const { pollLeaseToken, pollLeaseExpiresAt, ...preserved } = after.rows[0];
    migrationPreservedExistingState =
      JSON.stringify(before.rows[0]) === JSON.stringify(preserved) &&
      pollLeaseToken === null &&
      pollLeaseExpiresAt === null;
  });

  afterAll(() => pg.teardown());

  beforeEach(async () => {
    await pg.query(
      `UPDATE "nas_snmp_state"
          SET "status" = 'unknown', "lastPollAt" = NULL, "lastSuccessAt" = NULL,
              "lastErrorAt" = NULL, "lastError" = NULL, "consecutiveFailures" = 0,
              "nextPollAt" = NOW() - INTERVAL '1 second', "sysDescr" = NULL,
              "uptimeSec" = NULL, "pollLeaseToken" = NULL, "pollLeaseExpiresAt" = NULL
        WHERE "nasId" = 7001`,
    );
  });

  it('adds lease columns without changing existing NAS monitoring data', () => {
    expect(migrationPreservedExistingState).toBe(true);
  });

  it('allows exactly one of two concurrent service instances to poll a due NAS', async () => {
    const barrier = makeBarrier(2);
    const firstStarted = deferred<void>();
    const finishFirst = deferred<SnmpPollResult>();
    const firstHealth = {
      snmpAvailable: () => true,
      collectOne: () => {
        firstStarted.resolve();
        return finishFirst.promise;
      },
    };
    const secondPolls: number[] = [];
    const secondHealth = {
      snmpAvailable: () => true,
      collectOne: (nas: TestNas) => {
        secondPolls.push(nas.id);
        return Promise.resolve({ ok: true, kind: 'ok', downInterfaces: [] });
      },
    };
    const first = makeWorker(pg, firstHealth.collectOne, barrier.wait);
    const second = makeWorker(pg, secondHealth.collectOne, barrier.wait);

    const firstPoll = runPoll(first.service);
    const secondPoll = runPoll(second.service);
    await Promise.all([barrier.allArrived, firstStarted.promise, secondPoll]);

    expect(secondPolls).toEqual([]);
    const owned = await pg.query<SqlRow>(
      `SELECT "pollLeaseToken" FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(owned.rows[0].pollLeaseToken).toBeTruthy();

    finishFirst.resolve({ ok: true, kind: 'ok', downInterfaces: [] });
    await firstPoll;
    expect(
      Number(
        await pg.scalar(
          'SELECT count(*) FROM "nas_snmp_state" WHERE "nasId" = 7001 AND "pollLeaseToken" IS NULL',
        ),
      ),
    ).toBe(1);
  });

  it('reclaims an expired lease using the PostgreSQL claim predicate', async () => {
    const previousToken = '00000000-0000-4000-8000-000000000001';
    await pg.query(
      `UPDATE "nas_snmp_state"
          SET "pollLeaseToken" = $1::uuid, "pollLeaseExpiresAt" = NOW() - INTERVAL '1 second'
        WHERE "nasId" = 7001`,
      [previousToken],
    );
    const calls: number[] = [];
    const worker = makeWorker(pg, (nas: TestNas) => {
      calls.push(nas.id);
      return Promise.resolve({ ok: true, kind: 'ok', downInterfaces: [] });
    });

    await runPoll(worker.service);

    expect(calls).toEqual([7001]);
    const state = await pg.query<SqlRow>(
      `SELECT "status", "pollLeaseToken", "pollLeaseExpiresAt"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(state.rows[0].status).toBe('ok');
    expect(state.rows[0].pollLeaseToken).toBeNull();
    expect(state.rows[0].pollLeaseExpiresAt).toBeNull();
  });

  it('prevents an expired worker from writing or releasing a newer lease', async () => {
    const firstStarted = deferred<void>();
    const finishFirst = deferred<SnmpPollResult>();
    const first = makeWorker(pg, () => {
      firstStarted.resolve();
      return finishFirst.promise;
    });
    const firstPoll = runPoll(first.service);
    await firstStarted.promise;
    const firstToken = await pg.scalar<string>(
      'SELECT "pollLeaseToken" FROM "nas_snmp_state" WHERE "nasId" = 7001',
    );

    await pg.query(
      `UPDATE "nas_snmp_state"
          SET "nextPollAt" = NOW() - INTERVAL '1 second',
              "pollLeaseExpiresAt" = NOW() - INTERVAL '1 second'
        WHERE "nasId" = 7001`,
    );
    const secondStarted = deferred<void>();
    const finishSecond = deferred<SnmpPollResult>();
    const second = makeWorker(pg, () => {
      secondStarted.resolve();
      return finishSecond.promise;
    });
    const secondPoll = runPoll(second.service);
    await secondStarted.promise;
    const secondToken = await pg.scalar<string>(
      'SELECT "pollLeaseToken" FROM "nas_snmp_state" WHERE "nasId" = 7001',
    );
    expect(secondToken).not.toBe(firstToken);

    finishFirst.resolve({
      ok: true,
      kind: 'ok',
      sysDescr: 'stale-worker',
      downInterfaces: [],
    });
    await firstPoll;
    let state = await pg.query<SqlRow>(
      `SELECT "status", "sysDescr", "pollLeaseToken"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(state.rows[0]).toMatchObject({
      status: 'unknown',
      sysDescr: null,
      pollLeaseToken: secondToken,
    });

    finishSecond.resolve({
      ok: true,
      kind: 'ok',
      sysDescr: 'current-worker',
      downInterfaces: [],
    });
    await secondPoll;
    state = await pg.query<SqlRow>(
      `SELECT "status", "sysDescr", "pollLeaseToken"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(state.rows[0]).toMatchObject({
      status: 'ok',
      sysDescr: 'current-worker',
      pollLeaseToken: null,
    });
  });

  it('releases a claim when SNMP collection fails before its deadline', async () => {
    const worker = makeWorker(pg, () =>
      Promise.reject(new Error('collection failed')),
    );

    await runPoll(worker.service);

    const state = await pg.query<SqlRow>(
      `SELECT "status", "pollLeaseToken", "pollLeaseExpiresAt"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(state.rows[0].status).toBe('timeout');
    expect(state.rows[0].pollLeaseToken).toBeNull();
    expect(state.rows[0].pollLeaseExpiresAt).toBeNull();
  });

  it('retains a timed-out request lease for expiry-based recovery', async () => {
    const worker = makeWorker(pg, () => new Promise<SnmpPollResult>(() => {}));
    Object.defineProperty(worker.service, 'pollBudgetMs', { value: () => 1 });

    await runPoll(worker.service);

    const state = await pg.query<SqlRow>(
      `SELECT "pollLeaseToken", "pollLeaseExpiresAt"
         FROM "nas_snmp_state" WHERE "nasId" = 7001`,
    );
    expect(state.rows[0].pollLeaseToken).toBeTruthy();
    expect(
      new Date(state.rows[0].pollLeaseExpiresAt).getTime(),
    ).toBeGreaterThan(Date.now());
  });
});
