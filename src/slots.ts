/**
 * When the overview is due, and which of those moments the clock is in now.
 *
 * The schedule used to be one time a day and the ledger recorded one boolean a
 * day, so "is there anything to do" and "has today's run happened" were the
 * same question. Two runs a day separates them: at 18:00 the morning's
 * `complete` is still true and still says nothing about the evening.
 *
 * A *slot* is one of the configured times. The slot that is current at any
 * moment began at the most recent of those times — 06:00 from six in the
 * morning until six in the evening, 18:00 from then until six the next
 * morning. That is deliberately a half-open interval with no gaps: every
 * instant belongs to exactly one slot, so a laptop opened at 14:00 has a slot
 * to ask about rather than falling between two triggers.
 *
 * Everything here is local time, and constructed through the `Date(y, m, d,
 * h, m)` form rather than by subtracting 86_400_000 from a timestamp. The two
 * differ twice a year: on the days Denmark changes clocks a day is 23 or 25
 * hours long, and the arithmetic version would place the previous evening's
 * slot an hour off.
 */

export type Slot = { hour: number; minute: number };

/**
 * Morning and evening.
 *
 * The morning slot is what the family reads over breakfast. The evening one
 * exists because most of what a school sends arrives during the working day,
 * and a brief written at dawn has already missed it by the time anyone is
 * home to act on it.
 */
export const DEFAULT_SLOTS: [Slot, ...Slot[]] = [
  { hour: 6, minute: 0 },
  { hour: 18, minute: 0 },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** `{ hour: 6, minute: 0 }` as `06:00`. */
export const clock = (slot: Slot) => `${pad(slot.hour)}:${pad(slot.minute)}`;

const minutesOf = (slot: Slot) => slot.hour * 60 + slot.minute;

/** Ascending, with duplicates dropped — the order the day runs in. */
export function sortSlots(slots: Slot[]): Slot[] {
  const byMinute = new Map(slots.map((slot) => [minutesOf(slot), slot]));
  return [...byMinute.values()].sort((a, b) => minutesOf(a) - minutesOf(b));
}

/** `06:00, 18:00` — for a message a person reads. */
export const formatSlots = (slots: Slot[]) => sortSlots(slots).map(clock).join(', ');

export class SlotFormatError extends Error {
  override readonly name = 'SlotFormatError';
}

/**
 * `06:00,18:00` into slots. An empty or absent value means the default pair.
 *
 * Throws rather than falling back, because the two callers want opposite
 * things from a bad value: `--at` should tell the user their argument is
 * wrong, while a corrupt config file should say which file to fix. Each
 * wraps this in its own error type.
 */
export function parseSlots(raw: string | undefined): Slot[] {
  const value = raw?.trim();
  if (!value) return DEFAULT_SLOTS;
  const slots = value.split(',').map((part) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(part.trim());
    const hour = Number(match?.[1]);
    const minute = Number(match?.[2]);
    if (!match || hour > 23 || minute > 59) {
      throw new SlotFormatError(`"${part.trim()}" is not a 24h clock time like 06:00`);
    }
    return { hour, minute };
  });
  return sortSlots(slots);
}

/**
 * Every configured time, in order, guaranteed non-empty.
 *
 * An empty list would leave the clock in no slot at all, and the scheduled run
 * would then have nothing to ask about and would quietly stop generating
 * anything — a schedule that removes itself. The default pair stands in.
 */
function usable(slots: Slot[]): [Slot, ...Slot[]] {
  const [first, ...rest] = sortSlots(slots);
  return first ? [first, ...rest] : DEFAULT_SLOTS;
}

/** The same wall-clock time, `dayOffset` days away. Calendar fields, so DST holds. */
function on(now: Date, dayOffset: number, slot: Slot): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    slot.hour,
    slot.minute,
    0,
    0,
  );
}

/**
 * The start of the slot that `now` falls in.
 *
 * Before the first slot of the day the answer is yesterday's last one, which
 * is what makes 02:00 belong to the previous evening's brief rather than to
 * nothing.
 */
export function currentSlotStart(now: Date, slots: Slot[] = DEFAULT_SLOTS): Date {
  const sorted = usable(slots);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const started = sorted.findLast((slot) => minutesOf(slot) <= nowMinutes);
  return started ? on(now, 0, started) : on(now, -1, sorted.at(-1) ?? sorted[0]);
}

/** The start of the slot after the one `now` is in — when this one stops mattering. */
export function nextSlotStart(now: Date, slots: Slot[] = DEFAULT_SLOTS): Date {
  const sorted = usable(slots);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const upcoming = sorted.find((slot) => minutesOf(slot) > nowMinutes);
  return upcoming ? on(now, 0, upcoming) : on(now, 1, sorted[0]);
}
