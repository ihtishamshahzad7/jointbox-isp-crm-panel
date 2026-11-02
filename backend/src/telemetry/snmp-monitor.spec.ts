/**
 * Stage 2 — SNMP monitor worker: scheduling, state, events, backoff, API.
 *
 * DeviceHealthService.collectOne is mocked so these tests exercise the
 * ORCHESTRATION — state transitions, event dedup/recovery, exponential backoff,
 * single-flight, "one failed NAS does not block others", disabled handling, and
 * the read API — without a real SNMP device.
 */
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { SnmpMonitorService } from './snmp-monitor.service';
import { SnmpPollResult } from './device-health.service';

/** Stateful in-memory prisma double for nas / nasSnmpState / nasEvent. */
function makePrisma(seed: { nas?: any[] } = {}) {
  type MockSnmpState = {
    nasId: number;
    status?: string;
    consecutiveFailures?: number;
    lastPollAt?: Date;
    lastSuccessAt?: Date;
    lastErrorAt?: Date;
    lastError?: string | null;
    nextPollAt?: Date | null;
    sysDescr?: string | null;
    uptimeSec?: number | null;
    pollLeaseToken?: string | null;
    pollLeaseExpiresAt?: Date | null;
  };
  const states = new Map<number, MockSnmpState>();
  const events: any[] = [];
  let eventId = 1;
  const prisma: any = {
    nas: { findMany: async () => (seed.nas ?? []) },
    nasSnmpState: {
      findUnique: async ({ where }: any) => states.get(where.nasId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const cur = states.get(where.nasId);
        const next = cur ? { ...cur, ...update } : { nasId: where.nasId, consecutiveFailures: 0, ...create };
        states.set(where.nasId, next);
        return next;
      },
      updateMany: async ({ where, data }: any) => {
        const cur = states.get(where.nasId);
        if (!cur || (where.pollLeaseToken && cur.pollLeaseToken !== where.pollLeaseToken)) {
          return { count: 0 };
        }
        states.set(where.nasId, { ...cur, ...data });
        return { count: 1 };
      },
    },
    nasEvent: {
      create: async ({ data }: any) => { const e = { id: eventId++, ts: new Date(), ...data }; events.push(e); return e; },
      findFirst: async ({ where }: any) => {
        // ack lookup: by id (+ nasId)
        if (where.id !== undefined && typeof where.id === 'number') {
          return events.find((e) => e.id === where.id && e.nasId === where.nasId) ?? null;
        }
        // cooldown lookup: most recent same-type within window
        const since = where.ts?.gte ? new Date(where.ts.gte).getTime() : 0;
        return [...events].reverse().find((e) => e.nasId === where.nasId && e.type === where.type && (e.ts?.getTime?.() ?? 0) >= since) ?? null;
      },
      findMany: async ({ where = {}, take = 25 }: any) => {
        let rows = events.filter((e) => e.nasId === where.nasId);
        if (where.type) rows = rows.filter((e) => e.type === where.type);
        if (where.acknowledged !== undefined) rows = rows.filter((e) => !!e.acknowledged === where.acknowledged);
        if (where.id?.lt) rows = rows.filter((e) => e.id < where.id.lt);
        rows = rows.sort((a, b) => b.id - a.id).slice(0, take);
        return rows;
      },
      update: async ({ where, data }: any) => { const e = events.find((x) => x.id === where.id); Object.assign(e, data); return e; },
    },
    $queryRaw: <T>(
      _query: TemplateStringsArray,
      ...values: [number, number, string, number]
    ): Promise<T> => {
      const [nasId, intervalSec, pollLeaseToken, leaseMs] = values;
      const current = states.get(nasId);
      const now = Date.now();
      if (current && (
        (current.nextPollAt && new Date(current.nextPollAt).getTime() > now)
        || (current.pollLeaseExpiresAt && new Date(current.pollLeaseExpiresAt).getTime() > now)
      )) return [];
      states.set(nasId, {
        nasId,
        status: current?.status ?? 'unknown',
        consecutiveFailures: current?.consecutiveFailures ?? 0,
        ...current,
        nextPollAt: new Date(now + intervalSec * 1000),
        pollLeaseToken,
        pollLeaseExpiresAt: new Date(now + leaseMs),
      });
      return Promise.resolve([{ nasId }] as T);
    },
    $queryRawUnsafe: async () => [],
  };
  return { prisma, states, events };
}

function makeHealth(results: Record<number, any> | ((nas: any) => any)) {
  const calls: any[] = [];
  return {
    snmpAvailable: () => true,
    collectOne: async (nas: any) => {
      calls.push({ id: nas.id, at: Date.now() });
      const r = typeof results === 'function' ? results(nas) : results[nas.id];
      return r ?? { ok: true, kind: 'ok', sysDescr: 'X', uptimeSec: 10, cpu: 5, memory: 5, downInterfaces: [] };
    },
    calls,
  };
}
const events = () => ({ broadcast: jest.fn() });
const svcWith = (prisma: any, health: any) => new SnmpMonitorService(prisma, health as any, events() as any);
const nas = (id: number, extra: any = {}) => ({ id, nasname: `nas${id}`, nasIp: `10.0.0.${id}`, snmpPollSec: 30, snmpTimeoutMs: 4000, snmpRetries: 1, ownerId: 1, ...extra });
const restoreMonitorFlag = (value: string | undefined) => {
  if (value === undefined) delete process.env.SNMP_MONITOR;
  else process.env.SNMP_MONITOR = value;
};
const makeDue = (states: Map<number, any>, nasId: number) => {
  const state = states.get(nasId);
  if (state) state.nextPollAt = new Date(Date.now() - 1000);
};
const runPoll = (worker: SnmpMonitorService, device: ReturnType<typeof nas>) =>
  (worker as unknown as { pollNas: (nas: ReturnType<typeof nas>) => Promise<void> }).pollNas(device);

describe('SnmpMonitorService (Stage 2 worker)', () => {
  it('first successful poll records ok state and stays quiet (no spurious event)', async () => {
    const { prisma, states, events: ev } = makePrisma();
    const h = makeHealth({ 1: { ok: true, kind: 'ok', sysDescr: 'RouterOS', uptimeSec: 100, cpu: 10, memory: 20, downInterfaces: [] } });
    await (svcWith(prisma, h) as any).pollNas(nas(1));
    expect(states.get(1).status).toBe('ok');
    expect(states.get(1).consecutiveFailures).toBe(0);
    expect(states.get(1).lastSuccessAt).toBeTruthy();
    expect(ev.length).toBe(0); // unknown→ok is not an alert
  });

  it('emits a transition event on failure and a recovery event when it comes back', async () => {
    const { prisma, states, events: ev } = makePrisma();
    let mode: any = { ok: false, kind: 'timeout', message: 'No SNMP reply (timeout).' };
    const h = makeHealth(() => mode);
    const svc: any = svcWith(prisma, h);
    await svc.pollNas(nas(1));
    expect(states.get(1).status).toBe('timeout');
    expect(states.get(1).pollLeaseToken).toBeNull();
    expect(ev.filter((e) => e.type === 'timeout').length).toBe(1);
    // Second failure of the SAME kind → deduped (no new event).
    makeDue(states, 1);
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'timeout').length).toBe(1);
    // Recovery.
    mode = { ok: true, kind: 'ok', sysDescr: 'RouterOS', uptimeSec: 100, downInterfaces: [] };
    makeDue(states, 1);
    await svc.pollNas(nas(1));
    expect(states.get(1).status).toBe('ok');
    expect(ev.filter((e) => e.type === 'poll_recovered').length).toBe(1);
  });

  it('applies exponential backoff on repeated failures', async () => {
    const { prisma, states } = makePrisma();
    const h = makeHealth(() => ({ ok: false, kind: 'unreachable', message: 'unreachable' }));
    const svc: any = svcWith(prisma, h);
    const nextAfter = async () => {
      makeDue(states, 1);
      await svc.pollNas(nas(1));
      return new Date(states.get(1).nextPollAt).getTime() - Date.now();
    };
    const b1 = await nextAfter();
    const b2 = await nextAfter();
    const b3 = await nextAfter();
    expect(states.get(1).consecutiveFailures).toBe(3);
    expect(b2).toBeGreaterThan(b1); // 30s → 60s
    expect(b3).toBeGreaterThan(b2); // → 120s
  });

  it('never fabricates success on failure: no sysDescr/uptime recorded', async () => {
    const { prisma, states } = makePrisma();
    const h = makeHealth(() => ({ ok: false, kind: 'auth_error', message: 'SNMP authentication failed.' }));
    await (svcWith(prisma, h) as any).pollNas(nas(1));
    const s = states.get(1);
    expect(s.status).toBe('auth_error');
    expect(s.lastError).toMatch(/authentication/i);
    expect(s.lastSuccessAt).toBeUndefined();
    expect(s.sysDescr).toBeUndefined();
  });

  it('single-flight: a NAS already in flight is not polled again', async () => {
    const { prisma } = makePrisma();
    const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
    const svc: any = svcWith(prisma, h);
    svc.inFlight.add(1);
    await svc.pollNas(nas(1));
    expect(h.calls.length).toBe(0); // skipped while in flight
  });

  it('uses the database lease to keep independent worker instances from polling the same NAS', async () => {
    const { prisma, states } = makePrisma();
    let pollStarted!: () => void;
    let completePoll!: (result: SnmpPollResult) => void;
    const started = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    const firstHealth = {
      snmpAvailable: () => true,
      collectOne: () => {
        pollStarted();
        return new Promise<SnmpPollResult>((resolve) => {
          completePoll = resolve;
        });
      },
    };
    const secondHealth = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
    const firstWorker = svcWith(prisma, firstHealth);
    const secondWorker = svcWith(prisma, secondHealth);

    const firstPoll = runPoll(firstWorker, nas(1));
    await started;
    const ownerToken = states.get(1).pollLeaseToken;
    await runPoll(secondWorker, nas(1));
    expect(states.get(1).pollLeaseToken).toBe(ownerToken);
    expect(secondHealth.calls).toHaveLength(0);

    completePoll({ ok: true, kind: 'ok', downInterfaces: [] });
    await firstPoll;
    expect(states.get(1).status).toBe('ok');
    expect(states.get(1).pollLeaseToken).toBeNull();
    expect(states.get(1).pollLeaseExpiresAt).toBeNull();
  });

  it('keeps a timed-out poll lease until expiry because the underlying request may continue', async () => {
    const { prisma, states } = makePrisma();
    const firstHealth = {
      snmpAvailable: () => true,
      collectOne: () => new Promise<SnmpPollResult>(() => {}),
    };
    const firstWorker = svcWith(prisma, firstHealth);
    Object.defineProperty(firstWorker, 'pollBudgetMs', { value: () => 1 });
    await runPoll(firstWorker, nas(1));

    const leaseToken = states.get(1).pollLeaseToken;
    expect(states.get(1).status).toBe('timeout');
    expect(leaseToken).toBeTruthy();

    makeDue(states, 1);
    const secondHealth = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
    await runPoll(svcWith(prisma, secondHealth), nas(1));

    expect(secondHealth.calls).toHaveLength(0);
    expect(states.get(1).pollLeaseToken).toBe(leaseToken);
  });

  it('releases the poll lease when collection fails before the deadline', async () => {
    const { prisma, states } = makePrisma();
    const health = {
      snmpAvailable: () => true,
      collectOne: async () => {
        throw new Error('collection failed');
      },
    };

    await runPoll(svcWith(prisma, health), nas(1));

    expect(states.get(1).status).toBe('timeout');
    expect(states.get(1).pollLeaseToken).toBeNull();
    expect(states.get(1).pollLeaseExpiresAt).toBeNull();
  });

  it('recovers a claim after its lease expires', async () => {
    const { prisma, states } = makePrisma();
    states.set(1, {
      nasId: 1,
      status: 'timeout',
      consecutiveFailures: 1,
      nextPollAt: new Date(Date.now() - 1000),
      pollLeaseToken: '00000000-0000-4000-8000-000000000001',
      pollLeaseExpiresAt: new Date(Date.now() - 1000),
    });
    const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));

    await runPoll(svcWith(prisma, h), nas(1));

    expect(h.calls).toHaveLength(1);
    expect(states.get(1).status).toBe('ok');
  });

  it('skips polling and releases inFlight when reserving the poll slot fails', async () => {
    const { prisma } = makePrisma();
    const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
    const svc: any = svcWith(prisma, h);
    const warn = jest.spyOn(svc.log, 'warn').mockImplementation(() => undefined);
    jest.spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('database connection details'));

    await expect(svc.pollNas(nas(1))).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(svc.inFlight.has(1)).toBe(false);
    expect(warn).toHaveBeenCalledWith('SNMP polling slot reservation failed for NAS 1; poll skipped.');

    await svc.pollNas(nas(1));
    expect(h.calls).toHaveLength(1);
    expect(svc.inFlight.has(1)).toBe(false);
  });

  it('dispatch: one failing NAS does not block the others (bounded fan-out)', async () => {
    const prev = process.env.SNMP_MONITOR;
    process.env.SNMP_MONITOR = 'on';
    try {
      const { prisma, states } = makePrisma({ nas: [nas(1), nas(2), nas(3)] });
      const h = makeHealth((n: any) => n.id === 2
        ? Promise.reject(new Error('boom')) // simulate collectOne throwing
        : { ok: true, kind: 'ok', downInterfaces: [] });
      // collectOne that throws for nas 2 — the monitor must still poll 1 and 3.
      const svc: any = svcWith(prisma, h);
      await svc.dispatch();
      expect(states.get(1)?.status).toBe('ok');
      expect(states.get(3)?.status).toBe('ok');
      // nas 2 got a state too (timeout from the thrown error budget path)
      expect(states.get(2)).toBeTruthy();
    } finally {
      restoreMonitorFlag(prev);
    }
  });

  it('cpu_high alert fires once then is suppressed within the cooldown', async () => {
    const { prisma, states, events: ev } = makePrisma();
    const h = makeHealth(() => ({ ok: true, kind: 'ok', cpu: 97, memory: 10, downInterfaces: [] }));
    const svc: any = svcWith(prisma, h);
    await svc.pollNas(nas(1));
    makeDue(states, 1);
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'cpu_high').length).toBe(1); // cooldown-deduped
  });

  it('interface_down then interface_up on set change', async () => {
    const { prisma, states, events: ev } = makePrisma();
    let down: string[] = ['ether5'];
    const h = makeHealth(() => ({ ok: true, kind: 'ok', cpu: 5, memory: 5, downInterfaces: down }));
    const svc: any = svcWith(prisma, h);
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'interface_down').length).toBe(1);
    down = []; // recovered
    makeDue(states, 1);
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'interface_up').length).toBe(1);
  });

  it('disabled: dispatch does nothing when SNMP_MONITOR=off', async () => {
    const prev = process.env.SNMP_MONITOR;
    process.env.SNMP_MONITOR = 'off';
    try {
      const { prisma, states } = makePrisma({ nas: [nas(1)] });
      const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
      await (svcWith(prisma, h) as any).dispatch();
      expect(states.size).toBe(0);
      expect(h.calls.length).toBe(0);
    } finally {
      restoreMonitorFlag(prev);
    }
  });

  it('disabled by default when SNMP_MONITOR is unset', async () => {
    const prev = process.env.SNMP_MONITOR;
    delete process.env.SNMP_MONITOR;
    try {
      const { prisma, states } = makePrisma({ nas: [nas(1)] });
      const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
      await (svcWith(prisma, h) as any).dispatch();
      expect(states.size).toBe(0);
      expect(h.calls.length).toBe(0);
    } finally {
      restoreMonitorFlag(prev);
    }
  });

  it('enabled only by explicit SNMP_MONITOR=on', async () => {
    const prev = process.env.SNMP_MONITOR;
    process.env.SNMP_MONITOR = 'on';
    try {
      const { prisma, states } = makePrisma({ nas: [nas(1)] });
      const h = makeHealth(() => ({ ok: true, kind: 'ok', downInterfaces: [] }));
      await (svcWith(prisma, h) as any).dispatch();
      expect(states.get(1)?.status).toBe('ok');
      expect(h.calls).toHaveLength(1);
    } finally {
      restoreMonitorFlag(prev);
    }
  });

  describe('read API', () => {
    it('paginates events with a bounded page size and cursor', async () => {
      const { prisma, events: store } = makePrisma();
      for (let i = 0; i < 5; i++) store.push({ id: i + 1, nasId: 1, type: 'timeout', ts: new Date() });
      const svc: any = svcWith(prisma, makeHealth(() => ({ ok: true, kind: 'ok' })));
      const page1 = await svc.listEvents(1, { limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).toBe(4); // ids 5,4 returned, next < 4
      const page2 = await svc.listEvents(1, { limit: 2, cursor: page1.nextCursor });
      expect(page2.items.map((e: any) => e.id)).toEqual([3, 2]);
    });

    it('caps page size at 100', async () => {
      const { prisma } = makePrisma();
      const svc: any = svcWith(prisma, makeHealth(() => ({ ok: true, kind: 'ok' })));
      const res = await svc.listEvents(1, { limit: 99999 });
      expect(res.pageSize).toBe(100);
    });

    it('ack marks an event and rejects a foreign event id', async () => {
      const { prisma, events: store } = makePrisma();
      store.push({ id: 10, nasId: 1, type: 'timeout', ts: new Date(), acknowledged: false });
      const svc: any = svcWith(prisma, makeHealth(() => ({ ok: true, kind: 'ok' })));
      const acked = await svc.ackEvent(1, 10, 42);
      expect(acked.acknowledged).toBe(true);
      expect(acked.acknowledgedBy).toBe(42);
      await expect(svc.ackEvent(1, 999, 42)).rejects.toThrow(/not found/i);
    });
  });
});
