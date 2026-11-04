import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TicketSlaService } from './ticket-sla.service';

@Module({
  imports: [PrismaModule],
  controllers: [TicketsController],
  providers: [TicketsService, TicketSlaService],
  exports: [TicketsService, TicketSlaService],
})
export class TicketsModule {}