import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../common/events.service';
import {
  EVENT_DEFAULT_SEVERITY, EVENT_LABELS, eventSeverity,
  type NdmEventType,
} from './ndm.constants';

/**
 * Event engine — the single writer of NetworkEvent rows and the owner of the
 * "is this incident already known?" decision.
 *
 * Two views coexist on purpose:
 *  - AGGREGATE events (PORT_DOWN, BGP_DOWN, CPU_HIGH, DEVICE_DOWN …) must not
 *    spam — the same DOWN raised by a poll and by a syslog line increments
 *    `count` on ONE row instead of opening a second one.
 *  - REPEATABLE events (AUTH_FAILURE, CONFIG_CHANGE, plain SYSLOG) are
 *    interesting every time they happen — each gets its own row.
 *
 * Recovery types (PORT_UP, BGP_UP, …) close the open counterpart row, which
 * is what lets the AlertEngine resolve alerts without any extra lookups.
 * Everything is persisted; the in-memory map only saves queries on the hot
 * path and is rebuilt from the DB on boot so restarts never duplicate.
 */
@Injectable()
export class NdmEventEngine implements OnModuleInit {
  private readonly log = new Logger('NdmEvents');

  /** Open aggregate events by dedupKey — rebuilt from DB at startup. */
  private open = new Map<string, { id: number; count: number }>();

  constructor(private prisma: PrismaService, private events: EventsService) {}

  async onModuleInit() {
    try {
      const rows = await this.prisma.networkEvent.findMany({
        where: { status: 'OPEN' },
        select: { id: true, eventType: true, deviceId: true, interfaceId: true, count: true },
      });
      for (const r of rows) {
        this.open.set(this.key(r.eventType as NdmEventType, r.deviceId, r.interfaceId), { id: r.id, count: r.count });
      }
      this.log.log(`Rebuilt ${this.open.size} open events from DB`);
    } catch (e: any) {
      this.log.warn(`Could not rebuild open events (${e?.message}) — starting cold.`);
    }
  }

  /** Which types collapse into one open row per (device, port). */
  private static readonly AGGREGATE = new Set<NdmEventType>([
    'PORT_DOWN', 'LINK_DOWN', 'LINK_FLAP', 'PORT_ERROR', 'BGP_DOWN', 'OSPF_DOWN',
    'STP_CHANGE', 'CPU_HIGH', 'MEMORY_HIGH', 'POWER_FAILURE', 'SYSLOG_STOPPED',
    'DEVICE_DOWN',
  ]);

  /** Recovery event type → the aggregate type(s) it closes. */
  private static readonly RECOVERS: Partial<Record<NdmEventType, NdmEventType[]>> = {
    PORT_UP: ['PORT_DOWN', 'LINK_DOWN', 'LINK_FLAP', 'PORT_ERROR'],
    LINK_UP: ['LINK_DOWN', 'LINK_FLAP', 'PORT_ERROR'],
    BGP_UP: ['BGP_DOWN'],
    OSPF_UP: ['OSPF_DOWN'],
    DEVICE_UP: ['DEVICE_DOWN', 'SYSLOG_STOPPED'],
    DEVICE_REBOOT: [],
    SYSLOG: [],
    STP_CHANGE: [],
  };

  private key(type: NdmEventType, deviceId?: number | null, interfaceId?: number | null) {
    return `${type}|${deviceId ?? 0}|${interfaceId ?? 0}`;
  }

  /**
   * Record an event. Returns the persisted row (count reflects the total
   * occurrences if this was an aggregate duplicate).
   */
  async record(input: {
    eventType: NdmEventType;
    device?: { id: number; name?: string } | null;
    sourceIp?: string | null;
    interface?: { id: number; name: string } | null;
    message: string;
    severity?: string | null;
    source?: 'POLL' | 'SYSLOG' | 'SYSTEM';
  }) {
    const { eventType, device, interface: intf, message, sourceIp } = input;
    let severity = input.severity
      ? eventSeverity(input.severity)
      : (EVENT_DEFAULT_SEVERITY[eventType] || 'info');

    // 1) Recovery first: a PORT_UP closes an open PORT_DOWN before we do
    //    anything else, so the window never shows both as "open" at once.
    const recovers = NdmEventEngine.RECOVERS[eventType] || [];
    for (const t of recovers) {
      await this.resolve({ deviceId: device?.id, interfaceId: intf?.id, types: [t] });
    }

    // 2) Aggregate dedup, or a fresh row.
    let row;
    if (NdmEventEngine.AGGREGATE.has(eventType) && device) {
      const k = this.key(eventType, device.id, intf?.id);
      const existing = this.open.get(k);
      if (existing) {
        row = await this.prisma.networkEvent.update({
          where: { id: existing.id },
          data: { count: { increment: 1 }, message },
        });
        existing.count = row.count;
      } else {
        row = await this.prisma.networkEvent.create({
          data: {
            deviceId: device.id, sourceIp: sourceIp || null,
            interfaceId: intf?.id ?? null, interfaceName: intf?.name ?? null,
            eventType, severity, message, status: 'OPEN', count: 1,
          },
        });
        this.open.set(k, { id: row.id, count: 1 });
      }
    } else {
      row = await this.prisma.networkEvent.create({
        data: {
          deviceId: device?.id ?? null, sourceIp: sourceIp || null,
          interfaceId: intf?.id ?? null, interfaceName: intf?.name ?? null,
          eventType, severity, message, status: 'OPEN', count: 1,
        },
      });
    }

    this.broadcast(row, 'open');
    return row;
  }

  /** Resolve every OPEN event of the given types for a device/port. */
  async resolve(input: { deviceId?: number | null; interfaceId?: number | null; types: NdmEventType[] }) {
    const { deviceId, interfaceId, types } = input;
    const where: any = {
      status: 'OPEN',
      eventType: { in: types },
      ...(deviceId != null ? { deviceId } : {}),
      ...(interfaceId != null ? { interfaceId } : {}),
    };
    const rows = await this.prisma.networkEvent.findMany({ where, select: { id: true } });
    if (!rows.length) return;
    await this.prisma.networkEvent.updateMany({
      where,
      data: { status: 'CLEARED', resolvedAt: new Date() },
    });
    for (const r of rows) {
      for (const [k, v] of this.open) if (v.id === r.id) this.open.delete(k);
    }
    for (const r of rows) this.broadcast({ id: r.id, status: 'CLEARED' }, 'resolve');
  }

  /** Shorthand the poller uses on every cycle: any recovery for this device. */
  async resolveForDevice(deviceId: number, types: NdmEventType[]) {
    return this.resolve({ deviceId, types });
  }

  getOpenCount(): number {
    return this.open.size;
  }

  /** True when a flap rule window (count in `windowSec`) is exceeded. */
  async flapExceeds(eventType: NdmEventType, deviceId: number, interfaceId: number | null | undefined, windowSec: number, threshold: number) {
    const since = new Date(Date.now() - windowSec * 1000);
    const count = await this.prisma.networkEvent.count({
      where: {
        eventType, deviceId,
        ...(interfaceId ? { interfaceId } : {}),
        createdAt: { gte: since },
      },
    });
    return count >= threshold;
  }

  /** Broadcast to the SSE "monitoring" channel — matches the frontend reducer. */
  private broadcast(payload: any, action: string) {
    try {
      this.events.broadcast('ndm:event', {
        action,
        data: {
          id: payload.id,
          eventType: payload.eventType,
          severity: payload.severity || 'info',
          status: payload.status || 'OPEN',
          message: payload.message || '',
          count: payload.count || 1,
          label: payload.eventType ? EVENT_LABELS[payload.eventType] : '',
          deviceId: payload.deviceId ?? null,
          interfaceId: payload.interfaceId ?? null,
          interfaceName: payload.interfaceName ?? null,
          createdAt: payload.createdAt || new Date().toISOString(),
          resolvedAt: payload.resolvedAt || null,
        },
      });
    } catch { /* SSE must never break the pipeline */ }
  }
}