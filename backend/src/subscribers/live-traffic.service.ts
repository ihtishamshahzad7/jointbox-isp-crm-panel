import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';

/**
 * LIVE PER-SUBSCRIBER TRAFFIC
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `radacct` holds ONE ROW PER SESSION, rewritten in place on every interim
 * update. So for a subscriber who is online right now there is exactly one
 * row, and any query over it returns a single point. That is why the old
 * bandwidth chart drew nothing: `getBandwidthHistory` could only ever emit one
 * sample, at 0 bps.
 *
 * A line graph needs a time series, and nothing in this system stored one per
 * subscriber. `NasTrafficSample` is per-NAS; `InterfaceTrafficHistory` is
 * per-port and deliberately excludes PPPoE session interfaces.
 *
 * ── Why sampling is poll-driven, not a cron ──────────────────────────────
 * The obvious design — a background job sampling every online subscriber into
 * a Postgres table — does not survive contact with this product's scale. At
 * 10,000 online subscribers and a 10-second interval that is 86 million rows a
 * day, for data almost nobody looks at.
 *
 * A live graph is only needed while an operator has the page open. So the
 * frontend's own polling IS the sampler: each request takes one reading,
 * appends it to a short ring buffer in Redis, and returns the window. Cost is
 * exactly proportional to people actually watching, there is no new table, no
 * migration, no retention cron, and nothing to run when the panel is idle.
 *
 * ── The correctness rule that matters ────────────────────────────────────
 * Rates are computed between DISTINCT COUNTER READINGS, never between polls.
 * With RADIUS_INTERIM_INTERVAL at 300s, radacct's counters move once every
 * five minutes. Emitting a point per 5-second poll would draw 59 samples at
 * 0 bps followed by one enormous spike — a graph that is not merely useless
 * but actively misleading about when the traffic happened. So a reading is
 * only appended when the counter has genuinely advanced, and the rate divides
 * by the counter's own elapsed time.
 */

export type TrafficSource = 'mikrotik' | 'radius' | 'none';

/** One counter reading. Cumulative byte totals, as the device reports them. */
export interface Reading {
  /** Epoch ms of the reading as the SOURCE dates it, not when we polled. */
  at: number;
  uploadBytes: number;
  downloadBytes: number;
  /** Session identity, so a reconnect is not read as a counter rollback. */
  sessionKey: string;
  source: TrafficSource;
}

/** One plotted point: a rate derived from two consecutive readings. */
export interface RatePoint {
  at: number;
  uploadBps: number;
  downloadBps: number;
  /** Seconds between the two readings this rate came from. */
  spanSeconds: number;
}

export interface LiveTraffic {
  username: string;
  online: boolean;
  source: TrafficSource;
  /** Seconds between readings actually achieved — NOT what we asked for. */
  resolutionSeconds: number | null;
  points: RatePoint[];
  latest: { uploadBps: number; downloadBps: number } | null;
  totals: { uploadBytes: number; downloadBytes: number } | null;
  /** Set when we cannot yet draw a line, with the reason in plain words. */
  notice: string | null;
}

/** 10 minutes of headroom so a 5-minute window survives a slow poller. */
const RING_TTL_SECONDS = 600;
/** Hard cap. At 5s polling this is ~10 minutes; it bounds memory per user. */
const MAX_READINGS = 150;

const keyFor = (username: string) => `livetraffic:${username.toLowerCase()}`;

@Injectable()
export class LiveTrafficService {
  private readonly log = new Logger(LiveTrafficService.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * Take a reading, fold it into the ring, and return the window.
   *
   * `readCounter` is injected by the caller so this service stays free of
   * MikroTik and Postgres specifics — which is also what makes it testable
   * without a router or a database.
   */
  async sample(
    username: string,
    windowSeconds: number,
    readCounter: () => Promise<Reading | null>,
  ): Promise<LiveTraffic> {
    let reading: Reading | null = null;
    try {
      reading = await readCounter();
    } catch (err) {
      this.log.debug(`live traffic read failed for ${username}: ${(err as Error).message}`);
    }

    const ring = await this.loadRing(username);

    if (reading) {
      const merged = appendReading(ring, reading);
      if (merged !== ring) {
        await this.saveRing(username, merged);
      }
      return buildWindow(username, merged, windowSeconds, reading);
    }

    // Offline, or the source could not be reached. Return whatever history we
    // have rather than an empty chart — the operator can still see the last
    // few minutes before the session dropped.
    return buildWindow(username, ring, windowSeconds, null);
  }

  /** Discard a subscriber's buffer, e.g. when their session is closed. */
  async reset(username: string): Promise<void> {
    await this.cache.del(keyFor(username));
  }

  private async loadRing(username: string): Promise<Reading[]> {
    const raw = await this.cache.get<Reading[]>(keyFor(username));
    return Array.isArray(raw) ? raw : [];
  }

  private async saveRing(username: string, ring: Reading[]): Promise<void> {
    await this.cache.set(keyFor(username), ring, RING_TTL_SECONDS);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pure functions — exported so the spec can exercise them directly.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Append a reading, but only when it tells us something new.
 *
 * Returns the SAME array reference when nothing changed, so the caller can
 * skip a pointless Redis write on every poll that landed between two interim
 * updates — which, at a 300s interim and 5s polling, is 59 polls out of 60.
 */
export function appendReading(ring: Reading[], next: Reading): Reading[] {
  const last = ring[ring.length - 1];

  if (last) {
    const sameSession = last.sessionKey === next.sessionKey;
    const counterMoved =
      next.uploadBytes !== last.uploadBytes || next.downloadBytes !== last.downloadBytes;
    const timeMoved = next.at > last.at;

    // Nothing advanced: the source has not refreshed since we last looked.
    // Appending here is what would produce the false "flat then spike" graph.
    if (sameSession && !counterMoved && !timeMoved) return ring;

    // Same reading timestamp but different bytes should not happen; trust the
    // newer byte value and leave the series length alone.
    if (sameSession && !timeMoved) {
      const copy = ring.slice(0, -1);
      copy.push(next);
      return copy;
    }
  }

  const out = ring.concat(next);
  return out.length > MAX_READINGS ? out.slice(out.length - MAX_READINGS) : out;
}

/**
 * Turn readings into rates.
 *
 * Two readings make one point. A session change breaks the chain rather than
 * producing a rate, because the counters restart at zero on reconnect and the
 * naive delta would be a large negative — or, once clamped, a spurious zero
 * that hides the reconnect entirely.
 */
export function toRatePoints(ring: Reading[]): RatePoint[] {
  const out: RatePoint[] = [];

  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];

    if (a.sessionKey !== b.sessionKey) continue; // reconnect — no rate across it

    const spanMs = b.at - a.at;
    if (spanMs <= 0) continue;

    const dUp = b.uploadBytes - a.uploadBytes;
    const dDown = b.downloadBytes - a.downloadBytes;

    // A counter that went backwards inside one session means the device
    // restarted its interface counters. Not a rate; skip the pair.
    if (dUp < 0 || dDown < 0) continue;

    const spanSeconds = spanMs / 1000;
    out.push({
      at: b.at,
      uploadBps: Math.round((dUp * 8) / spanSeconds),
      downloadBps: Math.round((dDown * 8) / spanSeconds),
      spanSeconds: Math.round(spanSeconds * 10) / 10,
    });
  }

  return out;
}

/** Median gap between plotted points — the resolution actually achieved. */
export function achievedResolution(points: RatePoint[]): number | null {
  if (points.length === 0) return null;
  const spans = points.map((p) => p.spanSeconds).sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

export function buildWindow(
  username: string,
  ring: Reading[],
  windowSeconds: number,
  latestReading: Reading | null,
): LiveTraffic {
  const cutoff = Date.now() - windowSeconds * 1000;
  const recent = ring.filter((r) => r.at >= cutoff);

  // Keep one reading from before the window so the first in-window point has
  // something to measure against; otherwise the graph always loses its
  // leading edge.
  const firstIdx = ring.findIndex((r) => r.at >= cutoff);
  const withLead = firstIdx > 0 ? ring.slice(firstIdx - 1) : recent;

  const points = toRatePoints(withLead).filter((p) => p.at >= cutoff);
  const last = points[points.length - 1] ?? null;
  const source: TrafficSource = latestReading?.source ?? ring[ring.length - 1]?.source ?? 'none';

  let notice: string | null = null;
  if (!latestReading) {
    notice = ring.length
      ? 'This subscriber is not online. Showing the last readings before the session ended.'
      : 'This subscriber is not online.';
  } else if (points.length === 0) {
    notice =
      'Collecting — the first rate appears once a second reading arrives. ' +
      (latestReading.source === 'radius'
        ? 'Readings come from RADIUS accounting, which refreshes on the interim-update interval.'
        : 'Readings come from the router, refreshed on each poll.');
  } else if (latestReading.source === 'radius') {
    const res = achievedResolution(points);
    if (res && res > 60) {
      notice =
        `One reading roughly every ${Math.round(res)}s — that is the RADIUS interim-update ` +
        `interval on this NAS, not a limit of the chart. Lower Acct-Interim-Interval for a finer line.`;
    }
  }

  return {
    username,
    online: !!latestReading,
    source,
    resolutionSeconds: achievedResolution(points),
    points,
    latest: last ? { uploadBps: last.uploadBps, downloadBps: last.downloadBps } : null,
    totals: latestReading
      ? { uploadBytes: latestReading.uploadBytes, downloadBytes: latestReading.downloadBytes }
      : null,
    notice,
  };
}
