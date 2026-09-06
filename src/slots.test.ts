import { describe, expect, test } from 'bun:test';
import {
  clock,
  currentSlotStart,
  DEFAULT_SLOTS,
  formatSlots,
  nextSlotStart,
  parseSlots,
  SlotFormatError,
  sortSlots,
} from './slots.ts';

describe('parseSlots', () => {
  test('nothing means morning and evening', () => {
    expect(parseSlots(undefined)).toEqual(DEFAULT_SLOTS);
    expect(parseSlots('')).toEqual(DEFAULT_SLOTS);
    expect(formatSlots(DEFAULT_SLOTS)).toBe('06:00, 18:00');
  });

  test('one time or several, with or without a leading zero', () => {
    expect(parseSlots('7:05')).toEqual([{ hour: 7, minute: 5 }]);
    expect(parseSlots('06:00, 18:00')).toEqual([
      { hour: 6, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
  });

  test('sorted and deduplicated, so the file cannot hold one time twice', () => {
    expect(parseSlots('18:00,06:00,6:00')).toEqual([
      { hour: 6, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
  });

  test('rejects what a clock cannot show, naming the part that was wrong', () => {
    for (const bad of ['25:00', '06:60', 'kl-syv', '6.30', '630']) {
      expect(() => parseSlots(bad)).toThrow(SlotFormatError);
    }
    expect(() => parseSlots('06:00,25:00')).toThrow(/"25:00"/);
  });
});

describe('currentSlotStart', () => {
  const slots = DEFAULT_SLOTS;
  const at = (hour: number, minute = 0) => new Date(2026, 8, 6, hour, minute);

  test('the most recent slot to have begun', () => {
    expect(currentSlotStart(at(6, 0), slots)).toEqual(new Date(2026, 8, 6, 6, 0));
    expect(currentSlotStart(at(11, 59), slots)).toEqual(new Date(2026, 8, 6, 6, 0));
    expect(currentSlotStart(at(18, 0), slots)).toEqual(new Date(2026, 8, 6, 18, 0));
    expect(currentSlotStart(at(23, 59), slots)).toEqual(new Date(2026, 8, 6, 18, 0));
  });

  /**
   * The half-open interval is the whole point: every instant belongs to some
   * slot. Two in the morning is the previous evening's brief still standing,
   * not a gap where nothing is owed and nothing is current.
   */
  test('before the first slot the answer is yesterday evening', () => {
    expect(currentSlotStart(at(2, 0), slots)).toEqual(new Date(2026, 8, 5, 18, 0));
  });

  test('crossing a month boundary walks back a real day, not 24 hours', () => {
    expect(currentSlotStart(new Date(2026, 8, 1, 3, 0), slots)).toEqual(
      new Date(2026, 7, 31, 18, 0),
    );
  });

  /**
   * The Sunday Denmark returns to standard time is 25 hours long. Subtracting
   * 86_400_000 from midnight lands at 23:00 the previous evening and would
   * place the slot an hour out; the calendar-field constructor does not.
   */
  test('the evening slot is 18:00 even on the day the clocks change', () => {
    const dstMorning = new Date(2026, 9, 25, 3, 0);
    const previous = currentSlotStart(dstMorning, slots);
    expect(previous.getHours()).toBe(18);
    expect(previous.getDate()).toBe(24);
  });

  test('a single-slot schedule still covers the whole day', () => {
    const only = [{ hour: 6, minute: 30 }];
    expect(currentSlotStart(at(23, 0), only)).toEqual(new Date(2026, 8, 6, 6, 30));
    expect(currentSlotStart(at(1, 0), only)).toEqual(new Date(2026, 8, 5, 6, 30));
  });
});

describe('nextSlotStart', () => {
  test('the slot after this one, wrapping to tomorrow morning', () => {
    expect(nextSlotStart(new Date(2026, 8, 6, 7, 0))).toEqual(new Date(2026, 8, 6, 18, 0));
    expect(nextSlotStart(new Date(2026, 8, 6, 19, 0))).toEqual(new Date(2026, 8, 7, 6, 0));
  });

  test('every slot start is where the previous slot ends — no gaps, no overlap', () => {
    const now = new Date(2026, 8, 6, 9, 0);
    const next = nextSlotStart(now);
    expect(currentSlotStart(next).getTime()).toBe(next.getTime());
    expect(currentSlotStart(new Date(next.getTime() - 60_000)).getTime()).toBe(
      currentSlotStart(now).getTime(),
    );
  });
});

describe('formatting', () => {
  test('zero-padded, in the order the day runs', () => {
    expect(clock({ hour: 6, minute: 5 })).toBe('06:05');
    expect(formatSlots([{ hour: 18, minute: 0 }, ...DEFAULT_SLOTS])).toBe('06:00, 18:00');
    expect(
      sortSlots([
        { hour: 18, minute: 0 },
        { hour: 6, minute: 0 },
      ]),
    ).toEqual(DEFAULT_SLOTS);
  });
});
