import { BadRequestException } from '@nestjs/common';

export type AiQueryTopic =
  | 'subscribers'
  | 'collections'
  | 'tickets'
  | 'sessions'
  | 'packages'
  | 'inventory'
  | 'field-jobs'
  | 'expenses'
  | 'network-events'
  | 'stock-movements'
  | 'employees'
  | 'attendance';

export interface AiQueryWindow {
  label: string;
  start: Date | null;
  end: Date;
}

export interface ParsedAiQuestion {
  normalized: string;
  topics: AiQueryTopic[];
  window: AiQueryWindow;
  comparePeriods: boolean;
  protectedDetails: boolean;
}

const URDU_TRANSLATIONS: Array<[RegExp, string]> = [
  [/آج|آج/g, ' today '],
  [/کل/g, ' yesterday '],
  [/اس ماہ|اس مہینے/g, ' this month '],
  [/پچھلے ماہ|گزشتہ ماہ|پچھلے مہینے/g, ' last month '],
  [/صارفین|گاہک|کسٹمرز/g, ' subscribers '],
  [/وصولی|جمع شدہ|ادائیگیوں/g, ' collections payments '],
  [/ٹکٹ|شکایتیں|شکایات/g, ' tickets '],
  [/آن لائن|آنلائن|سیشنز/g, ' sessions online '],
  [/پیکیج|پیکجز|پلانز/g, ' packages '],
  [/رسید|رسیدیں|وصولی کی رسید/g, ' receipts payments '],
  [
    /اسٹاک جاری|سامان جاری|واپسی|واپس کیا|سامان واپس|آلات کی واپسی/g,
    ' stock issue returned ',
  ],
  [/ریکوری|ریکور/g, ' recovery '],
  [/اسٹاک|انوینٹری/g, ' inventory '],
  [/فیلڈ جابز|کاموں/g, ' field jobs '],
  [/ملازم|ملازمین|عملہ/g, ' employees staff '],
  [/حاضری/g, ' attendance '],
  [/اخراجات|خرچ/g, ' expenses '],
  [/تنخواہ|تنخواہیں|بینک اکاؤنٹ|شناختی دستاویز/g, ' salary bank account identity document '],
  [/موازنہ|تقابل/g, ' compare '],
  [/ناکام لاگ ان|ناکام تصدیق/g, ' authentication failures '],
  [/روٹر|راؤٹر|نیٹ ورک|لنک ڈاؤن/g, ' router network link down '],
  [/پچھلے|گزشتہ/g, ' last '],
  [/دن/g, ' days '],
  [/\bdin\b/g, ' days '],
];

const TOPIC_MATCHERS: Array<[AiQueryTopic, RegExp]> = [
  [
    'subscribers',
    /\b(subscriber|subscribers|customer|customers|user|users|expired|active|suspended|new connection)\b/,
  ],
  [
    'collections',
    /\b(collection|collections|payment|payments|received|invoice|invoices|paid|dues?|wasooli|jama)\b/,
  ],
  ['tickets', /\b(ticket|tickets|complaint|complaints|support|sla)\b/],
  ['sessions', /\b(session|sessions|online|connected|pppoe|radius)\b/],
  ['packages', /\b(package|packages|plan|plans)\b/],
  ['inventory', /\b(inventory|stock|hardware|onu|router stock)\b/],
  [
    'stock-movements',
    /\b(stock issue|stock issues|issued stock|stock movement|stock movements|stock return|stock returns|returned stock|equipment issue|maal issue)\b/,
  ],
  [
    'field-jobs',
    /\b(field job|field jobs|job|jobs|technician|installation|work order)\b/,
  ],
  ['expenses', /\b(expense|expenses|cost|spend|spending)\b/],
  [
    'employees',
    /\b(employee|employees|staff|workforce|personnel|mulazim|amla)\b/,
  ],
  [
    'attendance',
    /\b(attendance|check in|check-in|check out|check-out|present staff|absent staff|hazri)\b/,
  ],
  ['collections', /\b(receipt|receipts|rasid|raseed)\b/],
  [
    'network-events',
    /\b(authentication failure|authentication failures|auth fail|auth failures|failed login|nas offline|router offline|link down|network events)\b/,
  ],
];

function karachiDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
  };
}

function karachiMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - 5 * 60 * 60 * 1000);
}

function normalizedQuestion(question: string): string {
  let value = question.normalize('NFKC').toLowerCase();
  for (const [pattern, replacement] of URDU_TRANSLATIONS) {
    value = value.replace(pattern, replacement);
  }
  return value
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new BadRequestException(
      'Date filters must use valid YYYY-MM-DD values.',
    );
  }
  return { year, month, day };
}

function queryWindow(
  normalized: string,
  question: string,
  now: Date,
): AiQueryWindow {
  const range = question.match(
    /(?:from\s+)?(20\d{2}-\d{2}-\d{2})\s+(?:to|through|until)\s+(20\d{2}-\d{2}-\d{2})/i,
  );
  if (range) {
    const from = validDate(range[1]);
    const to = validDate(range[2]);
    const start = karachiMidnight(from.year, from.month, from.day);
    const endDay = karachiMidnight(to.year, to.month, to.day);
    if (
      endDay < start ||
      endDay.getTime() - start.getTime() > 365 * 24 * 60 * 60 * 1000
    ) {
      throw new BadRequestException(
        'Date range must be ordered and no longer than 366 days.',
      );
    }
    return {
      label: `${range[1]} to ${range[2]}`,
      start,
      end: new Date(endDay.getTime() + 24 * 60 * 60 * 1000),
    };
  }
  const date = question.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (date) {
    const value = validDate(date[1]);
    const start = karachiMidnight(value.year, value.month, value.day);
    return {
      label: date[1],
      start,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    };
  }
  const month = question.match(/\b(20\d{2})-(\d{2})\b/);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (monthNumber < 1 || monthNumber > 12) {
      throw new BadRequestException(
        'Month filters must use a valid YYYY-MM value.',
      );
    }
    const start = karachiMidnight(year, monthNumber, 1);
    const end = karachiMidnight(
      monthNumber === 12 ? year + 1 : year,
      monthNumber === 12 ? 1 : monthNumber + 1,
      1,
    );
    return { label: month[0], start, end };
  }
  const today = karachiDateParts(now);
  const todayStart = karachiMidnight(today.year, today.month, today.day);
  const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  if (/\b(yesterday|kal)\b/.test(normalized)) {
    return { label: 'yesterday', start: yesterday, end: todayStart };
  }
  if (/\b(today|aaj)\b/.test(normalized)) {
    return { label: 'today', start: todayStart, end: tomorrow };
  }
  if (
    /\b(last month|previous month|pichlay mahine|pichlay maheene)\b/.test(
      normalized,
    )
  ) {
    const firstThisMonth = karachiMidnight(today.year, today.month, 1);
    const previousMonthEnd = firstThisMonth;
    const previousMonthStart = karachiMidnight(
      today.month === 1 ? today.year - 1 : today.year,
      today.month === 1 ? 12 : today.month - 1,
      1,
    );
    return {
      label: 'last month',
      start: previousMonthStart,
      end: previousMonthEnd,
    };
  }
  if (/\b(this month|current month|is mahine|is maheene)\b/.test(normalized)) {
    return {
      label: 'this month',
      start: karachiMidnight(today.year, today.month, 1),
      end: tomorrow,
    };
  }
  const days = normalized.match(
    /\b(?:last|previous|pichlay|guzishta)\s+(\d{1,3})\s+days?\b/,
  );
  if (days) {
    const count = Math.min(366, Math.max(1, Number(days[1])));
    return {
      label: `last ${count} days`,
      start: new Date(todayStart.getTime() - (count - 1) * 24 * 60 * 60 * 1000),
      end: tomorrow,
    };
  }
  return { label: 'all time', start: null, end: now };
}

export function parseAiQuestion(
  question: string,
  now = new Date(),
): ParsedAiQuestion {
  const normalized = normalizedQuestion(question);
  if (
    /\b(recovery|recoveries|recover equipment|equipment recovery|device recovery)\b/.test(
      normalized,
    )
  ) {
    throw new BadRequestException(
      'Recovery summaries are unavailable because UPLINKO has no dedicated recovery records.',
    );
  }
  if (/\b(revenue|sales|turnover)\b/.test(normalized)) {
    throw new BadRequestException(
      'Sales and revenue summaries are unavailable until their UPLINKO accounting definitions are integrated.',
    );
  }
  if (
    /\b(stock issue|stock issues|issued stock|stock return|stock returns|returned stock|equipment issue)\b/.test(
      normalized,
    )
  ) {
    throw new BadRequestException(
      'Item-level stock issue summaries are unavailable; UPLINKO has no issue-specific record type.',
    );
  }
  const asksForLookup =
    /\b(find|search|lookup|look up|list|which|who|profile|details|record|names?|payment id|username)\b/.test(
      normalized,
    ) &&
    /\b(subscriber|subscribers|customer|customers|user|users)\b/.test(
      normalized,
    );
  const asksForWalletBalance =
    /\b(balance|balances|wallet)\b/.test(normalized) &&
    /\b(subscriber|subscribers|customer|customers|user|users)\b/.test(
      normalized,
    );
  const asksForEmployeeLookup =
    /\b(find|search|lookup|look up|list|which|who|profile|details|record|employee id|employee number|names?)\b/.test(
      normalized,
    ) &&
    /\b(employee|employees|staff|workforce|personnel|mulazim|amla)\b/.test(
      normalized,
    );
  const asksForOtherRecordLookup =
    /\b(find|search|lookup|look up|list|which|who)\b/.test(normalized) &&
    /\b(ticket|tickets|invoice|invoices|payment|payments|receipt|receipts|collection|collections|expense|expenses|stock|inventory item|field job|package|network event)\b/.test(
      normalized,
    );
  if (asksForLookup || asksForWalletBalance) {
    throw new BadRequestException(
      'Named subscriber lookups and balances are not available in the AI Agent; ask for an aggregate summary.',
    );
  }
  if (asksForEmployeeLookup) {
    throw new BadRequestException(
      'Individual employee lookups are not available in the AI Agent; ask for an aggregate summary.',
    );
  }
  if (asksForOtherRecordLookup) {
    throw new BadRequestException(
      'The AI Agent supports aggregate summaries only; record-level lookups are not available.',
    );
  }
  const hasEmployeeTerm =
    /\b(employee|employees|staff|workforce|personnel|mulazim|amla)\b/.test(
      normalized,
    );
  const hasSubscriberTerm =
    /\b(subscriber|subscribers|customer|customers|user|users)\b/.test(
      normalized,
    );
  const topics = [
    ...new Set(
      TOPIC_MATCHERS.filter(([, matcher]) => matcher.test(normalized)).map(
        ([topic]) => topic,
      ),
    ),
  ].filter(
    (topic) =>
      topic !== 'subscribers' || !hasEmployeeTerm || hasSubscriberTerm,
  );
  const comparePeriods =
    /\b(compare|comparison|versus|vs|muqabla|mukabla)\b/.test(normalized);
  const window = queryWindow(normalized, question, now);
  if (comparePeriods && window.start == null) {
    throw new BadRequestException(
      'Choose a bounded date period to compare with the previous period.',
    );
  }
  const snapshotTopicLabels: Partial<Record<AiQueryTopic, string>> = {
    sessions: 'online sessions',
    packages: 'package performance',
    inventory: 'current inventory',
  };
  const snapshotTopics = topics
    .filter((topic) => topic in snapshotTopicLabels)
    .map((topic) => snapshotTopicLabels[topic] ?? topic);
  if (comparePeriods && snapshotTopics.length) {
    throw new BadRequestException(
      `Period comparisons are unavailable for current-state summaries: ${snapshotTopics.join(', ')}.`,
    );
  }
  if (
    comparePeriods &&
    topics.includes('subscribers') &&
    /\b(active|expired|suspended|status|balance)\b/.test(normalized)
  ) {
    throw new BadRequestException(
      'Subscriber status and balance are current-state summaries; only new-subscriber counts can be compared.',
    );
  }
  if (
    comparePeriods &&
    topics.includes('tickets') &&
    /\b(open|overdue|sla|breached|pending|resolved|status)\b/.test(normalized)
  ) {
    throw new BadRequestException(
      'Historical ticket status and SLA comparisons are unavailable; only ticket creation counts can be compared.',
    );
  }
  if (
    comparePeriods &&
    topics.includes('employees') &&
    /\b(active|inactive|status|department|designation)\b/.test(normalized)
  ) {
    throw new BadRequestException(
      'Employee status is a current-state summary; only new-hire counts can be compared.',
    );
  }
  return {
    normalized,
    topics,
    window,
    comparePeriods,
    protectedDetails:
      /\b(salaries?|payroll|bank account|bank details|cnic|identity document|passwords?|credentials|api keys?|secrets?)\b/.test(
        normalized,
      ),
  };
}
