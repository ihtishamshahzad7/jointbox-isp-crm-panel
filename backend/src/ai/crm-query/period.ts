import { normalize } from './language';

/**
 * Date filters understood in a question (ported from the reference
 * assistant's period()): an explicit date or range (YYYY-MM-DD … YYYY-MM-DD),
 * a month (YYYY-MM), today / yesterday, this month / last month and
 * "last N days" (1–366). Days are calendar days in the company's time zone.
 */
export interface Period {
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
  /** UTC instants: [start, end) covering those days in the time zone. */
  start: Date;
  end: Date;
}

export class PeriodError extends Error {}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Today's calendar date in `tz`. */
export function todayIn(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset of `tz` from UTC at `at`, in ms (positive east of Greenwich). */
function offsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant at which `day` begins in `tz`. */
export function dayStart(day: string, tz: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const first = new Date(guess.getTime() - offsetMs(tz, guess));
  // Second pass settles days on which the offset changes (DST).
  return new Date(guess.getTime() - offsetMs(tz, first));
}

function validDate(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || iso(d) !== s) throw new PeriodError(`${s} is not a valid date.`);
  return s;
}

export function build(from: string, to: string, tz: string): Period {
  return { from, to, start: dayStart(from, tz), end: dayStart(addDays(to, 1), tz) };
}

/** The period a question asks about, or null when it names none. */
export function parsePeriod(question: string, tz: string, now = new Date()): Period | null {
  const q = normalize(question);
  const today = todayIn(tz, now);
  const dates = q.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (dates) {
    const from = validDate(dates[0]);
    const to = validDate(dates[dates.length - 1]);
    if (to < from) throw new PeriodError('The end date must be after the start date.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366)
      throw new PeriodError('Use a date range of up to 366 days.');
    return build(from, to, tz);
  }
  const months = q.match(/\b\d{4}-\d{2}\b/g);
  if (months) {
    const first = validDate(`${months[0]}-01`);
    const d = new Date(`${first}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return build(first, iso(d), tz);
  }
  if (/\byesterday\b/.test(q)) {
    const y = addDays(today, -1);
    return build(y, y, tz);
  }
  if (/\btoday\b|\bdaily\b/.test(q)) return build(today, today, tz);
  const recent = q.match(/\blast (\d+) days?\b/);
  if (recent) {
    const n = Number(recent[1]);
    if (!(n >= 1 && n <= 366)) throw new PeriodError('Use a range of 1–366 days.');
    return build(addDays(today, -(n - 1)), today, tz);
  }
  if (/\blast month\b/.test(q)) {
    const lastDay = addDays(`${today.slice(0, 7)}-01`, -1);
    return build(`${lastDay.slice(0, 7)}-01`, lastDay, tz);
  }
  if (/\bthis month\b/.test(q)) return build(`${today.slice(0, 7)}-01`, today, tz);
  return null;
}

/** "This month so far" — the default for money questions that name no period. */
export function thisMonth(tz: string, now = new Date()): Period {
  const today = todayIn(tz, now);
  return build(`${today.slice(0, 7)}-01`, today, tz);
}
