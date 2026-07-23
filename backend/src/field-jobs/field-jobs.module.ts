import { Module } from '@nestjs/common';
import { FieldJobsService } from './field-jobs.service';
import { FieldJobsController } from './field-jobs.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  // ScopeService comes from the global CommonModule.
  imports: [PrismaModule],
  controllers: [FieldJobsController],
  providers: [FieldJobsService],
  exports: [FieldJobsService],
})
export class FieldJobsModule {}
