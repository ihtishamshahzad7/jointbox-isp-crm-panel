import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NasModule } from '../nas/nas.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { NasMonitorService } from './nas-monitor.service';
import { DeviceHealthService } from './device-health.service';
import { SnmpMonitorService } from './snmp-monitor.service';
import { LiveTrafficService } from './live-traffic.service';

/**
 * Real-time traffic and NAS health.
 *
 * SnmpMonitorService owns opt-in, per-NAS SNMP scheduling; DeviceHealthService
 * collects one NAS for that worker and also serves the manual health probe.
 * The syslog receiver remains removed, so the live feed has fewer sources.
 *
 * `DeviceHealthService` is deliberately KEPT: it does its own SNMP walk for
 * router CPU, memory, uptime and interface status on the NAS detail page, and
 * never depended on the poller. Traffic sampling in `NasMonitorService` reads
 * `radacct`, not SNMP, so every traffic graph is unaffected.
 */
@Module({
  imports: [PrismaModule, NotificationsModule, NasModule],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    LinkAggregatorService,
    NasMonitorService,
    DeviceHealthService,
    SnmpMonitorService,
    LiveTrafficService,
  ],
  exports: [
    TelemetryService,
    LinkAggregatorService,
    NasMonitorService,
    DeviceHealthService,
    SnmpMonitorService,
    LiveTrafficService,
  ],
})
export class TelemetryModule {}
