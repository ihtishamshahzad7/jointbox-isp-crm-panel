import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiAgentController } from './ai-agent.controller';
import { AiAgentService } from './ai-agent.service';
import { AiAgentQueryService } from './ai-agent-query.service';

@Module({
  imports: [PrismaModule],
  controllers: [AiController, AiAgentController],
  providers: [AiService, AiAgentService, AiAgentQueryService],
})
export class AiModule {}
