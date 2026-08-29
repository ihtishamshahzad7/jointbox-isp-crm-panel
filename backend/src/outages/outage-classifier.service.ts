import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Why is the area down?
 *
 * detect() already finds outages and says whether one fell inside a published
 * load-shedding window. What it could not say was the thing that decides what
 * anyone DOES about it: send a technician, or wait for WAPDA. Its own note
 * ended "verify whether this is power or network" — that verification is what
 * this service automates.
 *
 * THE SIGNALS ARE REAL, NOT INFERRED FROM TIMING ALONE
 *
 * The strongest discriminators are already collected on every PON port:
 *
 *   DYING GASP — an ONU's final transmission as its mains supply collapses.
 *     It costs the ONU its last stored charge to send. If ONUs are gasping,
 *     the customer premises lost POWER. This is not a heuristic.
 *   LOS (loss of signal) — the optical carrier itself is gone while the ONU
 *     still had power to notice. That is the FIBRE, not the electricity.
 *
 * Those two states are mutually exclusive in practice and settle the question
 * that matters most in this market, where the majority of "internet is down"
 * calls are actually the grid.
 *
 * DESIGN RULE: never guess. A wrong cause is worse than no cause — it sends a
 * technician to dig up a road during a load-shedding slot. Every verdict
 * carries a confidence and the reasons behind it, and the honest answer when
 * signals conflict or are missing is UNKNOWN.
 */
export type OutageCauseVerdict = {
  cause: 'POWER_RELATED' | 'FIBER_CUT' | 'EQUIPMENT_FAILURE' | 'UPSTREAM_ISP' | 'UNKNOWN';
  confidence: number;
  reasons: string[];
};

@Injectable()
export class OutageClassifierService {
  private readonly logger = new Logger(OutageClassifierService.name);

  constructor(private prisma: PrismaService) {}

  /** How far back to look for ONU state around the drop. */
  private get windowMin() {
    return Number(process.env.OUTAGE_CAUSE_WINDOW_MIN || 15);
  }

  /**
   * Score the likely cause for one area.
   *
   * `scheduled` comes from the caller because detect() has already computed
   * it — recomputing would double the schedule query on every outage.
   */
  async classify(
    areaId: number,
    opts: { scheduled?: boolean; at?: Date } = {},
  ): Promise<OutageCauseVerdict> {
    const at = opts.at ?? new Date();
    const since = new Date(at.getTime() - this.windowMin * 60_000);
    const reasons: string[] = [];

    // ── Signal 1: what the ONUs in this area last reported ───────────────
    // Onu → Olt → area is the only path from optical telemetry to a service
    // area, so an area with no OLT simply has no optical evidence.
    let gasping = 0;
    let los = 0;
    let opticalSeen = 0;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT t.status AS status, COUNT(*)::int AS n
          FROM "onu_telemetry" t
          JOIN "Onu" o ON o.id = t."onuId"
          JOIN "Olt" l ON l.id = o."oltId"
         WHERE l."areaId" = ${areaId}
           AND t."collectedAt" >= ${since}
         GROUP BY t.status`;
      for (const r of rows) {
        const n = Number(r.n) || 0;
        opticalSeen += n;
        if (r.status === 'DYING_GASP') gasping += n;
        else if (r.status === 'LOS') los += n;
      }
    } catch (e: any) {
      // No optical estate, or the tables are absent on this deployment. That
      // is a missing signal, not an error — fall through to the weaker ones.
      this.logger.debug?.(`Optical signal unavailable for area ${areaId}: ${e?.message || e}`);
    }

    // ── Signal 2: is the equipment serving the area itself down? ─────────
    // If the NAS/OLT is unreachable, the customers below it were never going
    // to stay up, and the cause is upstream of every one of them.
    let deviceDown = 0;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n
          FROM "NetworkDevice" d
         WHERE d."areaId" = ${areaId}
           AND d.status = 'DOWN'`;
      deviceDown = Number(rows?.[0]?.n || 0);
    } catch {
      /* device table shape differs on older deployments — treat as no signal */
    }

    // ── Signal 3: did other, independent areas drop at the same time? ────
    // One area down is local. Several unrelated areas dropping together is
    // almost always something above all of them.
    let siblingAreas = 0;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n
          FROM "PowerOutage" o
         WHERE o."endedAt" IS NULL
           AND o."areaId" IS DISTINCT FROM ${areaId}
           AND o."startedAt" >= ${since}`;
      siblingAreas = Number(rows?.[0]?.n || 0);
    } catch {
      /* no signal */
    }

    // ── Weigh them, strongest evidence first ─────────────────────────────

    // Simultaneous independent areas outrank local evidence: if three areas on
    // different equipment went at once, the local optical picture is a symptom.
    if (siblingAreas >= 2) {
      reasons.push(`${siblingAreas} other areas dropped within ${this.windowMin} minutes`);
      if (opts.scheduled) {
        // Load shedding is regional, so simultaneous areas are expected and
        // do NOT imply an upstream fault.
        reasons.push('all inside a published load-shedding window');
        return { cause: 'POWER_RELATED', confidence: 0.9, reasons };
      }
      return { cause: 'UPSTREAM_ISP', confidence: 0.7, reasons };
    }

    // Dying gasp is as close to proof of a power cut as this system can get.
    if (gasping > 0) {
      reasons.push(`${gasping} ONU${gasping === 1 ? '' : 's'} sent a dying gasp (mains lost at the premises)`);
      if (opts.scheduled) reasons.push('inside a published load-shedding window');
      return {
        cause: 'POWER_RELATED',
        // The schedule agreeing with the gasps is corroboration, not new proof.
        confidence: opts.scheduled ? 0.97 : 0.92,
        reasons,
      };
    }

    // LOS with no gasps: the ONUs had power to report, and the light was gone.
    if (los > 0) {
      reasons.push(`${los} ONU${los === 1 ? '' : 's'} reported loss of optical signal with no dying gasp`);
      if (deviceDown > 0) {
        // A dark OLT explains LOS downstream without any fibre being cut.
        reasons.push(`${deviceDown} network device(s) in this area are down`);
        return { cause: 'EQUIPMENT_FAILURE', confidence: 0.75, reasons };
      }
      reasons.push('the ONUs still had power, so the fibre path is the fault');
      return { cause: 'FIBER_CUT', confidence: 0.85, reasons };
    }

    // No optical verdict. Equipment being down is the next strongest fact.
    if (deviceDown > 0) {
      reasons.push(`${deviceDown} network device(s) in this area are down`);
      return { cause: 'EQUIPMENT_FAILURE', confidence: 0.7, reasons };
    }

    // Nothing observed optically — fall back to the timetable alone.
    if (opts.scheduled) {
      reasons.push('inside a published load-shedding window');
      if (opticalSeen === 0) reasons.push('no optical telemetry for this area to confirm it');
      // Deliberately moderate: the timetable says the power SHOULD be off, not
      // that it is. A fibre cut during a load-shedding slot looks identical.
      return { cause: 'POWER_RELATED', confidence: 0.6, reasons };
    }

    reasons.push(
      opticalSeen === 0
        ? 'no optical telemetry for this area'
        : 'ONUs are reachable and reported no dying gasp or signal loss',
    );
    reasons.push('outside any published load-shedding window');
    return { cause: 'UNKNOWN', confidence: 0.2, reasons };
  }

  /** One-line summary for an alert or the status page. */
  describe(v: OutageCauseVerdict): string {
    const label: Record<string, string> = {
      POWER_RELATED: 'Likely a power failure',
      FIBER_CUT: 'Likely a fibre fault',
      EQUIPMENT_FAILURE: 'Likely an equipment failure',
      UPSTREAM_ISP: 'Likely an upstream/transit fault',
      UNKNOWN: 'Cause not established',
    };
    const head = label[v.cause] ?? 'Cause not established';
    // Below ~0.5 this is a suggestion, and the wording must not overstate it.
    const hedge = v.confidence >= 0.85 ? '' : v.confidence >= 0.5 ? ' (probable)' : ' (unconfirmed)';
    return `${head}${hedge} — ${v.reasons.join('; ')}`;
  }
}
