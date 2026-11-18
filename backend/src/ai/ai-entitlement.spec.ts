import { Reflector } from '@nestjs/core';
import { AiController } from './ai.controller';
import { REQUIRED_FEATURE, FeatureGuard } from '../common/feature.guard';
import { invalidateCompanyPlan } from '../common/company-plan';
import { GUARDS_METADATA } from '@nestjs/common/constants';

function make(features: string[]) {
  const prisma: any = { companyPlan: { findUnique: jest.fn(async () => ({ companyId: 10, features })) } };
  const scope: any = { isAdmin: () => false, actorId: (a: any) => a.sub, companyRootId: jest.fn(async () => 10) };
  const ai: any = { configured: true, chat: jest.fn(async () => ({ ok: true, mode: 'local', reply: 'help answer' })) };
  const crm: any = { ask: jest.fn(async (_u: any, q: string) => (/collections/.test(q) ? { ok: true, text: 'Collections: 3 records', tiles: [], records: [] } : null)) };
  const narrator: any = { narrate: jest.fn(async () => null) };
  return { ctl: new AiController(ai, crm, prisma, scope, narrator), ai, crm, narrator };
}
const req = { user: { sub: 11, role: 'ADMIN' } };
const msg = (content: string) => ({ messages: [{ role: 'user', content }] });

beforeEach(() => invalidateCompanyPlan());

describe('AI Assistant entitlement', () => {
  it('status reports whether the company holds the AI Assistant', async () => {
    expect(await make(['ai-assistant']).ctl.status(req)).toEqual({ configured: true, entitled: true });
    invalidateCompanyPlan();
    expect(await make(['crm-advanced']).ctl.status(req)).toEqual({ configured: true, entitled: false });
  });

  it('without the feature, chat never reads CRM data — the help answers are unchanged', async () => {
    const t = make([]);
    const r = await t.ctl.chat(msg('collections today'), req);
    expect(t.crm.ask).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, mode: 'local', reply: 'help answer' });
  });

  it('with the feature, a data question is answered from the database', async () => {
    const t = make(['ai-assistant']);
    const r: any = await t.ctl.chat(msg('collections today'), req);
    expect(r.mode).toBe('data');
    expect(r.reply).toBe('Collections: 3 records');
    expect(t.ai.chat).not.toHaveBeenCalled();
  });

  it('with the model switched on, the reply is worded by it but the figures stay the database\'s', async () => {
    const t = make(['ai-assistant']);
    t.narrator.narrate.mockResolvedValue('Aaj 3 payments aayi hain.');
    const r: any = await t.ctl.chat(msg('collections today'), req);
    expect(r.mode).toBe('data+model');
    expect(r.reply).toBe('Aaj 3 payments aayi hain.');
    expect(r.data.text).toBe('Collections: 3 records');
  });

  it('with the feature, a how-to question still goes to the help', async () => {
    const t = make(['ai-assistant']);
    const r: any = await t.ctl.chat(msg('how do I add a router'), req);
    expect(r.mode).toBe('local');
  });

  it('/ai/ask is guarded server-side by FeatureGuard(ai-assistant)', () => {
    const handler = AiController.prototype.ask;
    expect(new Reflector().get(REQUIRED_FEATURE, handler)).toBe('ai-assistant');
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as any[];
    expect(guards).toContain(FeatureGuard);
  });
});
