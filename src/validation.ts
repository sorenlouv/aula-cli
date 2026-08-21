/** Small runtime guards for values TypeScript cannot prove at compile time. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Absent, or a T" — where *absent* covers `null` as well as `undefined`.
 *
 * JSON has no `undefined`. Parsing a payload can only produce it from a key
 * that is not there at all; an optional field the server does send but has
 * nothing to put in arrives as `null`. Accepting only `undefined` therefore
 * rejects the commonest way a JSON API says "not applicable" — which is how a
 * MitID response with `"nextAuthenticator": null` came to be reported as an
 * unexpected shape, hiding the perfectly good error message underneath it.
 *
 * The narrowed type keeps the `null`, so callers have to deal with it rather
 * than being told a field is missing when it is present and empty.
 */
export function isOptional<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | null | undefined {
  return value === undefined || value === null || predicate(value);
}

export function isArrayOf<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T[] {
  return Array.isArray(value) && value.every(predicate);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isStringOrNumber(value: unknown): value is string | number {
  return isString(value) || isNumber(value);
}

/** Turns a checked type predicate into a decoder for an untrusted boundary. */
export function expectType<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
  description: string,
): T {
  if (!predicate(value)) throw new Error(`Expected ${description}`);
  return value;
}

export type IsoDateParts = Readonly<{
  iso: string;
  year: number;
  month: number;
  day: number;
  weekday: number;
}>;

/** Parses an exact local-calendar `YYYY-MM-DD`; JavaScript date rollover is rejected. */
export function parseIsoDateParts(value: string): IsoDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;

  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return { iso: value, year, month, day, weekday: date.getDay() };
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

export function parseInteger(
  value: string | undefined,
  range: { min: number; max?: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) return undefined;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < range.min) return undefined;
  if (range.max !== undefined && parsed > range.max) return undefined;
  return parsed;
}

/** Accepts only real ISO weeks, including the years that genuinely have week 53. */
export function isIsoWeek(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1000 || year > 9999 || week < 1) return false;
  return week <= isoWeeksInYear(year);
}

function isoWeeksInYear(year: number): number {
  // 28 December always belongs to the last ISO week of its calendar year.
  const date = new Date(Date.UTC(year, 11, 28));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * A one-line sketch of a parsed payload: keys and their JSON types, never
 * their values.
 *
 * For when a guard rejects something and "unexpected shape" is all the error
 * can say. Diagnosing the MitID login meant hand-writing this function at a
 * REPL to discover that two fields were `null` rather than absent — which is
 * exactly the sort of thing the error should have been able to say itself.
 *
 * Values are deliberately omitted rather than truncated. These payloads carry
 * session ids, salts and signatures, and an error message is the last place
 * that should be making its own judgement about which of them are secret.
 */
export function describeShape(value: unknown, depth = 2): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return depth <= 0 ? '[…]' : `[${describeShape(value[0], depth - 1)}, …×${value.length}]`;
  }
  if (typeof value !== 'object') return typeof value;
  if (depth <= 0) return '{…}';

  const entries = Object.entries(value);
  const shown = entries
    .slice(0, SHAPE_MAX_KEYS)
    .map(([key, item]) => `${key}: ${describeShape(item, depth - 1)}`);
  if (entries.length > SHAPE_MAX_KEYS) shown.push(`…+${entries.length - SHAPE_MAX_KEYS} more`);
  return `{${shown.join(', ')}}`;
}

/** Enough keys to recognise a payload, few enough to stay one readable line. */
const SHAPE_MAX_KEYS = 12;
