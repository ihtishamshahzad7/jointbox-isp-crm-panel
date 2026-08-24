import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { DiagnosticsService } from './diagnostics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NdmController } from '../ndm/ndm.controller';
import { NdmService } from '../ndm/ndm.service';
import { NdmSnmpService } from '../ndm/snmp.service';
import { NdmSyslogParserService } from '../ndm/syslog-parser.service';
import { NdmEventEngine } from '../ndm/event-engine.service';
import { NdmAlertEngine } from '../ndm/alert-engine.service';
import { NdmNotificationEngine } from '../ndm/notification-engine.service';
import { NdmPortPollingService } from '../ndm/port-polling.service';
import { NdmSyslogReceiverService } from '../ndm/syslog-receiver.service';
import { NdmRetentionService } from '../ndm/retention.service';
import { NdmSyslogArchiveService } from '../ndm/syslog-archive.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MonitoringController, NdmController],
  providers: [
    MonitoringService,
    DiagnosticsService,
    // ── Network device monitoring (SNMP + syslog) ─────────────
    NdmService,
    NdmSnmpService,
    NdmSyslogParserService,
    NdmEventEngine,
    NdmAlertEngine,
    NdmNotificationEngine,
    NdmPortPollingService,
    NdmSyslogArchiveService,
    NdmSyslogReceiverService,
    NdmRetentionService,
  ],
})
export class MonitoringModule {}