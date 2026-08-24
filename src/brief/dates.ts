/**
 * Grounding for model-authored dates.
 *
 * Source validation proved the pattern: the cheapest guard against a
 * confidently invented fact is a literal check against the sources. Dates are
 * the other thing the models invent — a "senest søndag" here, a "første gang
 * 24/8" there — so they get the same treatment. Every weekday, calendar date
 * or week number in model-authored text must be traceable to a source text,
 * a source's own timestamp, the claim's own validated date, or today. Calendar
 * support keeps the complete year-month-day: a matching day and month in a
 * different year is not evidence.
 *
 * Out of scope, deliberately: semantic misplacement — a date that exists in
 * the sources but is attached to the wrong item. Catching that needs
 * understanding, not matching, and the judge benchmarks showed it is far
 * rarer than plain invention.
 */

import { isoWeekString, localIsoDate } from '../integrations/types.ts';
import { isValidCalendarDate, parseIsoDateParts } from '../validation.ts';
import { extractDates } from './rules.ts';
import type { BriefInput } from './types.ts';

/** Indexed as `Date#getDay()`: Sunday first. */
export const DA_WEEKDAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
export const DA_MONTHS = [
  'januar',
  'februar',
  'marts',
  'april',
  'maj',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'december',
];

/** "25/8" — the short form Danish calendars and messages both use. */
export function shortDayMonth(isoDay: string): string {
  const [, month = '', day = ''] = isoDay.split('-');
  return `${Number(day)}/${Number(month)}`;
}

/**
 * A calendar entry's time in words: "kl. 13:30–14:15", "kl. 13:30", "hele
 * dagen", "hele dagen 25/8–27/8", or a span across days.
 *
 * Shared between the model's copy of an appointment (`collect.ts`, where it
 * goes into the source text) and the page (`render.ts`, where it sits beside
 * the title) so the two cannot drift: a row saying one thing and the model
 * having read another is a small lie the rest of the page would inherit.
 */
export function intervalLabel(span: {
  startDay: string;
  endDay: string;
  /** `HH:MM` local; null for an all-day entry. */
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}): string {
  const { startDay, endDay, startTime, endTime } = span;
  if (span.allDay || !startTime) {
    return startDay === endDay
      ? 'hele dagen'
      : `hele dagen ${shortDayMonth(startDay)}–${shortDayMonth(endDay)}`;
  }
  if (startDay === endDay) {
    return endTime && endTime !== startTime ? `kl. ${startTime}–${endTime}` : `kl. ${startTime}`;
  }
  return `fra ${shortDayMonth(startDay)} kl. ${startTime} til ${shortDayMonth(endDay)} kl. ${endTime ?? startTime}`;
}

const STEM_TO_DAY: Record<string, number> = {
  søn: 0,
  man: 1,
  tirs: 2,
  ons: 3,
  tors: 4,
  fre: 5,
  lør: 6,
};

export type DateClaim =
  | { kind: 'weekday'; day: number; raw: string }
  | { kind: 'date'; month: number; day: number; year?: number; raw: string }
  | { kind: 'week'; week: number; raw: string };

const WEEKDAY_RE = /\b(man|tirs|ons|tors|fre|lør|søn)dag(?:s|ene|en|e)?\b/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./-](\d{2,4}))?\b/g;
// Full names first so "september" is not eaten by "sep".
const MONTH_ALT =
  'januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|dec';
const NAMED_DATE_RE = new RegExp(`\\b(\\d{1,2})\\.?\\s*(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`, 'gi');
// "24. til 28. august" / "24.-28. august": the start day never stands next to
// the month name, so it needs its own pattern.
const RANGE_START_RE = new RegExp(
  `\\b(\\d{1,2})\\.?\\s*(?:til\\s*|[-–]\\s*)\\d{1,2}\\.?\\s*(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`,
  'gi',
);
const WEEK_RE = /\buge\s*(\d{1,2})\b/gi;

function monthIndex(name: string): number {
  const map: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    maj: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    okt: 10,
    nov: 11,
    dec: 12,
  };
  return map[name.toLowerCase().slice(0, 3)] ?? 0;
}

function parsedYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return value < 100 ? 2000 + value : value;
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
    const year = parsedYear(m[3]);
    // Clock times ("kl. 17.30", "9.05") look identical; an impossible month
    // rules most out, and an explicit "kl." rules out the rest.
    if (!isValidCalendarDate(2000, month, day)) continue;
    if (/kl\.?\s*$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 6), m.index))) continue;
    claims.push({ kind: 'date', month, day, ...(year ? { year } : {}), raw: m[0] });
  }
  for (const m of text.matchAll(NAMED_DATE_RE)) {
    const day = Number(m[1]);
    const month = monthIndex(m[2] ?? '');
    const year = parsedYear(m[3]);
    if (isValidCalendarDate(year ?? 2000, month, day)) {
      claims.push({ kind: 'date', month, day, ...(year ? { year } : {}), raw: m[0] });
    }
  }
  for (const m of text.matchAll(RANGE_START_RE)) {
    const day = Number(m[1]);
    const month = monthIndex(m[2] ?? '');
    const year = parsedYear(m[3]);
    if (isValidCalendarDate(year ?? 2000, month, day)) {
      claims.push({ kind: 'date', month, day, ...(year ? { year } : {}), raw: m[0] });
    }
  }
  for (const m of text.matchAll(WEEK_RE)) {
    claims.push({ kind: 'week', week: Number(m[1]), raw: m[0] });
  }
  return claims;
}

type SourceDates = {
  weekdays: Set<number>;
  dates: Set<string>;
  weeks: Set<string>;
};

export type DateSupport = {
  weekdays: Set<number>;
  dates: Set<string>; // YYYY-MM-DD
  weeks: Set<number>;
  perSource: Map<string, SourceDates>;
  today: string;
  todayWeekday: number;
  supportStart: string; // earliest YYYY-MM-DD a dueAt may use
  supportEnd: string; // latest YYYY-MM-DD a dueAt may use
  windowEnd: string; // last YYYY-MM-DD a weekday-derived date may land on
};

function isoDate(
  value: string,
): { iso: string; year: number; month: number; day: number; weekday: number } | null {
  const parsed = parseIsoDateParts(value.slice(0, 10));
  if (!parsed) return null;
  return parsed;
}

const asLocalDate = (day: { year: number; month: number; day: number }) =>
  new Date(day.year, day.month - 1, day.day);

const supportsDateClaim = (dates: Set<string>, claim: Extract<DateClaim, { kind: 'date' }>) =>
  [...dates].some((value) => {
    const parsed = isoDate(value);
    return (
      parsed?.month === claim.month &&
      parsed.day === claim.day &&
      (claim.year === undefined || parsed.year === claim.year)
    );
  });

/** Everything the sources, their timestamps, and today can vouch for. */
export function buildDateSupport(input: BriefInput): DateSupport {
  const support: DateSupport = {
    weekdays: new Set(),
    dates: new Set(),
    weeks: new Set(),
    perSource: new Map(),
    today: input.today,
    todayWeekday: -1,
    supportStart: '',
    supportEnd: '',
    windowEnd: '',
  };
  const todayParsed = isoDate(input.today);
  if (todayParsed) {
    support.dates.add(todayParsed.iso);
    support.weekdays.add(todayParsed.weekday);
    support.todayWeekday = todayParsed.weekday;
    const start = asLocalDate(todayParsed);
    start.setDate(start.getDate() - input.windowDays);
    support.supportStart = localIsoDate(start);
    const supportEnd = asLocalDate(todayParsed);
    supportEnd.setDate(supportEnd.getDate() + 365);
    support.supportEnd = localIsoDate(supportEnd);
    const windowEnd = asLocalDate(todayParsed);
    windowEnd.setDate(windowEnd.getDate() + Math.max(input.windowDays, 7));
    support.windowEnd = localIsoDate(windowEnd);
  }
  const week = Number(/-W(\d{1,2})$/.exec(input.isoWeek)?.[1]);
  if (Number.isFinite(week)) support.weeks.add(week);

  for (const item of input.items) {
    const text = `${item.title}\n${item.text}`;
    const per: SourceDates = {
      weekdays: new Set(),
      dates: new Set(),
      weeks: new Set(),
    };
    const at = item.at ? isoDate(item.at) : null;
    const reference = at ?? todayParsed;
    for (const claim of findDateClaims(text)) {
      if (claim.kind === 'weekday') per.weekdays.add(claim.day);
      else if (claim.kind === 'week') {
        support.weeks.add(claim.week);
        if (reference) {
          const monday = extractDates(claim.raw, asLocalDate(reference))[0];
          if (monday) per.weeks.add(isoWeekString(new Date(`${monday}T12:00:00`)));
        }
      }
    }
    const addExtractedDates = (
      sourceText: string,
      sourceDate: ReturnType<typeof isoDate> | null,
    ) => {
      if (!sourceDate) return;
      for (const date of extractDates(sourceText, asLocalDate(sourceDate))) per.dates.add(date);
    };
    if (item.conversation) {
      const messages = item.conversation.messages.map((message) => ({
        ...message,
        written: message.at ? isoDate(message.at) : null,
      }));
      // A subject belongs to the start of the exchange, so its relative dates
      // use the first timestamp we have. Each message then uses its own: a late
      // "tak" must not turn "i morgen" from two weeks ago into tomorrow now.
      addExtractedDates(
        item.title,
        messages.find((message) => message.written)?.written ?? reference,
      );
      for (const message of messages) {
        addExtractedDates(message.text, message.written ?? reference);
        if (message.written) {
          per.dates.add(message.written.iso);
          support.weekdays.add(message.written.weekday);
        }
      }
    } else {
      addExtractedDates(text, reference);
    }
    if (at) {
      // The timestamp's date and weekday are visible metadata, so prose may
      // mention them — but only a weekday the source *text* asserts may
      // ground a derived dueAt, or every post would license one future date
      // per week forever.
      per.dates.add(at.iso);
      support.weekdays.add(at.weekday);
    }
    const endsAt = item.endsAt ? isoDate(item.endsAt) : null;
    if (endsAt) {
      per.dates.add(endsAt.iso);
      support.weekdays.add(endsAt.weekday);
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
      if (cursor.getDay() === day && support.dates.has(localIsoDate(cursor))) return true;
      cursor.setDate(cursor.getDate() + 1);
      if (localIsoDate(cursor) > support.windowEnd) break;
    }
    return false;
  };
  const weekdayOk = (day: number) =>
    (per ? per.weekdays.has(day) || day === support.todayWeekday : support.weekdays.has(day)) ||
    dueAt?.weekday === day ||
    resolvesToAttestedDate(day);
  const bad: string[] = [];
  for (const claim of findDateClaims(text)) {
    const ok =
      claim.kind === 'weekday'
        ? weekdayOk(claim.day)
        : claim.kind === 'date'
          ? supportsDateClaim(support.dates, claim) ||
            (dueAt !== null &&
              dueAt.month === claim.month &&
              dueAt.day === claim.day &&
              (claim.year === undefined || dueAt.year === claim.year))
          : support.weeks.has(claim.week);
    if (!ok && !bad.includes(claim.raw)) bad.push(claim.raw);
  }
  return bad;
}

/**
 * Whether a signal's `dueAt` is grounded — by the signal's OWN source only:
 * an explicit date it carries, its timestamp, or a derivation ("på tirsdag",
 * "i morgen", "i dag") resolved from the source's written date. The result
 * must fall between the beginning of the fetched history and one year ahead.
 * Another source's date deliberately does not count: the date chip is what a
 * parent acts on, and "some other post mentions the 25th" is exactly how a
 * wrong chip slips through looking grounded.
 */
export function dueAtSupported(dueAt: string, sourceKey: string, support: DateSupport): boolean {
  const parsed = isoDate(dueAt);
  if (!parsed) return false;
  if (
    !support.supportStart ||
    !support.supportEnd ||
    parsed.iso < support.supportStart ||
    parsed.iso > support.supportEnd
  )
    return false;
  const per = support.perSource.get(sourceKey);
  if (!per) return false;
  if (per.dates.has(parsed.iso)) return true;
  if (per.weeks.has(isoWeekString(asLocalDate(parsed)))) return true;
  const inWindow =
    parsed.iso >= support.today && (!support.windowEnd || parsed.iso <= support.windowEnd);
  if (!inWindow) return false;
  if (per.weekdays.has(parsed.weekday)) return true;
  return false;
}
