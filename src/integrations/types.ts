/**
 * The contract every vendor integration implements.
 *
 * Six vendors serve the same handful of questions ("what is my child doing
 * this week", "what homework is due") behind six unrelated APIs, and a family
 * with two children at two schools can easily be talking to two of them at
 * once. So each integration normalises into one shape, and the CLI never has
 * to know which school is on Meebook.
 */

import type { Capability, Provider } from '../widgets.ts';
import { isIsoWeek } from '../validation.ts';

export type IntegrationContext = {
  /** ISO week, e.g. `2026-W33`. Every ugeplan provider is week-oriented. */
  isoWeek: string;
  /**
   * The guardian's `userId` from `profiles.getProfileContext`. MinUddannelse
   * and EasyIQ take this as their `sessionUUID` / `sessionId`.
   */
  guardianId: string;
  /**
   * The MitID username. Meebook (`sessionuuid` header), Systematic
   * (`sessionId` query) and SkolePortal's ugeplan (`x-login` header) want
   * *this*, not the Aula user id — the one place the two id spaces differ.
   *
   * It is not derivable from the API: it is what the user types into MitID,
   * so `login` records it on the stored token record. Without a record it
   * falls back to `guardianId`, which those vendors may reject — the
   * dispatcher warns then, keyed on the registry's `needsMitidUsername`.
   */
  sessionId: string;
  /** Whether `sessionId` is the real MitID username or the fallback. */
  sessionIdIsFallback: boolean;
  children: IntegrationChild[];
  /** Institution codes, e.g. `A12345`. */
  institutionCodes: string[];
  /** `YYYY-MM-DD`, for the providers that take a range rather than a week. */
  fromDate?: string;
  /** `YYYY-MM-DD`, inclusive. */
  toDate?: string;
};

export type IntegrationChild = {
  /** Institution-profile id — what Aula's own endpoints take. */
  id: number;
  name: string;
  /**
   * The opaque per-child token (`Child.userId`). Meebook rejects the numeric
   * id with "ugyldigt format", and SkolePortal keys `x-childfilter` on this,
   * so an empty string here means those providers cannot serve this child.
   */
  userId: string;
  /**
   * Aula's label for the child's institution — `'School'`, `'Daycare'`, ….
   * Weekly plans and homework are school products, and a vendor asked about a
   * child it has never heard of does not decline cleanly (SkolePortal answers
   * HTTP 500), so the dispatcher keeps daycare children away from the vendors
   * entirely. Absent when Aula did not say.
   */
  institutionType?: string;
};

/** One item of a weekly plan, homework list or reminder list. */
export type WeekPlanItem = {
  childName?: string;
  /**
   * Whatever the vendor gave us: an ISO timestamp, or a Danish label like
   * "mandag 28. nov.". Deliberately not normalised — several vendors send a
   * label with no parseable date behind it, and inventing one would be worse
   * than passing through what the teacher actually wrote.
   */
  date?: string;
  /** Subject, class or team — "Matematik", "2A". */
  subject?: string;
  title?: string;
  /** Plain text; vendor HTML is flattened through htmlToText. */
  content?: string;
  /** `comment` | `task` | `assignment` | `ugebrev` | `lektier` | … */
  kind?: string;
  url?: string;
};

export type WeekPlan = {
  /**
   * `'unavailable'` is not a vendor: it is the placeholder a capability gets
   * when the read threw before any vendor could answer, so the failure travels
   * in the payload instead of being flattened to an empty list that reads as a
   * quiet week. Widened only here — a `WidgetInfo` still has to name a real
   * vendor.
   */
  provider: Provider | 'unavailable';
  capability: Capability;
  widgetId: string;
  isoWeek: string;
  items: WeekPlanItem[];
  /** Per-child soft failures: the call worked, this child did not. */
  warnings?: string[];
};

// -------------------------------------------------------------- week helpers

/** ISO-8601 week string, `YYYY-Www`. Uses the Thursday-of-the-week rule. */
export function isoWeekString(date: Date = new Date()): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The Monday 00:00 UTC of an ISO week. Inverse of {@link isoWeekString}. */
export function isoWeekToMonday(isoWeek: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match || !isIsoWeek(isoWeek)) {
    throw new Error(`Not an ISO week string: "${isoWeek}" (expected e.g. 2026-W33).`);
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  // 4 January is always in ISO week 1, so walk back to that week's Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday;
}

/** `YYYY-MM-DD` in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` on the calendar the user is actually looking at.
 *
 * Denmark is UTC+1/+2, so `isoDate` is a day behind between midnight and
 * 01:00/02:00 local. Anything that means "today" to a reader — the date on the
 * brief, the day a deadline falls on — has to use this; `isoDate` stays for
 * date parameters sent to Aula, which are UTC by contract.
 */
export function localIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The ISO week `offset` weeks from `from`. `weekOffset(1)` is next week. */
export function weekOffset(offset: number, from: Date = new Date()): string {
  return isoWeekString(new Date(from.getTime() + offset * 7 * 86_400_000));
}

/** Shared browser-ish UA. EasyIQ SkolePortal's edge tier 302s anything else. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
