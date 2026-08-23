/**
 * The dispatcher: configured calendars in, `PersonalEvent[]` out.
 *
 * Claude's Google Calendar connector is the only source, deliberately — one
 * way in is one thing to keep working, and the alternatives each cost a setup
 * step a non-technical user cannot be asked to take. `connector.ts` records
 * which alternatives, and what each one failed on.
 *
 * Failures are per calendar and never thrown onwards: one calendar that cannot
 * be read must not cost the family the other one, and must never look like a
 * fortnight with nothing in it. Every failure comes back as a warning the brief
 * turns into a `Datastatus` line.
 */

import { localIsoDate } from '../integrations/types.ts';
import { errorMessage, parseIsoDateParts } from '../validation.ts';
import { CalendarNotConnectedError, listEvents } from './connector.ts';
import type { CalendarRef, PersonalEvent } from './types.ts';

export { CalendarNotConnectedError, listCalendars } from './connector.ts';
export type { ConnectorCalendar } from './connector.ts';
export type { CalendarRef, PersonalEvent } from './types.ts';

export type CalendarLoad = {
  events: PersonalEvent[];
  /** Danish, one line per calendar that could not be read. */
  warnings: string[];
  /** The connector is not set up. Distinct because it has a cure. */
  notConnected: boolean;
};

/** Personal appointments are deliberately bounded independently of Aula history. */
export const PERSONAL_CALENDAR_DAYS = 14;

/** A local-calendar window; unlike millisecond arithmetic this survives DST. */
export function calendarWindow(now: Date, days = PERSONAL_CALENDAR_DAYS): { from: Date; to: Date } {
  if (!Number.isInteger(days) || days < 1) throw new Error(`Invalid calendar window: ${days}`);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  return { from, to };
}

/**
 * Read every configured calendar over `[from, to)`.
 *
 * Sequential on purpose: each read is a `claude` subprocess, and two of them at
 * once on a laptop that has just woken up buys a couple of seconds at the cost
 * of doubling the memory spike during the one window the scheduler is fighting
 * for.
 */
export async function loadPersonalEvents(
  calendars: CalendarRef[],
  opts: { from: Date; to: Date; timeoutMs?: number },
): Promise<CalendarLoad> {
  const events: PersonalEvent[] = [];
  const warnings: string[] = [];
  let notConnected = false;

  const from = rfc3339(opts.from);
  const to = rfc3339(opts.to);

  for (const calendar of calendars) {
    try {
      const raw = await listEvents(calendar.id, from, to, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const calendarEvents: PersonalEvent[] = [];
      for (const item of raw) {
        const event = toPersonalEvent(item, calendar);
        if (event) calendarEvents.push(event);
      }
      events.push(...calendarEvents);
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) {
        notConnected = true;
        warnings.push(
          'Google Kalender blev ikke læst — forbindelsen til Google Kalender i Claude mangler.',
        );
        // Every other calendar would fail for the same reason, and one line
        // saying so beats the same line once per calendar.
        break;
      }
      warnings.push(`Kalenderen «${calendar.name}» kunne ikke læses: ${errorMessage(err)}`);
    }
  }

  events.sort((a, b) => `${a.date}${a.startTime ?? ''}`.localeCompare(`${b.date}${b.startTime ?? ''}`));
  return { events, warnings, notConnected };
}

// --------------------------------------------------------------- shaping

type TimeRef = { date?: unknown; dateTime?: unknown };

function isRecordish(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One connector event, resolved to local wall-clock.
 *
 * Two shapes come back, and telling them apart is the whole job:
 *
 * - timed — `{ dateTime: "2026-08-26T10:00:00+02:00", timeZone: … }`, a real
 *   instant with a real offset;
 * - all-day — `{ date: "2026-08-25T00:00:00Z" }`, where the `Z` is decoration
 *   on a date and not an instant at all. Parsing it as UTC lands the event on
 *   the 24th in Copenhagen, which is the same bug `localIsoDate` exists to
 *   prevent — so an all-day date is *sliced*, never parsed.
 *
 * Google's all-day end is exclusive (a single day on the 25th ends on the
 * 26th), so it is pulled back a day to give an inclusive `endDate`.
 */
export function toPersonalEvent(raw: unknown, calendar: CalendarRef): PersonalEvent | null {
  if (!isRecordish(raw)) throw new Error(`Kalenderen «${calendar.name}» gav en aftale, der ikke var et objekt.`);
  // A cancelled occurrence of a repeating appointment still comes back; it is
  // not something anybody has to be anywhere for.
  if (raw.status === 'cancelled') return null;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null;
  if (!id) throw new Error(`Kalenderen «${calendar.name}» gav en aftale uden id.`);

  const start = isRecordish(raw.start) ? (raw.start as TimeRef) : null;
  const end = isRecordish(raw.end) ? (raw.end as TimeRef) : null;
  if (!start || !end) throw new Error(`Aftalen ${id} i «${calendar.name}» mangler start eller slut.`);

  const title = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : '(uden titel)';
  const allDay = typeof start.dateTime !== 'string';

  let date: string;
  let endDate: string;
  let startTime: string | null = null;
  let endTime: string | null = null;

  if (allDay) {
    date = connectorDay(start.date, `start på aftalen ${id}`);
    endDate = previousDay(connectorDay(end.date, `slut på aftalen ${id}`));
    if (endDate < date) endDate = date;
  } else {
    const startAt = new Date(String(start.dateTime));
    if (Number.isNaN(startAt.getTime())) throw new Error(`Aftalen ${id} har en ugyldig start.`);
    date = localIsoDate(startAt);
    startTime = localTime(startAt);
    if (typeof end.dateTime !== 'string') throw new Error(`Aftalen ${id} mangler et sluttidspunkt.`);
    const endAt = new Date(end.dateTime);
    if (Number.isNaN(endAt.getTime()) || endAt < startAt) {
      throw new Error(`Aftalen ${id} har en ugyldig slutning.`);
    }
    endDate = localIsoDate(endAt);
    endTime = localTime(endAt);
  }

  return {
    key: keyOf(raw, calendar, start),
    calendarId: calendar.id,
    calendarName: calendar.name,
    title,
    date,
    endDate,
    startTime,
    endTime,
    allDay,
    location: typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : null,
    url: typeof raw.htmlLink === 'string' ? raw.htmlLink : null,
  };
}

/**
 * Identity, not state — see `PersonalEvent.key`.
 *
 * `recurringEventId` names the series and `originalStartTime` the occurrence's
 * *scheduled* slot, so an appointment that gets moved keeps the key it had
 * yesterday rather than arriving as a cancellation and a new thing. A one-off
 * event has neither and uses its own id.
 */
function keyOf(raw: Record<string, unknown>, calendar: CalendarRef, start: TimeRef): string {
  const series = typeof raw.recurringEventId === 'string' ? raw.recurringEventId : String(raw.id);
  const original = isRecordish(raw.originalStartTime) ? (raw.originalStartTime as TimeRef) : start;
  const slot = String(original.dateTime ?? original.date ?? start.dateTime ?? start.date ?? '');
  if (!slot) throw new Error(`Aftalen ${String(raw.id)} mangler et tidspunkt til sin nøgle.`);
  return `cal:${calendar.id}:${series}:${slot}`;
}

function connectorDay(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} mangler en dato.`);
  const day = value.slice(0, 10);
  if (!parseIsoDateParts(day)) throw new Error(`${where} har en ugyldig dato.`);
  return day;
}

function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function previousDay(iso: string): string {
  const at = new Date(`${iso}T12:00:00`);
  at.setDate(at.getDate() - 1);
  return localIsoDate(at);
}

/** `2026-08-22T00:00:00+02:00` — local midnight, with the offset spelled out. */
export function rfc3339(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${localIsoDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}
