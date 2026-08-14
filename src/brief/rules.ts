/**
 * Danish date and obligation extraction.
 *
 * This is not a stopgap for the model — it is the fallback when the model is
 * unavailable, and the oracle the model is checked against. Every form here was
 * taken from real messages: `d. 18/9`, `tirsdag den 1. september 2026`,
 * `den 17.9 fra 17.00`, `uge 34`, `på mandag`.
 *
 * The output is always anchored to a literal substring of the input, because a
 * date shown without the sentence it came from cannot be checked at a glance.
 */

import type { SignalKind, Urgency } from './types.ts';

/**
 * Full and abbreviated month names. The abbreviations are not optional: the
 * live data contains "Mødet er fredag d. 18 sep kl 13-14", and dropping that
 * date loses the single most important appointment in the account.
 */
const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, februar: 2, feb: 2, marts: 3, mar: 3, april: 4, apr: 4,
  maj: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const WEEKDAYS: Record<string, number> = {
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
};

/**
 * Words that turn a sentence into something the reader has to *do*.
 *
 * Ordered most-specific first; the first match decides the signal kind, so
 * "husk at aflevere senest fredag" is a `bring`, not a `deadline`.
 */
const MARKERS: Array<{ re: RegExp; kind: SignalKind; urgency: Urgency }> = [
  // Danish compounds mean a `\b`-anchored keyword misses most real uses:
  // "ansøgningsfristen" contains "frist", "Mødet" contains "møde". So these
  // deliberately match inside words.
  //
  // "have noget sporty tøj og sko med" — the object sits between verb and
  // particle, so those two cannot be matched as adjacent words either.
  {
    re: /husk\w*|medbring\w*|\b(have|tage|tag)\b[^.!?]{0,60}\bmed\b/i,
    kind: 'bring',
    urgency: 'week',
  },
  { re: /\b(aflyst|aflyses|lukke[rt]|ændret tidspunkt)\b/i, kind: 'action', urgency: 'now' },
  { re: /\w*frist\w*|\bsenest\b|\bdeadline\b/i, kind: 'deadline', urgency: 'week' },
  {
    re: /tilmeld\w*|\bafbud\b|besvar\w*|udfyld\w*|aflever\w*|\bsvar (os|tilbage)\b/i,
    kind: 'action',
    urgency: 'week',
  },
  { re: /\w*møde\w*|\bsamtale\w*|\bskole-hjem\b/i, kind: 'event', urgency: 'later' },
];

/** Abbreviations that must not end a sentence. */
const ABBREVIATIONS = /(?:\b(?:d|kl|bl|f|ca|nr|dvs|evt|inkl|mm|osv|pkt|stk|tlf)\.)$/i;

/**
 * Splits Danish prose into sentences without breaking on `d. 18/9` or `kl.
 * 17.30`. Newlines always end a sentence; a full stop only does when it is not
 * part of a known abbreviation or a numeric date.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let start = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (char !== '.' && char !== '!' && char !== '?') continue;

      const head = trimmed.slice(start, i + 1);
      const rest = trimmed.slice(i + 1);
      // A full stop between digits is a date or a time, never a sentence end.
      if (char === '.' && /^\d/.test(rest) && /\d$/.test(trimmed.slice(0, i))) continue;
      if (char === '.' && ABBREVIATIONS.test(head)) continue;
      // Real sentence ends are followed by whitespace and then a capital, or by
      // nothing at all. Without the capital check "den 1. september" splits
      // after the ordinal and the month is orphaned from its day.
      if (rest && !/^\s+[«"'(]?[A-ZÆØÅ0-9]/.test(rest)) continue;

      const sentence = head.trim();
      if (sentence) out.push(sentence);
      start = i + 1;
    }
    const tail = trimmed.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}

function iso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Picks the year for a day/month with none given.
 *
 * School messages almost always mean the next occurrence, so a date that has
 * already passed rolls to next year — but only if it is more than a week back,
 * because "mødet d. 11/8" written on 13 August is last Monday, not next year.
 */
function inferYear(day: number, month: number, today: Date): number {
  const thisYear = new Date(today.getFullYear(), month - 1, day);
  const daysAgo = (today.getTime() - thisYear.getTime()) / 86_400_000;
  return daysAgo > 21 ? today.getFullYear() + 1 : today.getFullYear();
}

function isValidDay(day: number, month: number): boolean {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

/** The next date on or after `today` falling on the given weekday. */
function nextWeekday(weekday: number, today: Date): Date {
  const result = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const delta = (weekday - result.getDay() + 7) % 7 || 7;
  result.setDate(result.getDate() + delta);
  return result;
}

/**
 * Every date expressed in a sentence, as `YYYY-MM-DD`.
 *
 * Returns all of them because a sentence like "informationsaften 25. august …
 * ansøgningsfrist 1. september" carries two, and taking only the first would
 * report the wrong one as the deadline.
 */
export function extractDates(sentence: string, today: Date): string[] {
  const found: string[] = [];
  const push = (date: Date) => {
    const value = iso(date);
    if (!found.includes(value)) found.push(value);
  };

  // "1. september 2026", "den 25. august", "d. 24. august", "d. 18 sep"
  const named = new RegExp(`(\\d{1,2})\\.?\\s+(${MONTH_PATTERN})\\.?(?:\\s+(\\d{4}))?`, 'gi');
  for (const match of sentence.matchAll(named)) {
    const day = Number(match[1]);
    const month = MONTHS[(match[2] ?? "").toLowerCase()];
    if (!month || !isValidDay(day, month)) continue;
    const year = match[3] ? Number(match[3]) : inferYear(day, month, today);
    push(new Date(year, month - 1, day));
  }

  // "18/9", "d. 18/9-2026"
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:[-/](\d{2,4}))?\b/g;
  for (const match of sentence.matchAll(slash)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (!isValidDay(day, month)) continue;
    let year: number;
    if (match[3]) {
      const raw = Number(match[3]);
      year = raw < 100 ? 2000 + raw : raw;
    } else {
      year = inferYear(day, month, today);
    }
    push(new Date(year, month - 1, day));
  }

  // "den 17.9 fra 17.00" — day.month with no year, distinguished from a time by
  // requiring the second number to be a plausible month and not zero-padded
  // like a clock ("17.00" is a time, "17.9" is a date).
  const dotted = /\b(\d{1,2})\.(\d{1,2})\b(?!\s*\d)/g;
  for (const match of sentence.matchAll(dotted)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (!isValidDay(day, month) || month > 12) continue;
    if (/^0\d$/.test(match[2] ?? "")) continue; // 17.00, 17.05 — a clock time
    push(new Date(inferYear(day, month, today), month - 1, day));
  }

  // "i dag", "i morgen", "på mandag"
  if (/\bi dag\b/i.test(sentence)) push(today);
  if (/\bi morgen\b/i.test(sentence)) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    push(tomorrow);
  }
  // Definite form too: "om mandagen" is Danish for "on Mondays". That is a
  // recurring commitment rather than a single date, and resolving it to the
  // next Monday is the actionable reading.
  const weekday = /\b(?:på|om)\s+(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:en)?\b/i.exec(
    sentence,
  );
  const weekdayIndex = weekday ? WEEKDAYS[weekday[1]?.toLowerCase() ?? ""] : undefined;
  if (weekdayIndex !== undefined) push(nextWeekday(weekdayIndex, today));

  return found;
}

export type RuleHit = {
  kind: SignalKind;
  quote: string;
  dueAt: string | null;
  urgency: Urgency;
};

/**
 * Urgency from how far away the date is. A date already past keeps `fyi` rather
 * than being dropped: a missed deadline is still worth seeing, just not at the
 * top of the page.
 */
export function urgencyFor(dueAt: string | null, today: Date, fallback: Urgency): Urgency {
  if (!dueAt) return fallback;
  const due = Date.parse(`${dueAt}T00:00:00`);
  if (!Number.isFinite(due)) return fallback;
  const days = Math.round((due - Date.parse(`${iso(today)}T00:00:00`)) / 86_400_000);
  if (days < 0) return 'fyi';
  if (days === 0) return 'now';
  if (days <= 7) return 'week';
  return 'later';
}

/**
 * Every sentence carrying an obligation marker, with its date if it has one.
 *
 * Sentences without a marker are ignored even when they contain a date — a
 * teacher writing "vi løb til boldbanen kl. 9.30" is describing the past, and
 * treating every date as a commitment is what makes these summaries noisy.
 */
export function extractHits(text: string, reference: Date, now: Date = reference): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const sentence of splitSentences(text)) {
    const marker = MARKERS.find((m) => m.re.test(sentence));
    if (!marker) continue;

    // Dates resolve against when the text was *written*, urgency against now.
    // "I morgen" in a post from 10 August means 11 August; reading it as
    // tomorrow turns every old narrative post into an urgent action.
    const dates = extractDates(sentence, reference);
    const dueAt = dates[0] ?? null;
    hits.push({
      kind: marker.kind,
      quote: sentence,
      dueAt,
      urgency: urgencyFor(dueAt, now, marker.urgency),
    });

    // A second date in the same sentence is usually the pair "event date +
    // application deadline"; keep it so the later one is not lost.
    for (const extra of dates.slice(1)) {
      hits.push({
        kind: marker.kind === 'bring' ? 'bring' : 'deadline',
        quote: sentence,
        dueAt: extra,
        urgency: urgencyFor(extra, now, marker.urgency),
      });
    }
  }
  return hits;
}
