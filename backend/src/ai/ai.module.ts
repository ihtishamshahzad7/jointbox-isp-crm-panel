import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiAgentController } from './ai-agent.controller';
import { AiAgentService } from './ai-agent.service';
import { AiAgentQueryService } from './ai-agent-query.service';

@Module({
  controllers: [AiController, AiAgentController],
  providers: [AiService, AiAgentService, AiAgentQueryService],
})
export class AiModule {}
