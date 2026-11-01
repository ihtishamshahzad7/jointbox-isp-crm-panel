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

/** Stateful in-memory prisma double for nas / nasSnmpState / nasEvent. */
function makePrisma(seed: { nas?: any[] } = {}) {
  const states = new Map<number, any>();
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
        const cur = states.get(where.nasId); if (cur) states.set(where.nasId, { ...cur, ...data });
        return { count: cur ? 1 : 0 };
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
    expect(ev.filter((e) => e.type === 'timeout').length).toBe(1);
    // Second failure of the SAME kind → deduped (no new event).
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'timeout').length).toBe(1);
    // Recovery.
    mode = { ok: true, kind: 'ok', sysDescr: 'RouterOS', uptimeSec: 100, downInterfaces: [] };
    await svc.pollNas(nas(1));
    expect(states.get(1).status).toBe('ok');
    expect(ev.filter((e) => e.type === 'poll_recovered').length).toBe(1);
  });

  it('applies exponential backoff on repeated failures', async () => {
    const { prisma, states } = makePrisma();
    const h = makeHealth(() => ({ ok: false, kind: 'unreachable', message: 'unreachable' }));
    const svc: any = svcWith(prisma, h);
    const nextAfter = async () => { await svc.pollNas(nas(1)); return new Date(states.get(1).nextPollAt).getTime() - Date.now(); };
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
    const { prisma, events: ev } = makePrisma();
    const h = makeHealth(() => ({ ok: true, kind: 'ok', cpu: 97, memory: 10, downInterfaces: [] }));
    const svc: any = svcWith(prisma, h);
    await svc.pollNas(nas(1));
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'cpu_high').length).toBe(1); // cooldown-deduped
  });

  it('interface_down then interface_up on set change', async () => {
    const { prisma, events: ev } = makePrisma();
    let down: string[] = ['ether5'];
    const h = makeHealth(() => ({ ok: true, kind: 'ok', cpu: 5, memory: 5, downInterfaces: down }));
    const svc: any = svcWith(prisma, h);
    await svc.pollNas(nas(1));
    expect(ev.filter((e) => e.type === 'interface_down').length).toBe(1);
    down = []; // recovered
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
