import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { DiagnosticsService } from './diagnostics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * MONITORING — PING, TRACEROUTE, AND PORT/SERVICE CHECKS. NOTHING ELSE.
 *
 * ── What was removed, and why ────────────────────────────────────────────
 * This module used to mount an entire second monitoring product alongside the
 * simple one: `NdmController` plus ten services doing SNMP device polling,
 * interface/port polling, a syslog receiver and parser, an event engine, an
 * alert engine, a notification engine and their retention jobs.
 *
 * The operator's decision was to keep the part that answers the question an
 * ISP actually has — "is this thing reachable, and is the SERVICE on it
 * responding" — and drop the rest. SNMP polling was already disabled by
 * default (`snmpEnabled()`), so what remained was code and UI for a feature
 * nobody was running.
 *
 * It was also expensive. The SNMP poller ran every ten seconds against every
 * device, device-health every thirty, port polling on a five-second timer —
 * and against a seeded sandbox that meant hundreds of UDP probes a minute to
 * addresses that did not exist, each failure writing a CRITICAL alert that
 * buried the real ones.
 *
 * ── What is left ─────────────────────────────────────────────────────────
 *   MonitoringService   ICMP ping with history graph, plus TCP / HTTP / HTTPS
 *                       service checks — because a box can ping perfectly
 *                       while the service on it returns 500, and that is the
 *                       outage a customer feels.
 *   DiagnosticsService  On-demand ping, traceroute, TCP connect and DNS.
 *
 * ── Where the removed code went ──────────────────────────────────────────
 * `_to_delete/removed-snmp-syslog/` in the repository root, not deleted, so
 * the decision is reversible for as long as that folder survives. Nothing
 * imports it.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, DiagnosticsService],
})
export class MonitoringModule {}
