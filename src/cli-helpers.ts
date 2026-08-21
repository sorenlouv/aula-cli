/** Pure helpers used by the CLI, kept separate so tests can import them without running main(). */
import { UsageError } from './errors.ts';
import type { CommonFile } from './types.ts';
import { isoWeekString, weekOffset } from './integrations/types.ts';
import type { Contact, PresenceTemplates } from './types.ts';
import { isIsoWeek, parseIsoDateParts } from './validation.ts';

const COPENHAGEN = 'Europe/Copenhagen';

export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return (text || '(empty)')
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'unknown time';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('da-DK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: COPENHAGEN,
  }).format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('da-DK', { dateStyle: 'medium', timeZone: COPENHAGEN }).format(date);
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Accepts `7d`, `3w`, `2m`, a bare day count, or an ISO date. */
export function parseSince(input: string): Date {
  const relative = /^(\d+)\s*([dwmy]?)$/i.exec(input.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] || 'd').toLowerCase();
    const perUnit: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };
    return new Date(Date.now() - amount * (perUnit[unit] ?? 1) * 86_400_000);
  }
  // Aula's own timestamps are full ISO datetimes, so one pasted straight from a
  // message or from `--text` output resolves to the day it names.
  const trimmed = input.trim();
  const datePart = /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
  const parsed = parseIsoDateParts(datePart);
  if (!parsed) throw new UsageError(`Could not parse --since "${input}". Use e.g. 7d, 3w, or 2026-08-01.`);
  return new Date(parsed.year, parsed.month - 1, parsed.day);
}

/**
 * Aula's presence status enum, as shown in the "Komme/gå" module.
 *
 * The Danish label is the authoritative one — these are the strings the module
 * itself renders, and the English gloss is ours. Taken from scaarup/aula, which
 * has been reading this same `presence.getDailyOverview` field in production
 * for years. Getting it wrong is quiet and bad: an off-by-one turns "på tur"
 * into "present" and "ferie/fri" into "sick".
 */
const PRESENCE_STATUS: Readonly<Record<number, { da: string; en: string }>> = Object.freeze({
  0: { da: 'Ikke kommet', en: 'not arrived' },
  1: { da: 'Syg', en: 'sick' },
  2: { da: 'Ferie/fri', en: 'holiday or day off' },
  3: { da: 'Kommet/til stede', en: 'present' },
  4: { da: 'På tur', en: 'on a field trip' },
  5: { da: 'Sover', en: 'sleeping' },
  8: { da: 'Gået', en: 'checked out' },
});

export function presenceStatus(status: number | string | undefined): string {
  const entry = PRESENCE_STATUS[Number(status)];
  return entry ? entry.en : `status ${status}`;
}

/** The Danish label, for output a Danish-speaking parent has to recognise. */
export function presenceStatusDanish(status: number | string | undefined): string {
  return PRESENCE_STATUS[Number(status)]?.da ?? `status ${status}`;
}

/**
 * "Henteform" — how a child is allowed to leave, on a komme/gå template.
 * Wire constants from Aula's presence frontend; do not renumber.
 */
const PRESENCE_ACTIVITY_TYPES: Readonly<Record<number, { da: string; en: string }>> =
  Object.freeze({
    0: { da: 'Hentes af', en: 'collected by a named person' },
    1: { da: 'Selvbestemmer', en: 'may leave alone within a window' },
    2: { da: 'Sendes hjem', en: 'leaves alone at the exit time' },
    3: { da: 'Går hjem med', en: 'leaves with a named person' },
  });

function presenceActivityType(activityType: number | null | undefined): string | null {
  if (activityType === null || activityType === undefined) return null;
  return PRESENCE_ACTIVITY_TYPES[activityType]?.en ?? `activityType ${activityType}`;
}

/**
 * Flattens a Fælles Filer entry.
 *
 * The `file.file` nesting is Aula's own: the outer object is the attachment
 * record (name, virus-scan status, uploader) and the inner one is the stored
 * blob carrying the presigned URL. Reading the name off the wrong level gives
 * you an id where you wanted a filename.
 */
export function normaliseCommonFile(file: CommonFile) {
  return {
    id: file.id,
    title: file.title?.trim() || file.file?.name || '(untitled)',
    filename: file.file?.name ?? null,
    created: file.created ?? null,
    institution: file.institution?.institutionName ?? file.file?.creator?.institutionName ?? null,
    uploadedBy: file.file?.creator?.name ?? null,
    /** Only "available" has cleared the virus scan and can be fetched. */
    status: file.file?.status ?? null,
    groups: (file.groupRestrictions ?? []).map((g) => g.name).filter(Boolean),
    /** Presigned and short-lived, exactly like a message attachment. */
    url: file.file?.file?.url ?? null,
  };
}

export type NormalCommonFile = ReturnType<typeof normaliseCommonFile>;

/**
 * Resolves an id, or any distinctive text from the title or filename.
 *
 * Refuses an ambiguous match rather than picking the first: the shelf holds
 * near-identical names across years ("Ferieplan for skoleåret 25-26" vs
 * "26-27"), and silently downloading last year's timetable is worse than
 * asking.
 */
export function selectCommonFile(files: NormalCommonFile[], ref: string): NormalCommonFile {
  const trimmed = ref.trim();
  const byId = files.find((f) => String(f.id) === trimmed);
  if (byId) return byId;

  const needle = trimmed.toLowerCase();
  const matches = files.filter(
    (f) =>
      f.title.toLowerCase().includes(needle) || (f.filename ?? '').toLowerCase().includes(needle),
  );
  const only = matches[0];
  if (matches.length === 1 && only) return only;
  if (matches.length === 0) {
    throw new UsageError(`No shared file matches "${ref}". Run \`commonfiles\` to list them.`);
  }
  throw new UsageError(
    `"${ref}" matches ${matches.length} files — be more specific or use an id:\n` +
      matches.map((f) => `  [${f.id}] ${f.title}`).join('\n'),
  );
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer (got ${limit}).`);
  }
  const results = new Array<R>(items.length);
  const entries = items.entries();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const [index, item] of entries) {
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- CLI parsing

/** `--week 2026-W33`, `--next`, or the current week. */
export function resolveWeek(week: string | undefined, next: boolean): string {
  if (week) {
    // `2026-W5` is what people type, and both parsers accepted it before the
    // week check was tightened to two digits. Pad it rather than refuse it —
    // everything downstream keys on the canonical zero-padded form.
    const canonical = week.replace(
      /^(\d{4})-[Ww](\d{1,2})$/,
      (_match, year: string, number: string) => `${year}-W${number.padStart(2, '0')}`,
    );
    if (!isIsoWeek(canonical)) {
      throw new UsageError(`--week must look like 2026-W33, got "${week}".`);
    }
    return canonical;
  }
  return next ? weekOffset(1) : isoWeekString();
}

/** A contact, plus which group's list it came from. */
export type BirthdayContact = Contact & { group?: string };

export type Birthday = {
  name: string;
  group: string;
  /** `MM-DD`; Aula only shares the day and month for classmates. */
  date: string;
  inDays: number;
  turns: number | null;
};

/**
 * Birthdays, ordered by how soon they are rather than by calendar date —
 * "who is next" is the only question anybody asks of this list.
 */
export function upcomingBirthdays(contacts: BirthdayContact[], limit?: number): Birthday[] {
  const today = startOfDay(new Date());
  const rows: Birthday[] = [];

  for (const contact of contacts) {
    if (!contact.birthday || !contact.fullName) continue;
    // Parsed by hand rather than through `new Date`, which reads a bare
    // `YYYY-MM-DD` as UTC midnight and so lands on the previous day for anyone
    // west of Greenwich.
    const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(contact.birthday);
    if (!parts) continue;
    const birthYear = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);

    const next = new Date(today.getFullYear(), month - 1, day);
    if (next < today) next.setFullYear(next.getFullYear() + 1);
    const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
    // Aula shares only day and month for a classmate and fills the year with a
    // placeholder, so an implausible year means there is no real birth year.
    const turns =
      birthYear > 1900 && birthYear < today.getFullYear() ? next.getFullYear() - birthYear : null;

    rows.push({
      name: contact.fullName,
      group: String(contact.group ?? contact.mainGroupName ?? ''),
      date: `${parts[2]}-${parts[3]}`,
      inDays,
      turns,
    });
  }

  rows.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name, 'da'));
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Flattens `presence.getPresenceTemplates` into one row per child per day.
 * The API nests the times differently for each henteform — `pickup`,
 * `selfDecider`, `sendHome`, `goHomeWith` — so the caller would otherwise have
 * to know the enum to find an entry time.
 */
export function normaliseSchedule(templates: PresenceTemplates, window: { from: string; to: string }) {
  const days: Array<{
    child: string | null;
    childId: number | null;
    date: string | null;
    entryTime: string | null;
    exitTime: string | null;
    henteform: string | null;
    exitWith: string | null;
    comment: string | null;
  }> = [];

  for (const template of templates.presenceWeekTemplates ?? []) {
    const profile = template.institutionProfile ?? null;
    for (const day of template.dayTemplates ?? []) {
      const { pickup, goHomeWith, sendHome, selfDecider } = day;
      // Self-decider has no single exit time — it is a window the child may
      // leave within — so it renders as a range rather than a time.
      const selfDeciderWindow = selfDecider
        ? `${selfDecider.exitStartTime ?? '?'}–${selfDecider.exitEndTime ?? '?'}`
        : null;
      days.push({
        child: profile?.name ?? null,
        childId: profile?.id ?? null,
        date: day.date ?? null,
        entryTime:
          pickup?.entryTime ??
          goHomeWith?.entryTime ??
          sendHome?.entryTime ??
          selfDecider?.entryTime ??
          day.entryTime ??
          null,
        exitTime:
          pickup?.exitTime ??
          goHomeWith?.exitTime ??
          sendHome?.exitTime ??
          selfDeciderWindow ??
          day.exitTime ??
          null,
        henteform: presenceActivityType(day.activityType ?? null),
        exitWith: pickup?.exitWith ?? goHomeWith?.exitWith ?? null,
        comment: day.comment ?? null,
      });
    }
  }

  days.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { window, days };
}

/** `key=value` pairs for `raw`; repeated keys become an array. */
export function parseKeyValues(pairs: string[]): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new UsageError(`Expected key=value, got "${pair}".`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}
