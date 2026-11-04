import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, type Actor } from '../common/scope.service';
import { ProductEntitlementService } from '../common/product-entitlement.service';
import {
  AiAgentQueryService,
  type AiAgentSummary,
} from './ai-agent-query.service';
import { parseAiQuestion } from './ai-agent-query';

const MONTH_START = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

type UsageReservation = {
  id: bigint;
  companyId: number;
  userId: number | null;
  reservedTokens: number;
  providerConfigured: boolean;
  model: string | null;
};

@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly entitlements: ProductEntitlementService,
    private readonly queries: AiAgentQueryService,
  ) {}

  private providerConfig() {
    const baseUrl =
      process.env.AI_AGENT_BASE_URL?.trim().replace(/\/+$/, '') || '';
    const model = process.env.AI_AGENT_MODEL?.trim() || '';
    const apiKey = process.env.AI_AGENT_API_KEY?.trim() || '';
    if (!baseUrl || !model || (!apiKey && !baseUrl.includes('11434')))
      return null;
    let url: URL;
    try {
      url = new URL(`${baseUrl}/chat/completions`);
    } catch {
      throw new Error('AI_AGENT_BASE_URL must be an absolute URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('AI_AGENT_BASE_URL must use HTTP or HTTPS.');
    }
    return {
      endpoint: url.toString(),
      model,
      apiKey,
    };
  }

  async status(actor: Actor) {
    const state = await this.entitlements.companyState(actor, 'ai-assistant');
    if (!state) {
      return {
        active: false,
        roleEnabled: false,
        role: actor?.role ?? '',
        providerConfigured: false,
        plan: null,
        usage: {
          requests: 0,
          tokens: 0,
          estimatedRequests: 0,
          providerCost: null,
          periodStart: MONTH_START(new Date()),
        },
      };
    }
    const start = MONTH_START(new Date());
    const [plan, aggregate, estimatedRequests] = await Promise.all([
      state.planId == null
        ? Promise.resolve(null)
        : this.prisma.platformPlan.findUnique({
            where: { id: state.planId },
            select: { name: true, price: true, currency: true },
          }),
      this.prisma.aiAgentUsage.aggregate({
        where: { companyId: state.companyId, createdAt: { gte: start } },
        _count: { _all: true },
        _sum: { reservedTokens: true, providerCost: true },
      }),
      this.prisma.aiAgentUsage.count({
        where: {
          companyId: state.companyId,
          createdAt: { gte: start },
          tokensEstimated: true,
        },
      }),
    ]);
    let providerConfigured = false;
    try {
      providerConfigured = this.providerConfig() !== null;
    } catch (error) {
      this.logger.error('AI provider configuration is invalid.');
      throw error;
    }
    return {
      active: state.enabled,
      roleEnabled: state.enabled,
      role: actor?.role ?? '',
      providerConfigured,
      plan: plan
        ? {
            name: plan.name,
            monthlyPrice: Number(plan.price),
            currency: plan.currency,
            monthlyRequestLimit: state.aiAssistantMonthlyRequestLimit,
            monthlyTokenLimit: state.aiAssistantMonthlyTokenLimit,
          }
        : state.planId == null
          ? null
          : {
              name: 'Assigned plan',
              monthlyPrice: 0,
              currency: 'PKR',
              monthlyRequestLimit: state.aiAssistantMonthlyRequestLimit,
              monthlyTokenLimit: state.aiAssistantMonthlyTokenLimit,
            },
      usage: {
        requests: aggregate._count._all,
        tokens: aggregate._sum.reservedTokens ?? 0,
        estimatedRequests,
        providerCost:
          aggregate._sum.providerCost == null
            ? null
            : Number(aggregate._sum.providerCost),
        periodStart: start,
      },
    };
  }

  private estimateTokens(
    topics: string[],
    providerConfigured: boolean,
  ): number {
    if (!providerConfigured) return 0;
    return Math.min(
      20_000,
      Math.ceil((JSON.stringify(topics).length + 1200) / 3) + 512,
    );
  }

  private async reserve(
    actor: Actor,
    topics: string[],
    now: Date,
  ): Promise<UsageReservation> {
    const state = await this.entitlements.assertEnabled(actor, 'ai-assistant');
    const config = this.providerConfig();
    const providerConfigured = config !== null;
    const reservedTokens = this.estimateTokens(topics, providerConfigured);
    const userId = actor ? this.scope.actorId(actor) : null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "companyId" FROM "company_plan"
        WHERE "companyId" = ${state.companyId}
        FOR UPDATE`;
      const globalFeature = await tx.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT "enabled" FROM "product_feature"
        WHERE "key" = 'ai-assistant' AND "enabled" = true
        FOR SHARE`;
      if (!globalFeature.length) {
        throw new ForbiddenException(
          'The AI Assistant platform switch is disabled.',
        );
      }
      const current = await tx.companyPlan.findUnique({
        where: { companyId: state.companyId },
        select: {
          features: true,
          expiresAt: true,
          aiAssistantMonthlyRequestLimit: true,
          aiAssistantMonthlyTokenLimit: true,
        },
      });
      if (
        !current?.features.includes('ai-assistant') ||
        (current.expiresAt != null &&
          current.expiresAt.getTime() < now.getTime())
      ) {
        throw new ForbiddenException(
          'The AI Assistant entitlement changed before the request could start.',
        );
      }
      const periodStart = MONTH_START(now);
      const usage = await tx.aiAgentUsage.aggregate({
        where: { companyId: state.companyId, createdAt: { gte: periodStart } },
        _count: { _all: true },
        _sum: { reservedTokens: true },
      });
      if (
        current.aiAssistantMonthlyRequestLimit != null &&
        usage._count._all >= current.aiAssistantMonthlyRequestLimit
      ) {
        throw new HttpException(
          'The company has reached its AI Assistant monthly request limit.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (
        current.aiAssistantMonthlyTokenLimit != null &&
        (usage._sum.reservedTokens ?? 0) + reservedTokens >
          current.aiAssistantMonthlyTokenLimit
      ) {
        throw new HttpException(
          'The company has reached its AI Assistant monthly token limit.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const row = await tx.aiAgentUsage.create({
        data: {
          companyId: state.companyId,
          userId,
          category: topics.join(',').slice(0, 40) || 'overview',
          provider: providerConfigured ? 'openai-compatible' : null,
          model: config?.model ?? null,
          reservedTokens,
          tokensEstimated: providerConfigured,
          status: 'PENDING',
        },
        select: { id: true },
      });
      return {
        id: row.id,
        companyId: state.companyId,
        userId,
        reservedTokens,
        providerConfigured,
        model: config?.model ?? null,
      };
    });
  }

  private async providerInsight(
    config: NonNullable<ReturnType<AiAgentService['providerConfig']>>,
    summary: AiAgentSummary,
  ): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  } | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: config.model,
        max_tokens: 512,
        messages: [
          {
            role: 'system',
            content:
              'Explain only what these authoritative aggregate values show. Do not invent totals, facts, names, or recommendations. The metrics are the source of truth.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              period: summary.window.label,
              metrics: summary.metrics,
              visuals: summary.visuals,
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      this.logger.error(`AI provider returned HTTP ${response.status}.`);
      return null;
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      this.logger.error('AI provider response did not contain a message.');
      return null;
    }
    return {
      content: content.slice(0, 3000),
      inputTokens: Math.max(0, Number(body.usage?.prompt_tokens) || 0),
      outputTokens: Math.max(0, Number(body.usage?.completion_tokens) || 0),
    };
  }

  private deterministicReply(summary: {
    window: { label: string };
    metrics: Record<string, unknown>;
    omittedTopics: string[];
    language: 'en' | 'ur' | 'roman-ur';
  }): string {
    const facts = Object.entries(summary.metrics)
      .map(([topic, value]) => `${topic}: ${JSON.stringify(value)}`)
      .join('\n');
    const accessNote = summary.omittedTopics.length
      ? `\nNot included because access or the required product entitlement is unavailable: ${summary.omittedTopics.join(', ')}.`
      : '';
    if (summary.language === 'ur') {
      return `Uplinko کے اجازت یافتہ ریکارڈ کے مطابق (${summary.window.label}):\n${facts}${accessNote}`;
    }
    if (summary.language === 'roman-ur') {
      return `Uplinko ke authorized records ke mutabiq (${summary.window.label}):\n${facts}${accessNote}`;
    }
    return `Uplinko's permitted records for ${summary.window.label}:\n${facts}${accessNote}`;
  }

  async chat(actor: Actor, rawQuestion: unknown) {
    if (typeof rawQuestion !== 'string') {
      throw new BadRequestException('Question must be text.');
    }
    const question = rawQuestion.trim();
    if (!question || question.length > 500) {
      throw new BadRequestException(
        'Question must contain 1 to 500 characters.',
      );
    }
    const now = new Date();
    const questionIntent = parseAiQuestion(question, now);
    if (questionIntent.protectedDetails) {
      throw new ForbiddenException(
        'The AI Agent cannot access payroll, credentials, identity documents, or bank details.',
      );
    }
    const reservation = await this.reserve(actor, questionIntent.topics, now);
    let parsed: AiAgentSummary;
    try {
      parsed = await this.queries.summarize(actor, question, now);
    } catch (error) {
      await this.prisma.aiAgentUsage.update({
        where: { id: reservation.id },
        data: { status: 'FAILED', errorCode: 'QUERY_FAILED' },
      });
      this.logger.error('AI local query failed; request marked failed.', {
        companyId: reservation.companyId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    const reply = this.deterministicReply(parsed);
    let insight: string | null = null;
    let providerFailed = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let finalStatus = 'LOCAL';
    const config = this.providerConfig();

    if (config) {
      try {
        const result = await this.providerInsight(config, parsed);
        if (result) {
          insight = result.content;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          finalStatus = 'COMPLETED';
        } else {
          providerFailed = true;
          finalStatus = 'FAILED';
        }
      } catch (error) {
        providerFailed = true;
        finalStatus = 'FAILED';
        this.logger.error(
          'AI provider request failed; returning deterministic local metrics.',
          {
            companyId: reservation.companyId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
        );
      }
    }

    await this.prisma.aiAgentUsage.update({
      where: { id: reservation.id },
      data: {
        inputTokens,
        outputTokens,
        reservedTokens: Math.max(
          reservation.reservedTokens,
          inputTokens + outputTokens,
        ),
        status: finalStatus,
        errorCode: providerFailed ? 'PROVIDER_UNAVAILABLE' : null,
      },
    });
    return {
      reply,
      metrics: parsed.metrics,
      period: parsed.window,
      visuals: parsed.visuals,
      providerInsight: insight,
      providerStatus: config
        ? providerFailed
          ? 'unavailable-local-results'
          : 'completed'
        : 'not-configured-local-results',
    };
  }
}
