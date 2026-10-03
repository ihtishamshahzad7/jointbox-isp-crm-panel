import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MikrotikSyncService } from '../nas/mikrotik-sync.service';

interface LivePoint {
  t: number; // epoch ms
  upBps: number; // bytes/sec upload (from subscribers → routers)
  downBps: number; // bytes/sec download (routers → subscribers)
  /**
   * The same tick split per router (nasId → [upBps, downBps]), only for the
   * routers that contributed a rate. The totals above are the whole
   * installation; this is what lets one company's view be summed from its own
   * routers alone.
   */
  byNas: Map<number, [number, number]>;
}

interface NasCounters {
  up: number; // cumulative bytes FROM subscribers (rx on router)
  down: number; // cumulative bytes TO subscribers (tx on router)
}

interface LiveNas {
  id: number;
  nasIp: string;
  apiPort: number;
  apiUsername: string;
  apiPassword: string;
}

/**
 * LiveTrafficService — 2-second whole-network traffic meter.
 *
 * The 5/10-minute database samplers (nas/subscriber sample tables) cannot
 * drive a real-time graph, so this service polls the routers themselves:
 * every poll reuses MikrotikSyncService (one fresh RouterOS API connection
 * per NAS: `/ppp/active/print` + `/interface/print =stats=`), sums the live
 * per-session byte counters, and derives instantaneous upload/download rates
 * from the delta against the previous poll. Results are held in an in-memory
 * ring buffer (last 60 points) — the same cumulative-counter + delta-recipe
 * the rest of the panel already uses, just at device level and 2-second
 * granularity. Store nothing in the database: this is a live view only.
 *
 * Concurrency & failure safety:
 *  - POLLS ARE COALESCED: at most one device poll per 2000ms across ALL
 *    callers; requests inside the window return the cached view, so N open
 *    dashboards still cost one RouterOS query per 2 seconds.
 *  - A `busy` guard drops an overlapping poll instead of letting calls pile
 *    up on a device that answers slowly.
 *  - A NAS that fails (unreachable / auth) is excluded from that tick's
 *    totals AND its counter baseline is dropped, so a later reconnect can
 *    never fabricate a huge spike from a stale baseline.
 *  - Counter resets (router reboot, sessions re-created) clamp to zero via
 *    Math.max(0, …) — no negative rates.
 *  - The first successful poll only establishes counter baselines; the first
 *    plotted point appears on the NEXT poll. No fake "0" tick is emitted.
 *  - When every router stops answering, the buffer keeps serving what it has
 *    and `staleSec` / `devices` tell the UI it is degraded.
 */
@Injectable()
export class LiveTrafficService {
  private readonly logger = new Logger('LiveTrafficService');
  private readonly POLL_MS = 2000;
  private readonly MAX_POINTS = 60;

  private points: LivePoint[] = [];
  /** nasId → cumulative counters from the last successful poll of that NAS. */
  private baselines = new Map<number, NasCounters>();
  /** Epoch ms at which the current baselines were recorded. */
  private baselineAt = 0;
  private lastPollAt = 0;
  private busy = false;
  private lastOkAt = 0;
  /** nasId → epoch ms of that router's last successful poll (per-tenant staleness). */
  private lastOkByNas = new Map<number, number>();
  private devices: Array<{ nasId: number; ip: string; ok: boolean; error?: string }> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikSyncService,
  ) {}

  /**
   * Read the live view; triggers a device poll only when one is due.
   *
   * `nasIds` narrows the view to those routers — a tenant's own, from
   * TelemetryService.visibleNasIds(): their points are summed from those
   * routers only and the device list shows only them. Null/omitted is the
   * whole-installation meter (platform owner). The poll itself stays global
   * and coalesced either way, so a tenant's dashboard costs no extra router
   * traffic.
   */
  async snapshot(nasIds?: number[] | null) {
    const now = Date.now();
    if (now - this.lastPollAt >= this.POLL_MS && !this.busy) {
      this.busy = true;
      // Recorded up front: it was never set, so the 2-second coalescing never
      // happened and every open dashboard polled every router on every tick.
      this.lastPollAt = now;
      try {
        await this.collect(now);
      } catch (e: any) {
        this.logger.warn(`live poll failed: ${e?.message || e}`);
      } finally {
        this.busy = false;
      }
    }
    return this.view(now, nasIds);
  }

  /** Poll every API-enabled NAS in parallel, then fold the rates into the ring. */
  private async collect(now: number) {
    const nases = await this.prisma.nas.findMany({
      where: { isActive: true, apiEnabled: true },
      select: { id: true, nasIp: true, apiPort: true, apiUsername: true, apiPassword: true },
    });
    // A NAS without usable API credentials cannot be polled live — skip it.
    const creds: LiveNas[] = nases.filter(
      (n): n is LiveNas => Boolean(n.apiUsername && n.apiPassword && n.nasIp && n.apiPort),
    );

    const results = await Promise.allSettled(
      creds.map((n) => this.pollOne(n.nasIp, n.apiPort, n.apiUsername, n.apiPassword)),
    );

    const devices: Array<{ nasId: number; ip: string; ok: boolean; error?: string }> = [];
    let totalUp = 0;
    let totalDown = 0;
    let producedRate = 0; // nases that contributed a rate this tick
    const byNas = new Map<number, [number, number]>();
    const prevBaselineAt = this.baselineAt;

    for (let i = 0; i < creds.length; i++) {
      const n = creds[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        devices.push({ nasId: n.id, ip: n.nasIp, ok: true });
        const prev = this.baselines.get(n.id);
        if (prev && prevBaselineAt > 0) {
          const secs = (now - prevBaselineAt) / 1000;
          if (secs > 0) {
            const dUp = Math.max(0, r.value.up - prev.up);
            const dDown = Math.max(0, r.value.down - prev.down);
            totalUp += dUp / secs;
            totalDown += dDown / secs;
            byNas.set(n.id, [dUp / secs, dDown / secs]);
            producedRate++;
          }
        }
        this.baselines.set(n.id, r.value);
        this.lastOkByNas.set(n.id, now);
      } else {
        const msg = (r.reason as Error)?.message || 'unreachable';
        devices.push({ nasId: n.id, ip: n.nasIp, ok: false, error: msg.slice(0, 120) });
        // Drop the baseline so the next successful poll starts fresh — a delta
        // across the outage would otherwise report an enormous fake rate.
        this.baselines.delete(n.id);
        this.logger.warn(`live poll NAS ${n.nasIp} failed: ${msg}`);
      }
    }

    this.devices = devices;
    this.baselineAt = now;

    if (devices.some((d) => d.ok)) this.lastOkAt = now;

    // Only publish a point when at least one NAS had a real baseline to
    // delta against. The very first poll of a session is baseline-only.
    if (producedRate > 0) {
      this.points.push({ t: now, upBps: totalUp, downBps: totalDown, byNas });
      if (this.points.length > this.MAX_POINTS) {
        this.points.splice(0, this.points.length - this.MAX_POINTS);
      }
    }
  }

  /** Sum live per-session byte counters on one router (reuses the proven client). */
  private async pollOne(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<NasCounters> {
    const sessions = await this.mikrotik.getActivePppoeUsers(nasIp, apiPort, apiUsername, apiPassword);
    let up = 0;
    let down = 0;
    for (const s of sessions) {
      up += s.uploadBytes ?? 0;
      down += s.downloadBytes ?? 0;
    }
    return { up, down };
  }

  private view(now: number, nasIds?: number[] | null) {
    let points: Array<{ t: number; upBps: number; downBps: number }> = this.points;
    let devices = this.devices;
    let lastOkAt = this.lastOkAt;
    if (Array.isArray(nasIds)) {
      // Same rule as collect(): a point exists only for a tick in which at
      // least one of THESE routers produced a rate. Another company's routers
      // reporting must not draw a zero line on this one's graph.
      const allowed = new Set(nasIds);
      points = [];
      for (const p of this.points) {
        let up = 0;
        let down = 0;
        let hit = false;
        for (const [id, [u, d]] of p.byNas) {
          if (!allowed.has(id)) continue;
          up += u;
          down += d;
          hit = true;
        }
        if (hit) points.push({ t: p.t, upBps: up, downBps: down });
      }
      devices = this.devices.filter((d) => allowed.has(d.nasId));
      lastOkAt = 0;
      for (const id of allowed) lastOkAt = Math.max(lastOkAt, this.lastOkByNas.get(id) ?? 0);
    }
    const okDevices = devices.filter((d) => d.ok).length;
    return {
      points: points.map((p) => ({
        t: new Date(p.t).toISOString(),
        upBps: Math.round(p.upBps),
        downBps: Math.round(p.downBps),
      })),
      sampleMs: this.POLL_MS,
      maxPoints: this.MAX_POINTS,
      lastSampleAt: points.length ? new Date(points[points.length - 1].t).toISOString() : null,
      staleSec: lastOkAt ? Math.round((now - lastOkAt) / 1000) : null,
      devices,
      deviceSummary: `${okDevices}/${devices.length} routers reporting`,
      now: new Date(now).toISOString(),
    };
  }
}