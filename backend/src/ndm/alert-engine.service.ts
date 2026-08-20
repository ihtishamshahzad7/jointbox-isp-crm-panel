import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../common/events.service';
import { NdmNotificationEngine } from './notification-engine.service';
import { parseCondition, EVENT_LABELS, eventOpenSound, isRecoveryEventType, type NdmEventType } from './ndm.constants';

/**
 * Alert engine — evaluates AlertRules against recorded events and owns the
 * OPEN → RESOLVED lifecycle of Alert rows.
 *
 * The "no duplicate alerts" property comes from alert keys. Events that are
 * really one incident share a key no matter which source raised them:
 *   - PORT_DOWN / LINK_DOWN / LINK_FLAP / PORT_ERROR on the same port
 *   - BGP_DOWN / OSPF_DOWN on the same neighbor view (device)
 *   - CPU_HIGH / MEMORY_HIGH / SYSLOG_STOPPED / DEVICE_DOWN per device
 * A repeated occurrence increments fireCount (visible in the UI) but never
 * opens a second open alert for the same key.
 *
 * RECOVERY EVENTS (PORT_UP/LINK_UP/DEVICE_UP/…) never open alerts — they
 * only close the open ones (see resolveFamily). This is the Event ≠ Alert
 * distinction the UI depends on: an UP event on a port with an open DOWN
 * alert resolves it (and can chime the recovery sound), it never creates a
 * second incident.
 *
 * With zero configured rules nothing would ever alert, so on first boot the
 * engine seeds a sensible default rule set (PORT_DOWN/UP, DEVICE_DOWN/UP,
 * CPU/MEMORY, syslog-silence) that operators can edit or delete.
 */
@Injectable()
export class NdmAlertEngine implements OnModuleInit {
  private readonly log = new Logger('NdmAlerts');
  private lastEvaluated = new Map<number, string>(); // eventId → dedup token

  constructor(
    private prisma: PrismaService,
    private events: EventsService,
    private notify: NdmNotificationEngine,
  ) {}

  async onModuleInit() {
    await this.seedDefaultRules();
  }

  /**
   * First-boot defaults: only when the rules table is EMPTY, so a configured
   * install is never overwritten. Sound follows the pipeline policy: genuine
   * outages + their recoveries chime; quiet types stay silent by default.
   */
  private async seedDefaultRules() {
    try {
      const n = await this.prisma.alertRule.count();
      if (n > 0) return;
      const defaults: Array<{ name: string; eventType: string; severity: string; channels: any; description?: string }> = [
        { name: 'Port DOWN', eventType: 'PORT_DOWN', severity: 'CRITICAL', channels: { sound: true, desktop: true }, description: 'Auto-seeded default: any monitored port going DOWN is alerted + sounds. Edit or delete freely.' },
        { name: 'Port UP / recovery', eventType: 'PORT_UP', severity: 'INFO', channels: { sound: true, desktop: true }, description: 'Auto-seeded default: chimes when a port comes back UP. Mute per device/port in the port settings.' },
        { name: 'Link DOWN (SNMP)', eventType: 'LINK_DOWN', severity: 'WARNING', channels: { sound: true, desktop: true }, description: 'Auto-seeded default for syslog devices.' },
        { name: 'Link UP (SNMP)', eventType: 'LINK_UP', severity: 'INFO', channels: { sound: true }, description: 'Auto-seeded default: recovery chime for syslog devices.' },
        { name: 'Device DOWN', eventType: 'DEVICE_DOWN', severity: 'CRITICAL', channels: { sound: true, desktop: true }, description: 'Auto-seeded default: SNMP unreachable.' },
        { name: 'Device UP / recovery', eventType: 'DEVICE_UP', severity: 'INFO', channels: { sound: true }, description: 'Auto-seeded default: device responds again.' },
        { name: 'High CPU', eventType: 'CPU_HIGH', severity: 'WARNING', channels: { sound: true, desktop: true }, description: 'Auto-seeded default.' },
        { name: 'High memory', eventType: 'MEMORY_HIGH', severity: 'WARNING', channels: { sound: true, desktop: true }, description: 'Auto-seeded default.' },
        { name: 'Syslog silent', eventType: 'SYSLOG_STOPPED', severity: 'WARNING', channels: { sound: false, desktop: true }, description: 'Auto-seeded default: no syslog for the configured window. Sound left off on purpose.' },
        { name: 'Any syslog', eventType: 'SYSLOG', severity: 'INFO', channels: { sound: false }, description: 'Auto-seeded default: records every syslog line; audit only, no beeps.' },
      ];
      await this.prisma.alertRule.createMany({ data: defaults.map((d) => ({ ...d, condition: null })) });
      this.log.log(`[ALERT] Seeded ${defaults.length} default alert rules (first boot)`);
    } catch (e: any) {
      this.log.warn(`[ALERT] Default rule seeding skipped: ${e?.message || e}`);
    }
  }

  // ── Event → alert family mapping ───────────────────────────────
  private static readonly FAMILY: Record<string, string> = {
    PORT_DOWN: 'PORT', LINK_DOWN: 'PORT', LINK_UP: 'PORT', LINK_FLAP: 'PORT', PORT_ERROR: 'PORT',
    PORT_UP: 'PORT',
    BGP_DOWN: 'NEIGHBOR', BGP_UP: 'NEIGHBOR', OSPF_DOWN: 'NEIGHBOR', OSPF_UP: 'NEIGHBOR',
    CPU_HIGH: 'RESOURCE', MEMORY_HIGH: 'RESOURCE',
    DEVICE_DOWN: 'DEVICE', DEVICE_UP: 'DEVICE', DEVICE_REBOOT: 'DEVICE',
    POWER_FAILURE: 'DEVICE', SYSLOG_STOPPED: 'DEVICE',
    AUTH_FAILURE: 'SECURITY', CONFIG_CHANGE: 'SECURITY',
    SYSLOG: 'SYSLOG',
  };
  private familyOf(t: string): string {
    return NdmAlertEngine.FAMILY[t] || 'SYSLOG';
  }

  /** Closed-loop family — recovery event types that close a family. */

  /**
   * Evaluate an event against the enabled rules. Returns the affected Alert
   * (or null if no rule matched / already resolved / rate-limited).
   */
  async evaluate(input: {
    eventId: number;
    eventType: NdmEventType;
    message: string;
    severity: string;
    count?: number;
    device?: { id: number; name: string; ownerId?: number | null } | null;
    interface?: { id: number; name: string } | null;
  }) {
    const { eventId, eventType, message, severity, device, interface: intf } = input;
    const count = input.count || 1;
    const family = this.familyOf(eventType);

    // Recovery events never open incidents — they are handled by onRecovery()
    // (resolve + recovery notification + recovery chime). Evaluating PORT_UP
    // against a PORT_DOWN rule here would bump the still-open DOWN alert and
    // re-sound it on the very poll the port came back.
    if (isRecoveryEventType(eventType)) return null;

    // Rules that could fire for this event: exact eventType match (so a
    // LINK_DOWN-only rule works) OR a rule on the family head (PORT_DOWN
    // rules catch LINK_DOWN/FLAP/PORT_ERROR too) OR a SYSLOG catch-all.
    const ruleTypes = [eventType, family === 'SYSLOG' ? 'SYSLOG' : this.head(family)];
    const rules = await this.prisma.alertRule.findMany({
      where: { enabled: true, eventType: { in: ruleTypes } },
    });
    if (!rules.length) return null;

    for (const rule of rules) {
      // Rate-limit: one evaluate per event id per rule.
      const token = `${eventId}:${rule.id}`;
      if (this.lastEvaluated.get(rule.id) === token) continue;
      this.lastEvaluated.set(rule.id, token);

      const cond = parseCondition(rule.condition);
      if (cond.kind === 'FLAP' && count < cond.count) continue;

      const key = `${family}:${rule.id}:${device?.id ?? 0}:${intf?.id ?? 0}`;
      const existing = await this.prisma.alert.findFirst({ where: { key, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
      const now = new Date();

      let alert;
      if (existing) {
        const du = cond.kind === 'DURATION' ? cond.seconds : 0;
        const fireCount = existing.fireCount;
        const sustained = du > 0 && now.getTime() - existing.openedAt.getTime() >= du * fireCount;
        if (!sustained || cond.kind !== 'DURATION') {
          // Repeated occurrence → bump live counters, no new alert row.
          alert = await this.prisma.alert.update({
            where: { id: existing.id },
            data: {
              message, fireCount: { increment: 1 },
              title: this.title(rule.name, eventType, intf?.name || null),
            },
            include: { rule: true },
          });
          this.broadcast(alert, 'upgrade', await this.soundFlag(rule, device?.id, intf?.id, eventType));
          continue;
        }
        // DURATION rule and threshold crossed → re-fire (escalate).
        alert = await this.prisma.alert.update({
          where: { id: existing.id },
          data: { fireCount: { increment: 1 }, message },
          include: { rule: true },
        });
        this.broadcast(alert, 'upgrade', await this.soundFlag(rule, device?.id, intf?.id, eventType));
        continue;
      }

      // Fresh incident → open the alert.
      const sev = cond.kind === 'FLAP' && count >= cond.count ? 'CRITICAL' : (rule.severity || 'WARNING');
      alert = await this.prisma.alert.create({
        data: {
          ruleId: rule.id,
          deviceId: device?.id ?? null,
          interfaceId: intf?.id ?? null,
          interfaceName: intf?.name ?? null,
          eventType,
          title: this.title(rule.name, eventType, intf?.name || null),
          message,
          severity: sev,
          key,
          status: 'OPEN',
          fireCount: 1,
        },
        include: { rule: true },
      });
      // Deliver the incident NOW: channels from the rule, sound per the
      // hierarchy (rule → event type → device → port). This was the missing half
      // of the alert pipeline — before, a fresh alert only wrote a row.
      const snd = await this.soundAllowed(rule, device?.id, intf?.id, eventType);
      const channels = { ...((rule.channels as any) || {}), sound: snd.sound };
      await this.notify.notify({
        alertId: alert.id,
        title: alert.title,
        message: `${message}${intf?.name ? ` (${intf.name})` : ''}`,
        severity: sev,
        channels,
        ownerId: device?.ownerId ?? null,
        deviceName: snd.deviceName || device?.name || null,
        event: 'OPEN',
      });
      this.broadcast(alert, 'open', { sound: snd.sound, deviceName: snd.deviceName || device?.name || null, ruleId: rule.id });
    }
    return null;
  }

  /** Resolve OPEN/ACKNOWLEDGED alerts for a family on a device/port. */
  async resolveFamily(input: { deviceId?: number | null; interfaceId?: number | null; family: string; deviceName?: string; recoveryType?: NdmEventType | null }) {
    const { family, deviceId, interfaceId, deviceName, recoveryType } = input;
    const where: any = {
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      key: { startsWith: `${family}:` },
      ...(deviceId != null ? { deviceId } : {}),
      ...(interfaceId != null ? { interfaceId } : {}),
    };
    const rows = await this.prisma.alert.findMany({ where, include: { rule: true } });
    if (!rows.length) return;
    await this.prisma.alert.updateMany({ where, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    // Recovery chime: explicit channels.sound on any rule targeting the RECOVERY
    // event (e.g. the seeded "Port UP / recovery" rule) → else the resolving
    // alert's own rule explicit sound. Never a severity default. Then the
    // independent `soundUpEnabled` device/port gate (UP-sound ≠ DOWN-sound).
    let recoverySound = false;
    if (recoveryType) {
      const recRules = await this.prisma.alertRule.findMany({ where: { enabled: true, eventType: recoveryType } });
      recoverySound = recRules.some((r: any) => (r.channels as any)?.sound === true);
    }
    if (recoverySound) {
      const [dRec, iRec] = await Promise.all([
        deviceId != null ? this.prisma.networkDevice.findUnique({ where: { id: deviceId }, select: { soundUpEnabled: true } }) : Promise.resolve(null),
        interfaceId != null ? this.prisma.networkInterface.findUnique({ where: { id: interfaceId }, select: { soundUpEnabled: true } }) : Promise.resolve(null),
      ]);
      if (dRec && dRec.soundUpEnabled === false) recoverySound = false;
      if (iRec && iRec.soundUpEnabled === false) recoverySound = false;
    }
    for (const a of rows) {
      const resolved = { ...a, status: 'RESOLVED', resolvedAt: new Date() };
      const rule = a.rule as any;
      const ch = (rule?.channels as any) || {};
      const snd = await this.soundAllowed(rule, a.deviceId, a.interfaceId, recoveryType ?? a.eventType, recoverySound);
      // Recovery notifications still fire (the resolving rule decides desktop/
      // mail via its own channels) — only the SOUND follows the recovery
      // chime decision. Event status ≠ alert status: the resolve broadcast
      // always goes out so the dashboard swaps 🔴 → 🟢 even when audio is off.
      const channels = { ...ch, sound: snd.sound };
      if (rule?.enabled !== false) {
        await this.notify.notify({
          alertId: a.id,
          title: `✅ Resolved: ${a.title}`,
          message: `${deviceName || 'Device'}${a.interfaceName ? ` (${a.interfaceName})` : ''} recovered.`,
          severity: a.severity,
          channels,
          ownerId: null,
          deviceName: snd.deviceName || deviceName || null,
          event: 'RESOLVE',
        });
      }
      this.broadcast(resolved, 'resolve', { sound: snd.sound, deviceName: snd.deviceName || deviceName || null, ruleId: rule?.id ?? null });
    }
    if (deviceName && rows.length) this.log.log(`[ALERT] Resolved ${rows.length} ${family} alert(s) on ${deviceName}${recoverySound ? ' · recovery chime ON' : ''}`);
  }

  /** Called by the poller/syslog receiver when a recovery event was recorded. */
  async onRecovery(input: {
    eventType: NdmEventType;
    deviceId?: number | null;
    interfaceId?: number | null;
    deviceName?: string;
  }) {
    // PORT_UP / LINK_UP / BGP_UP etc. close their family.
    const family = this.familyOf(input.eventType);
    if (family === 'SYSLOG') return;
    await this.resolveFamily({
      deviceId: input.deviceId,
      interfaceId: input.interfaceId,
      family,
      deviceName: input.deviceName,
      recoveryType: input.eventType,
    });
  }

  /** Acknowledge an open alert (marks it, leaves it open — stops re-fire noise). */
  async acknowledge(alertId: number, byUserId: number) {
    const alert = await this.prisma.alert.findFirst({ where: { id: alertId } });
    if (!alert) throw new Error('Alert not found');
    const ack = await this.prisma.alert.update({
      where: { id: alertId },
      data: { acknowledgedAt: new Date(), acknowledgedBy: byUserId },
    });
    this.broadcast(ack, 'ack');
    return ack;
  }

  private head(family: string): string {
    for (const [t, f] of Object.entries(NdmAlertEngine.FAMILY)) if (f === family) return t;
    return 'SYSLOG';
  }

  private title(ruleName: string, eventType: NdmEventType, port: string | null): string {
    const label = EVENT_LABELS[eventType] || eventType;
    return port ? `${label} — ${port}` : label;
  }

  private broadcast(alert: any, action: string, extra: Record<string, any> = {}) {
    try {
      // Include recovery-family info so the frontend can decorate resolve rows,
      // plus the sound decision + device name so the frontend audio engine
      // never has to re-derive the hierarchy (rule → severity → device → port).
      const row = {
        id: alert.id,
        status: alert.status,
        action,
        eventType: alert.eventType,
        title: alert.title,
        message: alert.message,
        severity: alert.severity,
        key: alert.key,
        fireCount: alert.fireCount,
        deviceId: alert.deviceId ?? null,
        deviceName: extra.deviceName ?? null,
        interfaceId: alert.interfaceId ?? null,
        interfaceName: alert.interfaceName ?? null,
        ruleId: extra.ruleId ?? alert.ruleId ?? null,
        sound: !!extra.sound,
        openedAt: alert.openedAt || new Date().toISOString(),
        resolvedAt: alert.resolvedAt || null,
      };
      this.events.broadcast('ndm:alert', row);
    } catch { /* never break the pipeline */ }
  }

  /**
   * Sound hierarchy: rule channels.sound → EVENT TYPE default (open events
   * from eventOpenSound) → device.soundEnabled → interface.soundEnabled.
   * RECOVERY paths pass a boolean (recovery chime decided in resolveFamily )
   * and skip the DOWN-gates — the dedicated soundUpEnabled gates were already
   * applied; recovery sound is explicit-only, never automatic.
   */
  private async soundAllowed(rule: any, deviceId: number | null | undefined, interfaceId: number | null | undefined, eventType: string | null, explicit?: boolean): Promise<{ sound: boolean; deviceName: string | null }> {
    const ch = (rule?.channels as any) || {};
    let want = typeof explicit === 'boolean'
      ? explicit
      : (typeof ch.sound === 'boolean' ? ch.sound : eventOpenSound(eventType));
    let deviceName: string | null = null;
    if (want && !isRecoveryEventType(eventType)) {
      const [d, i] = await Promise.all([
        deviceId != null ? this.prisma.networkDevice.findUnique({ where: { id: deviceId }, select: { soundEnabled: true, name: true } }) : Promise.resolve(null),
        interfaceId != null ? this.prisma.networkInterface.findUnique({ where: { id: interfaceId }, select: { soundEnabled: true } }) : Promise.resolve(null),
      ]);
      if (d) { deviceName = d.name || null; if (d.soundEnabled === false) want = false; }
      if (i && i.soundEnabled === false) want = false;
    }
    return { sound: want, deviceName };
  }

  /** Same helper minus the device-name payload (repeat/resolve broadcasts). */
  private async soundFlag(rule: any, deviceId: number | null | undefined, interfaceId: number | null | undefined, eventType: string | null) {
    return this.soundAllowed(rule, deviceId, interfaceId, eventType);
  }
}