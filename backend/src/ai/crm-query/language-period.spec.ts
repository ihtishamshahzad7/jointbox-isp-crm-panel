import { detectLanguage, normalize } from './language';
import { dayStart, parsePeriod, PeriodError, todayIn } from './period';

const TZ = 'Asia/Karachi'; // UTC+5, no DST
const NOW = new Date('2026-11-02T20:30:00Z'); // 01:30 on 3 Nov in Karachi

describe('language', () => {
  it('detects Urdu script, Roman Urdu and English', () => {
    expect(detectLanguage('آج کی وصولی')).toBe('ur');
    expect(detectLanguage('aaj ki wasooli kitni hui')).toBe('roman');
    expect(detectLanguage('collections today')).toBe('en');
  });
  it('maps Roman Urdu and Urdu onto the English intents', () => {
    expect(normalize('aaj ki wasooli kitni hui')).toMatch(/today.*collections/);
    expect(normalize('pichle mahine ke akhrajat')).toMatch(/last month.*expenses/);
    expect(normalize('اس مہینے کی فروخت')).toMatch(/this month.*sales/);
    expect(normalize('gahak ka baqaya')).toMatch(/customer balance/);
    expect(normalize('کھلی شکایت')).toMatch(/tickets/);
  });
});

describe('period', () => {
  it('"today" is the company\'s calendar day, not the server\'s UTC day', () => {
    expect(todayIn(TZ, NOW)).toBe('2026-11-03');
    const p = parsePeriod('collections today', TZ, NOW)!;
    expect([p.from, p.to]).toEqual(['2026-11-03', '2026-11-03']);
    expect(p.start.toISOString()).toBe('2026-11-02T19:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-11-03T19:00:00.000Z');
  });
  it('yesterday / this month / last month / last N days / month / range', () => {
    const r = (q: string) => { const p = parsePeriod(q, TZ, NOW)!; return [p.from, p.to]; };
    expect(r('yesterday')).toEqual(['2026-11-02', '2026-11-02']);
    expect(r('kal ki wasooli')).toEqual(['2026-11-02', '2026-11-02']);
    expect(r('this month')).toEqual(['2026-11-01', '2026-11-03']);
    expect(r('last month')).toEqual(['2026-10-01', '2026-10-31']);
    expect(r('last 7 days')).toEqual(['2026-10-28', '2026-11-03']);
    expect(r('sales 2026-02')).toEqual(['2026-02-01', '2026-02-28']);
    expect(r('from 2026-01-05 to 2026-01-20')).toEqual(['2026-01-05', '2026-01-20']);
  });
  it('no period → null', () => {
    expect(parsePeriod('open tickets', TZ, NOW)).toBeNull();
  });
  it('refuses reversed, oversized and impossible ranges', () => {
    expect(() => parsePeriod('2026-02-10 to 2026-01-01', TZ, NOW)).toThrow(PeriodError);
    expect(() => parsePeriod('last 400 days', TZ, NOW)).toThrow(PeriodError);
    expect(() => parsePeriod('2025-01-01 to 2026-06-01', TZ, NOW)).toThrow(PeriodError);
    expect(() => parsePeriod('2026-02-30', TZ, NOW)).toThrow(PeriodError);
  });
  it('day boundaries follow DST where the zone has it', () => {
    // London: 29 Mar 2026 begins at 00:00 GMT; 30 Mar begins at 23:00Z on the 29th (BST).
    expect(dayStart('2026-03-29', 'Europe/London').toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(dayStart('2026-03-30', 'Europe/London').toISOString()).toBe('2026-03-29T23:00:00.000Z');
  });
});
