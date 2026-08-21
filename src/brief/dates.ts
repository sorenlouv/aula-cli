/**
 * Grounding for model-authored dates.
 *
 * The quote validator proved the pattern: the cheapest guard against a
 * confidently invented fact is a literal check against the sources. Dates are
 * the other thing the models invent — a "senest søndag" here, a "første gang
 * 24/8" there — so they get the same treatment. Every weekday, calendar date
 * or week number in model-authored text must be traceable to a source text,
 * a source's own timestamp, the claim's own validated date, or today.
 *
 * Out of scope, deliberately: semantic misplacement — a date that exists in
 * the sources but is attached to the wrong item. Catching that needs
 * understanding, not matching, and the judge benchmarks showed it is far
 * rarer than plain invention.
 */

import { localIsoDate } from '../integrations/types.ts';
import { isValidCalendarDate, parseIsoDateParts } from '../validation.ts';
import type { BriefInput } from './types.ts';

/** Indexed as `Date#getDay()`: Sunday first. */
export const DA_WEEKDAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
export const DA_MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];

const STEM_TO_DAY: Record<string, number> = {
  søn: 0, man: 1, tirs: 2, ons: 3, tors: 4, fre: 5, lør: 6,
};

export type DateClaim =
  | { kind: 'weekday'; day: number; raw: string }
  | { kind: 'date'; month: number; day: number; raw: string }
  | { kind: 'week'; week: number; raw: string };

const WEEKDAY_RE = /\b(man|tirs|ons|tors|fre|lør|søn)dag(?:s|ene|en|e)?\b/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})[./](\d{1,2})\b/g;
// Full names first so "september" is not eaten by "sep".
const MONTH_ALT =
  'januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|dec';
const NAMED_DATE_RE = new RegExp(`\\b(\\d{1,2})\\.?\\s*(${MONTH_ALT})\\b`, 'gi');
// "24. til 28. august" / "24.-28. august": the start day never stands next to
// the month name, so it needs its own pattern.
const RANGE_START_RE = new RegExp(
  `\\b(\\d{1,2})\\.?\\s*(?:til\\s*|[-–]\\s*)\\d{1,2}\\.?\\s*(${MONTH_ALT})\\b`,
  'gi',
);
const WEEK_RE = /\buge\s*(\d{1,2})\b/gi;

function monthIndex(name: string): number {
  const map: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
  };
  return map[name.toLowerCase().slice(0, 3)] ?? 0;
}

/** Every date-shaped assertion in a piece of Danish prose. */
export function findDateClaims(text: string): DateClaim[] {
  const claims: DateClaim[] = [];
  for (const m of text.matchAll(WEEKDAY_RE)) {
    const day = STEM_TO_DAY[(m[1] ?? '').toLowerCase()];
    if (day !== undefined) claims.push({ kind: 'weekday', day, raw: m[0] });
  }
  for (const m of text.matchAll(NUMERIC_DATE_RE)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    // Clock times ("kl. 17.30", "9.05") look identical; an impossible month
    // rules most out, and an explicit "kl." rules out the rest.
    if (!isValidCalendarDate(2000, month, day)) continue;
    if (/kl\.?\s*$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 6), m.index))) continue;
    claims.push({ kind: 'date', month, day, raw: m[0] });
  }
  for (const m of text.matchAll(NAMED_DATE_RE)) {
    const day = Number(m[1]);
    const month = monthIndex(m[2] ?? '');
    if (isValidCalendarDate(2000, month, day)) claims.push({ kind: 'date', month, day, raw: m[0] });
  }
  for (const m of text.matchAll(RANGE_START_RE)) {
    const day = Number(m[1]);
    const month = monthIndex(m[2] ?? '');
    if (isValidCalendarDate(2000, month, day)) claims.push({ kind: 'date', month, day, raw: m[0] });
  }
  for (const m of text.matchAll(WEEK_RE)) {
    claims.push({ kind: 'week', week: Number(m[1]), raw: m[0] });
  }
  return claims;
}

type SourceDates = { weekdays: Set<number>; dates: Set<string>; relTomorrow: boolean; relToday: boolean };

export type DateSupport = {
  weekdays: Set<number>;
  dates: Set<string>; // "M-D"
  weeks: Set<number>;
  perSource: Map<string, SourceDates>;
  today: string;
  todayWeekday: number;
  windowEnd: string; // last YYYY-MM-DD a weekday-derived date may land on
};

const key = (month: number, day: number) => `${month}-${day}`;

function isoDate(value: string): { iso: string; month: number; day: number; weekday: number } | null {
  const parsed = parseIsoDateParts(value.slice(0, 10));
  if (!parsed) return null;
  return { iso: parsed.iso, month: parsed.month, day: parsed.day, weekday: parsed.weekday };
}

/** Everything the sources, their timestamps, and today can vouch for. */
export function buildDateSupport(input: BriefInput): DateSupport {
  const support: DateSupport = {
    weekdays: new Set(),
    dates: new Set(),
    weeks: new Set(),
    perSource: new Map(),
    today: input.today,
    todayWeekday: -1,
    windowEnd: '',
  };
  const todayParsed = isoDate(input.today);
  if (todayParsed) {
    support.dates.add(key(todayParsed.month, todayParsed.day));
    support.weekdays.add(todayParsed.weekday);
    support.todayWeekday = todayParsed.weekday;
    const end = new Date(`${input.today}T00:00:00`);
    end.setDate(end.getDate() + Math.max(input.windowDays, 7));
    support.windowEnd = localIsoDate(end);
  }
  const week = Number(/-W(\d{1,2})$/.exec(input.isoWeek)?.[1]);
  if (Number.isFinite(week)) support.weeks.add(week);

  for (const item of input.items) {
    const text = `${item.title}\n${item.text}`;
    const per: SourceDates = {
      weekdays: new Set(),
      dates: new Set(),
      relTomorrow: /\bi morgen\b/i.test(text),
      relToday: /\bi dag\b/i.test(text),
    };
    for (const claim of findDateClaims(text)) {
      if (claim.kind === 'weekday') per.weekdays.add(claim.day);
      else if (claim.kind === 'date') per.dates.add(key(claim.month, claim.day));
      else support.weeks.add(claim.week);
    }
    const at = item.at ? isoDate(item.at) : null;
    if (at) {
      // The timestamp's date and weekday are visible metadata, so prose may
      // mention them — but only a weekday the source *text* asserts may
      // ground a derived dueAt, or every post would license one future date
      // per week forever.
      per.dates.add(key(at.month, at.day));
      support.weekdays.add(at.weekday);
    }
    support.perSource.set(item.key, per);
    for (const d of per.weekdays) support.weekdays.add(d);
    for (const d of per.dates) support.dates.add(d);
  }
  return support;
}

/**
 * Date-shaped claims in model prose that nothing vouches for. `own.dueAt` is
 * the claim's already-validated date, so echoing it (or its weekday) is fine.
 *
 * With `own.sourceKey`, bare weekdays are held to the claim's own source
 * (plus today): "senest søndag" on a photo card must not survive because a
 * different post mentions Sundays. Explicit dates stay globally checkable —
 * cross-references ("dobbeltbooket 9/9") name dates, inventions rarely do.
 */
export function unsupportedDateClaims(
  text: string,
  support: DateSupport,
  own: { dueAt?: string | null; sourceKey?: string } = {},
): string[] {
  const dueAt = own.dueAt ? isoDate(own.dueAt) : null;
  const per = own.sourceKey ? support.perSource.get(own.sourceKey) : undefined;
  // A bare weekday names a specific upcoming day; if any source attests that
  // day as a date, the claim is grounded even across sources — merged items
  // routinely cite one source while echoing a day the other one dated.
  const resolvesToAttestedDate = (day: number) => {
    if (!support.windowEnd) return false;
    const cursor = new Date(`${support.today}T00:00:00`);
    for (let i = 0; i < 60; i++) {
      if (cursor.getDay() === day && support.dates.has(key(cursor.getMonth() + 1, cursor.getDate())))
        return true;
      cursor.setDate(cursor.getDate() + 1);
      if (localIsoDate(cursor) > support.windowEnd) break;
    }
    return false;
  };
  const weekdayOk = (day: number) =>
    (per
      ? per.weekdays.has(day) || day === support.todayWeekday
      : support.weekdays.has(day)) ||
    dueAt?.weekday === day ||
    resolvesToAttestedDate(day);
  const bad: string[] = [];
  for (const claim of findDateClaims(text)) {
    const ok =
      claim.kind === 'weekday'
        ? weekdayOk(claim.day)
        : claim.kind === 'date'
          ? support.dates.has(key(claim.month, claim.day)) ||
            (dueAt !== null && dueAt.month === claim.month && dueAt.day === claim.day)
          : support.weeks.has(claim.week);
    if (!ok && !bad.includes(claim.raw)) bad.push(claim.raw);
  }
  return bad;
}

/**
 * Whether a signal's `dueAt` is grounded — by the signal's OWN source only:
 * an explicit date it carries, its timestamp, or a forward derivation
 * ("på tirsdag", "i morgen", "i dag") landing inside the digest window.
 * Another source's date deliberately does not count: the date chip is what a
 * parent acts on, and "some other post mentions the 25th" is exactly how a
 * wrong chip slips through looking grounded.
 */
export function dueAtSupported(dueAt: string, sourceKey: string, support: DateSupport): boolean {
  const parsed = isoDate(dueAt);
  if (!parsed) return false;
  const per = support.perSource.get(sourceKey);
  if (!per) return false;
  if (per.dates.has(key(parsed.month, parsed.day))) return true;
  const inWindow = parsed.iso >= support.today && (!support.windowEnd || parsed.iso <= support.windowEnd);
  if (!inWindow) return false;
  if (per.weekdays.has(parsed.weekday)) return true;
  if (per.relToday && parsed.iso === support.today) return true;
  if (per.relTomorrow) {
    const next = new Date(`${support.today}T00:00:00`);
    next.setDate(next.getDate() + 1);
    if (parsed.iso === localIsoDate(next)) return true;
  }
  return false;
}
