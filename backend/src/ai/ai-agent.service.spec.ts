import { ForbiddenException, HttpException } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';

const ACTOR = { sub: 10, role: 'ADMIN' };
const SUMMARY = {
  window: {
    label: 'all time',
    start: null,
    end: new Date('2026-07-14T00:00:00Z'),
  },
  metrics: { subscribers: { total: 4, active: 3 } },
  omittedTopics: [],
  visuals: [],
  language: 'en' as const,
};

function make(
  overrides: {
    enabled?: boolean;
    requests?: number;
    tokens?: number;
    requestLimit?: number | null;
    tokenLimit?: number | null;
  } = {},
) {
  const usageRow = { id: 11n };
  const companyPlan = {
    features: overrides.enabled === false ? [] : ['ai-assistant'],
    expiresAt: null,
    aiAssistantMonthlyRequestLimit: overrides.requestLimit ?? 10,
    aiAssistantMonthlyTokenLimit: overrides.tokenLimit ?? 10000,
  };
  const tx = {
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ companyId: 10, enabled: true }]),
    ),
    companyPlan: { findUnique: jest.fn(() => Promise.resolve(companyPlan)) },
    aiAgentUsage: {
      aggregate: jest.fn(() =>
        Promise.resolve({
          _count: { _all: overrides.requests ?? 0 },
          _sum: { reservedTokens: overrides.tokens ?? 0 },
        }),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve(usageRow);
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) =>
      Promise.resolve(work(tx)),
    ),
    aiAgentUsage: {
      update: jest.fn(
        (args: { where: { id: bigint }; data: Record<string, unknown> }) => {
          void args;
          return Promise.resolve({});
        },
      ),
    },
  };
  const scope = { actorId: jest.fn(() => 10) };
  const entitlements = {
    assertEnabled: jest.fn(() => {
      if (overrides.enabled === false)
        return Promise.reject(new ForbiddenException());
      return Promise.resolve({
        companyId: 10,
        enabled: true,
        aiAssistantMonthlyRequestLimit:
          companyPlan.aiAssistantMonthlyRequestLimit,
        aiAssistantMonthlyTokenLimit: companyPlan.aiAssistantMonthlyTokenLimit,
      });
    }),
  };
  const queries = { summarize: jest.fn(() => Promise.resolve(SUMMARY)) };
  const service = new AiAgentService(
    prisma as never,
    scope as never,
    entitlements as never,
    queries as never,
  );
  return { service, prisma, tx, entitlements, queries, companyPlan };
}

describe('AiAgentService', () => {
  const oldBaseUrl = process.env.AI_AGENT_BASE_URL;
  const oldModel = process.env.AI_AGENT_MODEL;
  const oldApiKey = process.env.AI_AGENT_API_KEY;
  const oldHelpBaseUrl = process.env.AI_BASE_URL;
  const oldHelpModel = process.env.AI_MODEL;
  const oldHelpApiKey = process.env.AI_API_KEY;

  beforeEach(() => {
    delete process.env.AI_AGENT_BASE_URL;
    delete process.env.AI_AGENT_MODEL;
    delete process.env.AI_AGENT_API_KEY;
  });

  afterAll(() => {
    if (oldBaseUrl === undefined) delete process.env.AI_AGENT_BASE_URL;
    else process.env.AI_AGENT_BASE_URL = oldBaseUrl;
    if (oldModel === undefined) delete process.env.AI_AGENT_MODEL;
    else process.env.AI_AGENT_MODEL = oldModel;
    if (oldApiKey === undefined) delete process.env.AI_AGENT_API_KEY;
    else process.env.AI_AGENT_API_KEY = oldApiKey;
    if (oldHelpBaseUrl === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = oldHelpBaseUrl;
    if (oldHelpModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = oldHelpModel;
    if (oldHelpApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = oldHelpApiKey;
  });

  it('returns deterministic, authoritative local metrics and records the request', async () => {
    const { service, prisma, tx } = make();
    const result = await service.chat(ACTOR, 'How many subscribers?');
    expect(result).toMatchObject({
      metrics: SUMMARY.metrics,
      providerInsight: null,
      providerStatus: 'not-configured-local-results',
    });
    expect(result.reply).toContain('"active":3');
    expect(tx.aiAgentUsage.create.mock.calls[0]?.[0].data).toMatchObject({
      companyId: 10,
      userId: 10,
      status: 'PENDING',
      reservedTokens: 0,
    });
    expect(prisma.aiAgentUsage.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 11n },
      data: { status: 'LOCAL' },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not enable the data assistant from the help assistant provider settings', async () => {
    process.env.AI_BASE_URL = 'https://provider.example/v1';
    process.env.AI_MODEL = 'help-model';
    process.env.AI_API_KEY = 'help-key';
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const { service } = make();
      const result = await service.chat(ACTOR, 'How many subscribers?');
      expect(result.providerStatus).toBe('not-configured-local-results');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (oldHelpBaseUrl === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = oldHelpBaseUrl;
      if (oldHelpModel === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = oldHelpModel;
      if (oldHelpApiKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = oldHelpApiKey;
    }
  });

  it('rejects invalid questions and disabled entitlements before querying business data', async () => {
    const { service, queries } = make({ enabled: false });
    await expect(service.chat(ACTOR, '')).rejects.toBeInstanceOf(Error);
    await expect(service.chat(ACTOR, 'A'.repeat(501))).rejects.toBeInstanceOf(
      Error,
    );
    await expect(service.chat(ACTOR, 'question')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(queries.summarize).not.toHaveBeenCalled();
  });

  it('refuses sensitive payroll requests before quota reservation or provider use', async () => {
    const { service, tx, queries } = make();
    await expect(
      service.chat(ACTOR, 'Show employee salaries and bank details'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.aiAgentUsage.create).not.toHaveBeenCalled();
    expect(queries.summarize).not.toHaveBeenCalled();
  });

  it('enforces monthly request and token limits inside the reservation transaction', async () => {
    const requestLimited = make({ requests: 10, requestLimit: 10 });
    await expect(
      requestLimited.service.chat(ACTOR, 'question'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(requestLimited.tx.aiAgentUsage.create).not.toHaveBeenCalled();

    process.env.AI_AGENT_BASE_URL = 'https://provider.example/v1';
    process.env.AI_AGENT_MODEL = 'test-model';
    process.env.AI_AGENT_API_KEY = 'test-key';
    const tokenLimited = make({ tokens: 10000, tokenLimit: 10000 });
    await expect(
      tokenLimited.service.chat(ACTOR, 'question'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(tokenLimited.tx.aiAgentUsage.create).not.toHaveBeenCalled();
  });

  it('returns deterministic metrics and records provider failure instead of hiding it', async () => {
    process.env.AI_AGENT_BASE_URL = 'https://provider.example/v1';
    process.env.AI_AGENT_MODEL = 'test-model';
    process.env.AI_AGENT_API_KEY = 'test-key';
    const { service, prisma } = make();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network unavailable'));
    try {
      const result = await service.chat(ACTOR, 'How many subscribers?');
      expect(result.providerInsight).toBeNull();
      expect(result.providerStatus).toBe('unavailable-local-results');
      expect(result.metrics).toEqual(SUMMARY.metrics);
      expect(prisma.aiAgentUsage.update.mock.calls[0]?.[0].data).toMatchObject({
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends aggregate metrics but never forwards the raw question to the provider', async () => {
    process.env.AI_AGENT_BASE_URL = 'https://provider.example/v1';
    process.env.AI_AGENT_MODEL = 'test-model';
    process.env.AI_AGENT_API_KEY = 'test-key';
    const rawQuestion =
      'Show subscribers; private note: customer support note xyz';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'There are four subscribers.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200 },
      ),
    );
    try {
      const { service } = make();
      const result = await service.chat(ACTOR, rawQuestion);
      expect(result.providerStatus).toBe('completed');
      const requestBody = fetchSpy.mock.calls[0]?.[1]?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected the provider request body to be serialized.');
      }
      const request: unknown = JSON.parse(requestBody);
      if (
        request === null ||
        typeof request !== 'object' ||
        !('messages' in request) ||
        !Array.isArray(request.messages)
      ) {
        throw new Error(
          'Expected provider messages in the serialized request.',
        );
      }
      const userMessage: unknown = request.messages[1];
      if (
        userMessage === null ||
        typeof userMessage !== 'object' ||
        !('content' in userMessage) ||
        typeof userMessage.content !== 'string'
      ) {
        throw new Error('Expected a serialized provider user message.');
      }
      expect(userMessage.content).not.toContain(rawQuestion);
      expect(userMessage.content).toContain('"period":"all time"');
      expect(userMessage.content).toContain(
        '"subscribers":{"total":4,"active":3}',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
