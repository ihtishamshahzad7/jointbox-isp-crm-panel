import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NasModule } from '../nas/nas.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { NasMonitorService } from './nas-monitor.service';
import { DeviceHealthService } from './device-health.service';
import { LiveTrafficService } from './live-traffic.service';

/**
 * Real-time traffic and NAS health.
 *
 * The SNMP poller and the syslog receiver were removed with the rest of the
 * SNMP/syslog feature set. Two of the aggregator's three feeds went with them,
 * so the live feed is now driven by the MikroTik API collector alone and will
 * be quieter than it was — it is not broken, it simply has fewer sources.
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
    LiveTrafficService,
  ],
  exports: [
    TelemetryService,
    LinkAggregatorService,
    NasMonitorService,
    DeviceHealthService,
    LiveTrafficService,
  ],
})
export class TelemetryModule {}
