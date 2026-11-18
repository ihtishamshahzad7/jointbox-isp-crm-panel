import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiCrmQueryService, CrmAnswer } from './crm-query/ai-crm-query.service';
import { AiNarratorService } from './crm-query/ai-narrator.service';
import { FeatureGuard, RequireFeature } from '../common/feature.guard';
import { actorHasFeature } from '../common/features';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService } from '../common/scope.service';
import { RateLimitGuard } from '../common/rate-limit.guard';

/** Data questions: 30 a minute per client, cluster-wide when Redis is up. */
const ASK_LIMIT = new RateLimitGuard(30, 60_000);

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly crm: AiCrmQueryService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly narrator: AiNarratorService,
  ) {}

  /** Optional model wording; the figures (tiles) are always the database's. */
  private async word(question: string, answer: CrmAnswer, user: any) {
    const worded = await this.narrator.narrate(question, answer, Number(user?.sub ?? user?.id) || null);
    return worded
      ? { ok: true, mode: 'data+model', reply: worded, data: answer }
      : { ok: true, mode: 'data', reply: answer.text, data: answer };
  }

  /**
   * The help knowledge base, exposed so the in-app Documentation page renders
   * from the SAME source the assistant answers from. One place to update means
   * the docs and the AI can never drift apart.
   */
  @Get('docs')
  docs(@Req() req: any) {
    return this.ai.knowledgeBase();
  }

  /** Guidance for the screen the user is on, e.g. ?route=/nas. */
  @Get('page-help')
  pageHelp(@Req() req: any, @Query('route') route?: string) {
    return this.ai.pageHelp(route);
  }

  /**
   * `entitled` — the company holds the AI Assistant (live CRM answers).
   * Without it the assistant still answers how-to questions from the help.
   */
  @Get('status')
  async status(@Req() req: any) {
    return {
      configured: this.ai.configured,
      entitled: await actorHasFeature(this.prisma, this.scope, req.user, 'ai-assistant'),
    };
  }

  /**
   * The help chat. When the company holds the AI Assistant and the question is
   * about its own data ("collections this month", "aaj ki wasooli"), the answer
   * comes from the database — scoped and permission-checked — instead of the
   * help search. Everyone else gets exactly the help answers they had before.
   */
  @Post('chat')
  async chat(@Body() body: { messages: Array<{ role: string; content: string }>; route?: string }, @Req() req: any) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = [...messages].reverse().find((m) => m?.role === 'user')?.content;
    if (typeof last === 'string' && last.trim() && (await actorHasFeature(this.prisma, this.scope, req.user, 'ai-assistant'))) {
      const answer = await this.crm.ask(req.user, last.slice(0, 500));
      if (answer) return answer.ok ? this.word(last, answer, req.user) : { ok: true, mode: 'data', reply: answer.text, data: answer };
    }
    return this.ai.chat(messages, req.user, body?.route);
  }

  /** A CRM data question, answered from the caller's own records. AI Assistant only. */
  @Post('ask')
  @UseGuards(FeatureGuard, ASK_LIMIT)
  @RequireFeature('ai-assistant')
  async ask(@Body() body: { question?: string }, @Req() req: any) {
    const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : '';
    if (!question) return { ok: false, error: 'Ask a question.', text: 'Ask a question.' };
    const answer = await this.crm.ask(req.user, question);
    if (answer?.ok) {
      const w = await this.word(question, answer, req.user);
      return { ...answer, text: w.reply, mode: w.mode };
    }
    return (
      answer ?? {
        ok: false,
        error: 'not_a_data_question',
        text: 'That is not a question about your records. Try "collections this month", "unpaid invoices" or "open tickets".',
      }
    );
  }
}
