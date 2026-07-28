import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status() {
    return { configured: this.ai.configured };
  }

  @Post('chat')
  chat(@Body() body: { messages: Array<{ role: string; content: string }> }, @Req() req: any) {
    return this.ai.chat(body?.messages || [], req.user);
  }
}
