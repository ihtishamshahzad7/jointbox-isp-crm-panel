import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { SnmpPollerService } from './snmp-poller.service';
import { SyslogReceiverService } from './syslog-receiver.service';
import { NasMonitorService } from './nas-monitor.service';

/**
 * Real-time subscriber link tracing. Three optional-per-NAS collectors
 * (MikroTik API — reused from NasModule, SNMP poller, Syslog receiver) all feed
 * one aggregator, which drives the live feed and per-subscriber path.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    LinkAggregatorService,
    SnmpPollerService,
    SyslogReceiverService,
    NasMonitorService,
  ],
  exports: [TelemetryService, LinkAggregatorService, NasMonitorService],
})
export class TelemetryModule {}
