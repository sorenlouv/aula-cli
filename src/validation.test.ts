import { describe, expect, test } from 'bun:test';
import {
  errorMessage,
  isIsoWeek,
  isRecord,
  isValidCalendarDate,
  parseInteger,
  parseIsoDateParts,
} from './validation.ts';

describe('runtime validation', () => {
  test('records exclude null, arrays and primitives', () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('object-ish')).toBe(false);
  });

  test('unknown thrown values still have a useful message', () => {
    expect(errorMessage(new Error('broken'))).toBe('broken');
    expect(errorMessage('broken')).toBe('broken');
    expect(errorMessage(null)).toBe('null');
  });

  test('ISO dates reject rollover and non-canonical input', () => {
    expect(parseIsoDateParts('2028-02-29')).toMatchObject({ month: 2, day: 29 });
    expect(parseIsoDateParts('2026-02-29')).toBeNull();
    expect(parseIsoDateParts('2026-02-31')).toBeNull();
    expect(parseIsoDateParts('2026-2-03')).toBeNull();
    expect(isValidCalendarDate(2026, 4, 31)).toBe(false);
  });

  test('integers are exact, safe and range checked', () => {
    expect(parseInteger('12', { min: 1 })).toBe(12);
    expect(parseInteger('1.5', { min: 1 })).toBeUndefined();
    expect(parseInteger('-1', { min: 0 })).toBeUndefined();
    expect(parseInteger('4', { min: 1, max: 3 })).toBeUndefined();
  });

  test('ISO weeks reject impossible weeks', () => {
    expect(isIsoWeek('2026-W33')).toBe(true);
    expect(isIsoWeek('2026-W01')).toBe(true);
    expect(isIsoWeek('2026-W00')).toBe(false);
    expect(isIsoWeek('2025-W53')).toBe(false);
    expect(isIsoWeek('2026-W53')).toBe(true);
    expect(isIsoWeek('2020-W53')).toBe(true);
    expect(isIsoWeek('2026-W3')).toBe(false);
  });
});
