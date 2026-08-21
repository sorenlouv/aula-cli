/** Small runtime guards for values TypeScript cannot prove at compile time. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isOptional<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | undefined {
  return value === undefined || predicate(value);
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
