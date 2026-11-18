import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CrmReportsService } from './crm-reports.service';

const ACTOR = { sub: 10, role: 'ADMIN' } as any;

function make(o: { deny?: string[]; ids?: number[] | null } = {}) {
  const calls: Array<{ text: string; values: any[] }> = [];
  const prisma: any = {
    $queryRaw: jest.fn(async (strings: string[], ...values: any[]) => { calls.push({ text: strings.join('?'), values }); return []; }),
  };
  const scope: any = { visibleUserIds: jest.fn(async () => (o.ids === undefined ? [10, 11] : o.ids)) };
  const perms: any = {
    canActivate: jest.fn(async (ctx: any) => {
      const r = ctx.switchToHttp().getRequest();
      if (o.deny?.includes(r.url.slice(1))) throw new ForbiddenException('no');
      return true;
    }),
  };
  return { svc: new CrmReportsService(prisma, scope, perms), calls, perms };
}

describe('CRM reports', () => {
  it('every report is narrowed to the caller\'s accounts, passed as ONE array parameter (never spliced into SQL)', async () => {
    const t = make();
    for (const name of t.svc.list()) await t.svc.run(ACTOR, name, { from: '2026-11-01', to: '2026-11-30' });
    expect(t.calls.length).toBeGreaterThanOrEqual(8);
    for (const c of t.calls) {
      expect(c.text).toMatch(/IS NULL OR [a-z]\."(userId|ownerId)" = ANY\(\?::int\[\]\)/);
      expect(c.values).toContainEqual([10, 11]);
      expect(c.text).not.toMatch(/10, 11/);
    }
  });
  it('each report needs read access to its own screen', async () => {
    const t = make({ deny: ['payments'] });
    await expect(t.svc.run(ACTOR, 'staff-collection', {})).rejects.toBeInstanceOf(ForbiddenException);
    await t.svc.run(ACTOR, 'tat-compliance', {}); // tickets still allowed
  });
  it('unknown report names and bad periods are refused', async () => {
    const { svc } = make();
    await expect(svc.run(ACTOR, 'drop-tables', {})).rejects.toThrow('Unknown report');
    await expect(svc.run(ACTOR, 'transactions', { from: '2026-13-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.run(ACTOR, 'transactions', { from: '2026-11-05', to: '2026-11-01' })).rejects.toThrow('after the start');
    await expect(svc.run(ACTOR, 'transactions', { from: '2025-01-01', to: '2026-06-01' })).rejects.toThrow('366');
  });
  it('days are company days: 1–30 Nov in Karachi starts 31 Oct 19:00 UTC', async () => {
    const t = make();
    const r = await t.svc.run(ACTOR, 'transactions', { from: '2026-11-01', to: '2026-11-30' });
    expect(r).toMatchObject({ from: '2026-11-01', to: '2026-11-30', timeZone: 'Asia/Karachi' });
    expect((t.calls[0].values[0] as Date).toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect((t.calls[0].values[1] as Date).toISOString()).toBe('2026-11-30T19:00:00.000Z');
  });
});
