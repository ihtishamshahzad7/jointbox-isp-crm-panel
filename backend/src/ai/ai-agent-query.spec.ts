import { parseAiQuestion } from './ai-agent-query';

const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('parseAiQuestion', () => {
  it('recognizes English and Urdu topics and date windows', () => {
    const english = parseAiQuestion(
      'How many active subscribers and tickets in the last 7 days?',
      NOW,
    );
    expect(english.topics).toEqual(['subscribers', 'tickets']);
    expect(english.window.label).toBe('last 7 days');
    expect(english.window.start?.toISOString()).toBe(
      '2026-07-07T19:00:00.000Z',
    );

    const urdu = parseAiQuestion('آج صارفین کی وصولی اور ٹکٹ کتنے ہیں؟', NOW);
    expect(urdu.topics).toEqual(['subscribers', 'collections', 'tickets']);
    expect(urdu.window.label).toBe('today');
  });

  it('recognizes Roman Urdu and calendar month boundaries in Pakistan time', () => {
    const parsed = parseAiQuestion(
      'pichlay 30 din ki payments aur stock batao',
      NOW,
    );
    expect(parsed.topics).toEqual(['collections', 'inventory']);
    expect(parsed.window.start?.toISOString()).toBe('2026-06-14T19:00:00.000Z');

    const lastMonth = parseAiQuestion('collections last month', NOW);
    expect(lastMonth.window.start?.toISOString()).toBe(
      '2026-05-31T19:00:00.000Z',
    );
    expect(lastMonth.window.end.toISOString()).toBe('2026-06-30T19:00:00.000Z');
  });

  it('bounds requested ranges and leaves unrecognized topics empty', () => {
    const parsed = parseAiQuestion('show expenses for last 999 days', NOW);
    expect(parsed.topics).toEqual(['expenses']);
    expect(parsed.window.label).toBe('last 366 days');
    expect(parsed.topics).toEqual(
      parseAiQuestion('show expenses for last 366 days', NOW).topics,
    );
    expect(parseAiQuestion('hello there', NOW).topics).toEqual([]);
  });

  it('supports explicit YYYY-MM and inclusive date ranges with Pakistan boundaries', () => {
    const month = parseAiQuestion('collections for 2026-02', NOW);
    expect(month.window.start?.toISOString()).toBe('2026-01-31T19:00:00.000Z');
    expect(month.window.end.toISOString()).toBe('2026-02-28T19:00:00.000Z');

    const range = parseAiQuestion(
      'payments from 2026-07-01 to 2026-07-03',
      NOW,
    );
    expect(range.window.start?.toISOString()).toBe('2026-06-30T19:00:00.000Z');
    expect(range.window.end.toISOString()).toBe('2026-07-03T19:00:00.000Z');
  });

  it('rejects invalid and unbounded explicit date ranges', () => {
    expect(() => parseAiQuestion('2026-02-30 payments', NOW)).toThrow(
      'valid YYYY-MM-DD',
    );
    expect(() =>
      parseAiQuestion('2026-01-01 to 2027-01-02 payments', NOW),
    ).toThrow('no longer than 366 days');
  });

  it('recognizes authentication and NAS event questions without polling devices', () => {
    expect(
      parseAiQuestion(
        'show authentication failures and NAS offline events',
        NOW,
      ).topics,
    ).toEqual(['network-events']);
  });

  it('recognizes comparisons, attendance, receipts, and protected data requests', () => {
    const comparison = parseAiQuestion(
      'Compare attendance for the last 7 days',
      NOW,
    );
    expect(comparison.topics).toEqual(['attendance']);
    expect(comparison.comparePeriods).toBe(true);

    expect(parseAiQuestion('How many receipts?', NOW).topics).toEqual([
      'collections',
    ]);
    expect(parseAiQuestion('show staff salaries', NOW).protectedDetails).toBe(
      true,
    );
    expect(parseAiQuestion('ملازمین کی حاضری آج', NOW).topics).toEqual([
      'employees',
      'attendance',
    ]);
    expect(() => parseAiQuestion('compare collections', NOW)).toThrow(
      'bounded date period',
    );
    expect(() =>
      parseAiQuestion('compare sessions for the last 7 days', NOW),
    ).toThrow('current-state summaries');
    expect(() =>
      parseAiQuestion('compare overdue tickets for the last 7 days', NOW),
    ).toThrow('Historical ticket status');
    expect(() =>
      parseAiQuestion('compare active subscribers for the last 7 days', NOW),
    ).toThrow('Subscriber status and balance');
  });

  it('refuses reference lookups that have no authoritative UPLINKO records', () => {
    expect(() =>
      parseAiQuestion('Show equipment recovery for last month', NOW),
    ).toThrow('no dedicated recovery records');
    expect(() => parseAiQuestion('How many stock issues?', NOW)).toThrow(
      'no issue-specific record type',
    );
    expect(() => parseAiQuestion('Find subscriber 12345', NOW)).toThrow(
      'Named subscriber lookups are not available',
    );
    expect(() => parseAiQuestion('Show employee details', NOW)).toThrow(
      'Individual employee lookups are not available',
    );
    expect(() => parseAiQuestion('List invoices for this month', NOW)).toThrow(
      'aggregate summaries only',
    );
    expect(() => parseAiQuestion('Show monthly revenue', NOW)).toThrow(
      'accounting definitions',
    );
  });
});
