import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /**
   * The help knowledge base, exposed so the in-app Documentation page renders
   * from the SAME source the assistant answers from. One place to update means
   * the docs and the AI can never drift apart.
   */
  @Get('docs')
  docs() {
    return this.ai.knowledgeBase();
  }

  /** Guidance for the screen the user is on, e.g. ?route=/nas. */
  @Get('page-help')
  pageHelp(@Query('route') route?: string) {
    return this.ai.pageHelp(route);
  }

  @Get('status')
  status() {
    return { configured: this.ai.configured };
  }

  @Post('chat')
  chat(@Body() body: { messages: Array<{ role: string; content: string }>; route?: string }, @Req() req: any) {
    return this.ai.chat(body?.messages || [], req.user, body?.route);
  }
}
