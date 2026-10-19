import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventsService } from '../common/events.service';
import { VpnService, VpnType, HealthState } from './vpn.service';

/**
 * Scheduled VPN health supervision.
 *
 * Every few minutes it re-reads the real health of each configured VPN server
 * (via the same truthful probes the GUI uses) and, when a server's state
 * CHANGES, broadcasts a single live event. It does NOT restart daemons or push
 * any config — supervision here is observe-and-notify; recovery is the
 * operator's root-owned installer / systemd, so there is no restart loop to
 * cause. Notifications are de-duplicated (only on transition) and
 * rate-limited (a per-type cooldown) so a flapping link can't spam the feed.
 */
@Injectable()
export class VpnMonitorService {
  private readonly log = new Logger('VpnMonitor');
  private last: Partial<Record<VpnType, HealthState>> = {};
  private lastNotifiedAt: Partial<Record<VpnType, number>> = {};
  private static readonly COOLDOWN_MS = 10 * 60 * 1000; // 10 min per type

  constructor(
    private readonly vpn: VpnService,
    private readonly events: EventsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const cfg = this.vpn.getConfig();
    // Only supervise once the operator has committed to a setup (endpoint set).
    if (!cfg.endpointHost) return;

    const types: VpnType[] = ['wireguard', 'openvpn', 'l2tp'];
    for (const type of types) {
      let state: HealthState;
      let summary: string;
      try {
        const h = await this.vpn.health(type, cfg);
        state = h.state;
        summary = h.summary;
      } catch (e: any) {
        state = 'unknown';
        summary = `health check threw: ${e?.message || e}`;
      }

      // `last` is the last state we actually ANNOUNCED. We compare against it
      // (not against the previous raw observation) so that a change which
      // happens during the cooldown window is still announced once the window
      // passes, instead of being silently swallowed and lost forever.
      const prev = this.last[type];

      // Prime silently on the very first observation of a type.
      if (prev === undefined) {
        this.last[type] = state;
        continue;
      }
      // Nothing to say on an unconfigured server or an unchanged state.
      if (state === 'unconfigured' || prev === state) continue;

      const now = Date.now();
      const since = now - (this.lastNotifiedAt[type] || 0);
      if (since < VpnMonitorService.COOLDOWN_MS) continue; // keep `last` as the
      // last announced state so this transition re-fires after the cooldown.
      this.lastNotifiedAt[type] = now;
      this.last[type] = state;

      const worsened = this.rank(state) > this.rank(prev);
      this.log.warn(`VPN ${type}: ${prev} → ${state} (${summary})`);
      this.events.broadcast('vpn.state', { type, from: prev, to: state, worsened, summary, at: new Date(now).toISOString() });
    }
  }

  /** Higher = worse, for deciding whether a transition is a regression. */
  private rank(s: HealthState): number {
    return { online: 0, starting: 1, degraded: 2, unknown: 3, offline: 4, install_required: 4, unconfigured: 0, error: 5 }[s] ?? 3;
  }
}
