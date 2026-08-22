/**
 * The family's own appointments, and where they land on a child's day.
 *
 * Nothing in this module comes from Aula. It is the one part of the brief that
 * reads something the family wrote themselves, which is why it lives beside
 * `src/integrations/` rather than inside it: same job — normalise a hostile
 * external source into one shape — but a different kind of source, and one the
 * user has to ask for before it is read at all.
 *
 * **Everything here is local wall-clock time**, deliberately. What the reader
 * needs from an appointment is the time on the kitchen clock, sitting next to
 * the school's own events for the same day. Resolving to instants and back
 * would add a conversion whose only purpose is to be got wrong twice a year.
 */

/** One calendar the family has asked to be read. Identity, not state. */
export type CalendarRef = {
  /** Google's own id — `far@eksempel.dk`, or a long `…@group.calendar.google.com`. */
  id: string;
  /** What the user calls it. Shown; never matched on. */
  name: string;
};

/**
 * One appointment, resolved to a single occurrence.
 *
 * A repeating appointment arrives here as one `PersonalEvent` per occurrence —
 * the connector expands series itself, so there is no recurrence rule to
 * evaluate and no DST arithmetic of our own.
 */
export type PersonalEvent = {
  /**
   * `cal:<calendarId>:<series-or-event-id>:<occurrence-start>`.
   *
   * Identity, not state: the same appointment keeps this key from one morning
   * to the next, which is what the `NY` markers and the ticking-off state in
   * `brief/state.ts` are keyed on. The occurrence start is the *scheduled*
   * slot, so an appointment that gets moved keeps its identity instead of
   * arriving as a cancellation plus a new thing.
   */
  key: string;
  calendarName: string;
  title: string;
  /** Local day it starts on, `YYYY-MM-DD`. */
  date: string;
  /** Local day it ends on, inclusive — an all-day event may span several. */
  endDate: string;
  /** `HH:MM` local. Null for an all-day event, and only then. */
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
};
