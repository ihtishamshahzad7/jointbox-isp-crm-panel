import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { LinkAggregatorService } from './link-aggregator.service';
import { SnmpPollerService } from './snmp-poller.service';
import { SyslogReceiverService } from './syslog-receiver.service';

/**
 * Real-time subscriber link tracing. Three optional-per-NAS collectors
 * (MikroTik API — reused from NasModule, SNMP poller, Syslog receiver) all feed
 * one aggregator, which drives the live feed and per-subscriber path.
 */
@Module({
  imports: [PrismaModule],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    LinkAggregatorService,
    SnmpPollerService,
    SyslogReceiverService,
  ],
  exports: [TelemetryService, LinkAggregatorService],
})
export class TelemetryModule {}
