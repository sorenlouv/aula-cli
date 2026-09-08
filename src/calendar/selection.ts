/**
 * Stable calendar selection at the CLI boundary.
 *
 * A displayed position is not an identity: `list_calendars` is a live read, so
 * position 2 may name something else on the next invocation. The agent passes
 * the exact displayed name instead. Names that are not unique are refused and
 * the connector ids are shown as the unambiguous fallback.
 */

import type { ConnectorCalendar } from './connector.ts';
import type { CalendarRef } from './types.ts';
import { cmd } from '../runtime.ts';

export type CalendarChoice = CalendarRef & {
  selected: boolean;
  accessRole?: string;
};

export class CalendarSelectionError extends Error {
  override readonly name = 'CalendarSelectionError';
}

/** Selected calendars first, followed by everything else the connector sees. */
export function calendarChoices(
  configured: CalendarRef[],
  available: ConnectorCalendar[],
): CalendarChoice[] {
  const byId = new Map(available.map((calendar) => [calendar.id, calendar]));
  const selected: CalendarChoice[] = configured.map((calendar) => {
    const current = byId.get(calendar.id);
    return {
      id: calendar.id,
      name: current?.summary ?? calendar.name,
      selected: true,
      ...(current?.accessRole ? { accessRole: current.accessRole } : {}),
    };
  });
  const selectedIds = new Set(configured.map((calendar) => calendar.id));
  const rest: CalendarChoice[] = available
    .filter((calendar) => !selectedIds.has(calendar.id))
    .map((calendar) => ({
      id: calendar.id,
      name: calendar.summary,
      selected: false,
      ...(calendar.accessRole ? { accessRole: calendar.accessRole } : {}),
    }));
  return [...selected, ...rest];
}

/**
 * Which calendars a written reference names.
 *
 * Exact first — an exact name or id always wins outright, so a calendar
 * literally called `Privat` can never be taken from a calendar called `privat`.
 * Only when nothing matches exactly does it fall back to a trimmed,
 * case-insensitive comparison, and that fallback is still refused when it hits
 * more than one.
 *
 * The fallback exists because the caller is usually an agent copying a name
 * out of a checkbox question it wrote for a parent, and the round trip through
 * a person is where case and whitespace get lost. Refusing `"privat"` for
 * `"Privat"` taught nobody anything: it read as "that calendar does not exist"
 * about a calendar sitting in the list directly above.
 */
function matchesFor(choices: CalendarChoice[], ref: string): CalendarChoice[] {
  const exact = choices.filter((calendar) => calendar.id === ref || calendar.name === ref);
  if (exact.length > 0) return exact;
  const loose = ref.trim().toLocaleLowerCase();
  if (loose.length === 0) return [];
  return choices.filter(
    (calendar) =>
      calendar.id.trim().toLocaleLowerCase() === loose ||
      calendar.name.trim().toLocaleLowerCase() === loose,
  );
}

/** Resolve exact displayed names or connector ids; never positions. */
export function resolveCalendarSelection(
  choices: CalendarChoice[],
  refs: string[],
): CalendarChoice[] {
  const selected: CalendarChoice[] = [];
  for (const ref of refs) {
    const matches = matchesFor(choices, ref);
    if (matches.length === 0) {
      throw new CalendarSelectionError(
        `No calendar named "${ref}". Run \`${cmd('calendars')}\` and use an exact displayed name.`,
      );
    }
    if (matches.length > 1) {
      throw new CalendarSelectionError(
        `More than one calendar matches "${ref}". Use one of these exact ids: ` +
          matches.map((calendar) => calendar.id).join(', '),
      );
    }
    const calendar = matches[0]!;
    if (!selected.some((existing) => existing.id === calendar.id)) selected.push(calendar);
  }
  return selected;
}

/** Resolve saved ids offline. Names need a live list to expose all collisions. */
export function resolveConfiguredSelection(
  configured: CalendarRef[],
  refs: string[],
): CalendarChoice[] | null {
  const configuredIds = new Set(configured.map((calendar) => calendar.id));
  if (!refs.every((ref) => configuredIds.has(ref))) return null;
  try {
    return resolveCalendarSelection(
      configured.map((calendar) => ({ ...calendar, selected: true })),
      refs,
    );
  } catch {
    return null;
  }
}
