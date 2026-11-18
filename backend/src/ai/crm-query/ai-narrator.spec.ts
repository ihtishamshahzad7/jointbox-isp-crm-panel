import { AiNarratorService } from './ai-narrator.service';
import type { CrmAnswer } from './ai-crm-query.service';

const ANSWER: CrmAnswer = {
  ok: true, section: 'Customers', language: 'roman', period: null, matching: 1,
  tiles: [{ key: 'collected', label: 'Wasool shuda raqam', value: 12000, kind: 'money', currency: 'PKR' }],
  records: Array.from({ length: 30 }, (_, i) => ({ id: i, username: `u${i}`, name: `N${i}`, status: 'ACTIVE' })),
  text: 'plain answer',
};
const ENV = { ...process.env };

function make(redisCount: number | null = 1) {
  const cache: any = { incr: jest.fn(async () => redisCount) };
  return { svc: new AiNarratorService(cache), cache };
}

afterEach(() => { process.env = { ...ENV }; (global as any).fetch = undefined; });

describe('AI-model wording of CRM answers', () => {
  it('is OFF unless a model is configured AND the operator consented to sending CRM data', async () => {
    process.env.AI_BASE_URL = 'https://api.example.com/v1';
    process.env.AI_API_KEY = 'k';
    expect(make().svc.enabled).toBe(false);
    process.env.AI_CRM_DATA_TO_MODEL = 'true';
    expect(make().svc.enabled).toBe(true);
    delete process.env.AI_BASE_URL;
    expect(make().svc.enabled).toBe(false);
  });

  it('sends only the question, section, figures and at most 20 redacted rows; asks store:false; refuses redirects', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'k', AI_CRM_DATA_TO_MODEL: 'true' });
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Aaj 12,000 PKR wasool hue.' } }] }) }));
    (global as any).fetch = fetch;
    const r = await make().svc.narrate('aaj ki wasooli', ANSWER, 50);
    expect(r).toBe('Aaj 12,000 PKR wasool hue.');
    const [, init] = fetch.mock.calls[0] as any;
    const body = JSON.parse(init.body);
    expect(body.store).toBe(false);
    expect(init.redirect).toBe('error');
    const sent = JSON.parse(body.messages[1].content);
    expect(Object.keys(sent).sort()).toEqual(['figures', 'matchingRecords', 'period', 'question', 'rows', 'section']);
    expect(sent.rows).toHaveLength(20);
    expect(body.messages[0].content).toMatch(/Roman Urdu/);
    expect(body.messages[0].content).toMatch(/Never invent/);
  });

  it('never sends refusals, and falls back to the plain answer on any model failure', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'k', AI_CRM_DATA_TO_MODEL: 'true' });
    const fetch = jest.fn(async () => { throw new Error('timeout'); });
    (global as any).fetch = fetch;
    expect(await make().svc.narrate('q', { ...ANSWER, ok: false, error: 'refused' }, 50)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await make().svc.narrate('q', ANSWER, 50)).toBeNull();
  });

  it('10 model calls per user per 15 minutes, then the plain answer', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'k', AI_CRM_DATA_TO_MODEL: 'true' });
    const fetch = jest.fn();
    (global as any).fetch = fetch;
    expect(await make(11).svc.narrate('q', ANSWER, 50)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const local = make(null).svc; // no Redis: per-process count
    for (let i = 0; i < 10; i++) expect(await local.allow(7)).toBe(true);
    expect(await local.allow(7)).toBe(false);
  });
});
