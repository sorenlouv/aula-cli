import { describe, expect, test } from 'bun:test';
import {
  describeShape,
  errorMessage,
  expectOptionalType,
  expectType,
  isArrayOf,
  isIsoWeek,
  isOptional,
  isRecord,
  isString,
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

  /**
   * JSON has no `undefined`: a backend that omits an optional field and one
   * that writes `null` mean the same thing. Accepting only `undefined` made a
   * single null-valued field reject the whole payload it arrived in.
   */
  test('optional means absent, and null is a spelling of absent', () => {
    expect(isOptional(undefined, isString)).toBe(true);
    expect(isOptional(null, isString)).toBe(true);
    expect(isOptional('present', isString)).toBe(true);
    expect(isOptional(42, isString)).toBe(false);
  });

  test('one null field does not reject the record it sits in', () => {
    const isRow = (value: unknown): value is { a?: string; b?: string } =>
      isRecord(value) && isOptional(value.a, isString) && isOptional(value.b, isString);
    expect(isArrayOf([{ a: 'x', b: null }, { a: null }], isRow)).toBe(true);
    expect(isArrayOf([{ a: 'x' }, { a: 7 }], isRow)).toBe(false);
  });

  test('a nullish payload decodes to the empty value, a wrong one still throws', () => {
    const isNames = (value: unknown): value is string[] => isArrayOf(value, isString);
    expect(expectOptionalType(null, isNames, 'a name list', [])).toEqual([]);
    expect(expectOptionalType(undefined, isNames, 'a name list', [])).toEqual([]);
    expect(expectOptionalType(['a'], isNames, 'a name list', [])).toEqual(['a']);
    expect(() => expectOptionalType(42, isNames, 'a name list', [])).toThrow('Expected a name list');
  });

  /**
   * A boundary error naming only what was expected cannot tell a vendor outage
   * from a shape change, so what arrived has to survive into the message —
   * summarised, since the payload is the family's own data.
   */
  test('a decode failure says what arrived, not just what was wanted', () => {
    const isNames = (value: unknown): value is string[] => isArrayOf(value, isString);
    expect(() => expectType(null, isNames, 'a name list')).toThrow('Expected a name list, got null');
    expect(() => expectType({ Children: 1 }, isNames, 'a name list')).toThrow(
      'Expected a name list, got {Children: number}',
    );
    // The shape, never the values — these payloads carry salts and signatures.
    expect(describeShape({ token: 'hemmelig' })).not.toContain('hemmelig');
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

/**
 * JSON has no `undefined`. A parsed payload produces it only from a key that
 * is not there; an optional field the server sends but leaves empty arrives as
 * `null`. Treating those as different is what broke the MitID login flow — see
 * the CAP008 case in vendor/aula-auth/mitid-client.test.ts.
 */
describe('isOptional', () => {
  test('accepts an absent field', () => {
    expect(isOptional(undefined, isString)).toBe(true);
  });

  test('accepts a field that is present and null', () => {
    expect(isOptional(null, isString)).toBe(true);
  });

  test('accepts a matching value', () => {
    expect(isOptional('x', isString)).toBe(true);
  });

  test('still refuses a value of the wrong type', () => {
    expect(isOptional(42, isString)).toBe(false);
    expect(isOptional({}, isString)).toBe(false);
  });
});

describe('describeShape', () => {
  test('reports types and never values', () => {
    const shape = describeShape({ token: 'super-secret', count: 3, ok: true });
    expect(shape).toBe('{token: string, count: number, ok: boolean}');
    expect(shape).not.toContain('super-secret');
  });

  // The distinction the MitID failure turned on: a field that is present and
  // empty reads differently from one that is not there.
  test('distinguishes null from undefined', () => {
    expect(describeShape({ a: null, b: undefined })).toBe('{a: null, b: undefined}');
  });

  test('summarises arrays by their first element', () => {
    expect(describeShape([{ id: 'x' }, { id: 'y' }])).toBe('[{id: string}, …×2]');
    expect(describeShape([])).toBe('[]');
  });

  test('stops descending rather than dumping a whole payload', () => {
    expect(describeShape({ a: { b: { c: { d: 1 } } } })).toBe('{a: {b: {…}}}');
  });

  test('elides once there are more keys than fit on a line', () => {
    const wide = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 1]));
    expect(describeShape(wide)).toContain('…+3 more');
  });
});
