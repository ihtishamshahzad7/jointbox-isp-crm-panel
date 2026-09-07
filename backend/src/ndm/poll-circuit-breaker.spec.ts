import { NdmPortPollingService } from './port-polling.service';

/**
 * PER-DEVICE CIRCUIT BREAKER.
 *
 * WHAT THE CONCURRENCY POOL DOES NOT FIX
 * The pool stops one dead device blocking its neighbours. It does not stop
 * dead devices CONSUMING the pool. An unreachable NAS holds a slot for its
 * full `snmpTimeoutMs × snmpRetries` — often 5-15 seconds — while a healthy
 * one answers in tens of milliseconds. A device that is down therefore costs
 * several hundred times more capacity than a device that is up, and goes on
 * costing it on every sweep, forever.
 *
 * At 1,000 NAS that arithmetic decides whether monitoring works at all: fifty
 * dead devices at 10s each is 500 seconds of slot time per cycle spent
 * re-confirming something already known, while the 950 live devices get polled
 * late.
 *
 * THE TENSION THIS HAS TO RESOLVE
 * Backing off too eagerly makes the panel slow to notice a real outage, which
 * is the one thing a monitoring system must not be. So the first failure never
 * backs off — devices blip, and a single timeout is usually noise — and one
 * success clears the penalty completely.
 */
describe('NdmPortPollingService — circuit breaker', () => {
  const REAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...REAL_ENV }; });
  beforeEach(() => {
    process.env.NODE_APP_INSTANCE = '0';
    process.env.SNMP_POLL_CONCURRENCY = '20';
  });

  const make = () => {
    const svc: any = new NdmPortPollingService(
      { networkDevice: { findMany: jest.fn().mockResolvedValue([]) } } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    return svc;
  };

  // ───────────────────────────────────────────────────────────────
  // The multiplier curve
  // ───────────────────────────────────────────────────────────────
  it('a healthy device is polled at exactly its configured interval', () => {
    const svc = make();
    expect(svc.backoffMultiplier(1)).toBe(1);
  });

  it('ONE failure does not back off', () => {
    /**
     * The important restraint. Devices blip — a dropped packet, a momentary
     * CPU spike on the router. Doubling the interval after a single timeout
     * would make the panel slower to confirm a genuine outage, which is
     * precisely the job it exists to do.
     */
    const svc = make();
    svc.recordPollOutcome(1, false);
    expect(svc.backoffMultiplier(1)).toBe(1);
  });

  it('backs off geometrically once failures persist', () => {
    const svc = make();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      svc.recordPollOutcome(1, false);
      seen.push(svc.backoffMultiplier(1));
    }
    expect(seen).toEqual([1, 2, 4, 8, 16, 16]);
  });

  it('never exceeds the configured ceiling', () => {
    // Unbounded backoff would eventually stop checking a device altogether,
    // and it would then never be seen to recover.
    process.env.SNMP_BACKOFF_MAX_MULTIPLIER = '4';
    const svc = make();
    for (let i = 0; i < 20; i++) svc.recordPollOutcome(1, false);
    expect(svc.backoffMultiplier(1)).toBe(4);
  });

  it('a single success clears the penalty immediately', () => {
    // Recovery must not be gradual. A device that answers is healthy now, and
    // easing it back over several cycles would keep the UI stale for minutes
    // after the fault was fixed.
    const svc = make();
    for (let i = 0; i < 10; i++) svc.recordPollOutcome(1, false);
    expect(svc.backoffMultiplier(1)).toBe(16);
    svc.recordPollOutcome(1, true);
    expect(svc.backoffMultiplier(1)).toBe(1);
  });

  it('failures are tracked per device, not globally', () => {
    // One dead NAS must not slow the polling of every other device.
    const svc = make();
    for (let i = 0; i < 5; i++) svc.recordPollOutcome(99, false);
    expect(svc.backoffMultiplier(99)).toBeGreaterThan(1);
    expect(svc.backoffMultiplier(1)).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────
  // Effect on the sweep
  // ───────────────────────────────────────────────────────────────
  it('THE POINT: a dead device stops consuming a slot every sweep', async () => {
    /**
     * Real time, short intervals — no clock mocking.
     *
     * Faking `Date.now()` does not work here: `pollDevice` awaits real timers,
     * so the fake clock and the event loop disagree and the due-calculation
     * reads whichever the mock happened to be in. Scaling the intervals down
     * to milliseconds keeps the arithmetic identical and the test honest.
     */
    const devices = [
      { id: 1, name: 'dead', pollIntervalSec: 0.1, snmpTimeoutMs: 80 },
      { id: 2, name: 'live', pollIntervalSec: 0.1, snmpTimeoutMs: 80 },
    ];
    const svc: any = new NdmPortPollingService(
      { networkDevice: { findMany: jest.fn().mockResolvedValue(devices) } } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
    );

    const polled: number[] = [];
    svc.pollDevice = jest.fn(async (d: any) => {
      // The real pollDevice stamps `last` before doing any work; that stamp is
      // what the due-filter reads. A stub that omits it leaves every device
      // permanently due and the test measures nothing.
      svc.last.set(d.id, Date.now());
      polled.push(d.id);
      // Device 1 reaches the same conclusion the real poller does when a
      // device does not answer. Driving the breaker from the VERDICT rather
      // than from elapsed time is the point — see recordPollOutcome.
      svc.recordPollOutcome(d.id, d.id !== 1);
    });

    // Ten sweeps, 110ms apart: the live device is due on every one.
    for (let sweep = 0; sweep < 10; sweep++) {
      await svc.tick();
      await new Promise((r) => setTimeout(r, 110));
    }

    const deadPolls = polled.filter((id) => id === 1).length;
    const livePolls = polled.filter((id) => id === 2).length;

    // The live device keeps its full cadence...
    expect(livePolls).toBe(10);
    // ...while the dead one is visited progressively less, freeing the slot
    // time that the live estate needs. It is still checked — never abandoned.
    expect(deadPolls).toBeLessThan(livePolls);
    expect(deadPolls).toBeGreaterThan(0);
    expect(svc.backoffMultiplier(1)).toBeGreaterThan(1);
    expect(svc.backoffMultiplier(2)).toBe(1);
  }, 30_000);

  it('reports how many devices are backed off', async () => {
    // A backed-off device otherwise looks identical to a device the poller has
    // simply stopped visiting, and the next person cannot tell the circuit
    // breaker from a bug.
    const svc = make();
    for (let i = 0; i < 4; i++) svc.recordPollOutcome(7, false);
    svc.recordPollOutcome(8, false); // one failure only — not backed off yet
    expect(svc.health.backedOffDevices).toBe(1);
  });

  it('a SLOW but successful poll is not treated as a failure', async () => {
    /**
     * The reason the breaker reads the verdict rather than the clock.
     *
     * A satellite or VPN-reached NAS configured with a 10s timeout can answer
     * in three seconds and be perfectly healthy. An earlier version of this
     * judged by elapsed time and would have backed that device off — polling a
     * working device less and less because its link is legitimately slow.
     *
     * The inverse is just as wrong: a device refusing the connection outright,
     * or rejecting the community string, fails in about a millisecond. By
     * duration that is the fastest, healthiest-looking device on the network.
     */
    const svc = make();
    svc.recordPollOutcome(1, true);  // slow, but it answered
    svc.recordPollOutcome(1, true);
    expect(svc.backoffMultiplier(1)).toBe(1);

    // …and the fast failure is correctly penalised.
    const other = make();
    other.recordPollOutcome(2, false);
    other.recordPollOutcome(2, false);
    expect(other.backoffMultiplier(2)).toBe(2);
  });
});
