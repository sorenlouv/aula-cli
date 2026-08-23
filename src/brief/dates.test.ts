import { describe, expect, test } from 'bun:test';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import {
  buildDateSupport,
  dueAtSupported,
  findDateClaims,
  unsupportedDateClaims,
} from './dates.ts';
import type { BriefInput, SourceItem } from './types.ts';

const item = (
  key: string,
  text: string,
  at: string | null = '2026-08-10T11:00:00+00:00',
): SourceItem => sourceItem({ key, text, at });

// 2026-08-13 is a Thursday; 2026-08-10 (the default item timestamp) a Monday.
const input = (items: SourceItem[]): BriefInput => briefInput({ items });

describe('findDateClaims', () => {
  test('finds weekdays through Danish inflections', () => {
    const days = findDateClaims(
      'Idræt om torsdagen, løb hver mandag, og tirsdage er turdage; fredags plan.',
    )
      .filter((c) => c.kind === 'weekday')
      .map((c) => (c.kind === 'weekday' ? c.day : -1));
    expect(days).toEqual([4, 1, 2, 5]);
  });

  test('finds numeric and written dates and week numbers', () => {
    const claims = findDateClaims('Foto 25/8, møde d. 26. august, fest 9.9, alt i uge 35.');
    expect(claims).toContainEqual({ kind: 'date', month: 8, day: 25, raw: '25/8' });
    expect(claims).toContainEqual({ kind: 'date', month: 8, day: 26, raw: '26. august' });
    expect(claims).toContainEqual({ kind: 'date', month: 9, day: 9, raw: '9.9' });
    expect(claims).toContainEqual({ kind: 'week', week: 35, raw: 'uge 35' });
  });

  test('reads abbreviated months and range starts', () => {
    const claims = findDateClaims(
      'Mødet er fredag d. 18 sep kl 13-14. Fotografering 24.-28. august.',
    );
    expect(claims).toContainEqual({ kind: 'date', month: 9, day: 18, raw: '18 sep' });
    expect(claims).toContainEqual({ kind: 'date', month: 8, day: 28, raw: '28. august' });
    expect(claims.some((c) => c.kind === 'date' && c.month === 8 && c.day === 24)).toBe(true);
  });

  test('does not mistake clock times for dates', () => {
    expect(findDateClaims('Vi mødes kl. 17.30 og slutter 19.45.')).toEqual([]);
    expect(findDateClaims('Hallen er åben kl. 9.05.')).toEqual([]);
  });

  test('does not treat impossible calendar dates as evidence', () => {
    expect(findDateClaims('Møde 31/2 og tur 31. april.')).toEqual([]);
    expect(findDateClaims('Skuddag 29/2.')).toContainEqual({
      kind: 'date',
      month: 2,
      day: 29,
      raw: '29/2',
    });
  });
});

describe('buildDateSupport', () => {
  test('collects today, source texts, source timestamps and the iso week', () => {
    const s = buildDateSupport(input([item('post:1', 'Løbedag på mandag. Fest 9/9.')]));
    expect(s.weekdays.has(4)).toBe(true); // today, Thursday
    expect(s.weekdays.has(1)).toBe(true); // "mandag" + the timestamp
    expect(s.dates.has('2026-08-13')).toBe(true); // today
    expect(s.dates.has('2026-08-10')).toBe(true); // the timestamp
    expect(s.dates.has('2026-09-09')).toBe(true); // from the text
    expect(s.weeks.has(33)).toBe(true);
  });

  test('an interval end is grounded for the same source', () => {
    const source = sourceItem({
      key: 'cal:family:holiday',
      kind: 'personal',
      text: 'Ferie · hele dagen 25/8–27/8',
      at: '2026-08-25T00:00:00',
      endsAt: '2026-08-27T23:59:00',
    });
    const support = buildDateSupport(input([source]));
    expect(support.perSource.get(source.key)?.dates.has('2026-08-27')).toBe(true);
  });
});

describe('unsupportedDateClaims', () => {
  const s = buildDateSupport(input([item('post:1', 'Foto i uge 35. Aflever sedlen på mandag.')]));

  test('accepts what the sources say and flags what they do not', () => {
    expect(unsupportedDateClaims('Sedlen skal med på mandag i uge 35.', s)).toEqual([]);
    expect(unsupportedDateClaims('Aflever senest søndag den 24/9.', s)).toEqual(['søndag', '24/9']);
  });

  test('a claim may echo its own validated date', () => {
    // 2026-08-21 is a Friday; no source mentions fredag or 21/8.
    expect(unsupportedDateClaims('Frist fredag 21/8.', s)).toEqual(['fredag', '21/8']);
    expect(unsupportedDateClaims('Frist fredag 21/8.', s, { dueAt: '2026-08-21' })).toEqual([]);
  });

  test('with a sourceKey, a bare weekday must come from that source', () => {
    const multi = buildDateSupport(
      input([item('post:1', 'Husk turtasken.'), item('post:2', 'Vi løber hver søndag.')]),
    );
    // "søndag" exists globally (post:2) but not in post:1 — and dates stay global.
    expect(unsupportedDateClaims('Aflever senest søndag', multi, { sourceKey: 'post:1' })).toEqual([
      'søndag',
    ]);
    expect(unsupportedDateClaims('Aflever senest søndag', multi, { sourceKey: 'post:2' })).toEqual(
      [],
    );
    expect(
      unsupportedDateClaims('Kolliderer med festen 10/8', multi, { sourceKey: 'post:1' }),
    ).toEqual([]);
    // Today's weekday (torsdag) is visible to every card.
    expect(unsupportedDateClaims('Idræt i dag, torsdag', multi, { sourceKey: 'post:1' })).toEqual(
      [],
    );
  });
});

describe('dueAtSupported', () => {
  test('an explicit date in the claim’s own source grounds it', () => {
    const s = buildDateSupport(input([item('post:1', 'Forældremøde 26/8 kl. 17.')]));
    expect(dueAtSupported('2026-08-26', 'post:1', s)).toBe(true);
  });

  test('a date from another source does not ground it', () => {
    const s = buildDateSupport(
      input([item('post:1', 'Husk turtasken.'), item('post:2', 'Skolefoto 25/8.')]),
    );
    expect(dueAtSupported('2026-08-25', 'post:1', s)).toBe(false);
  });

  test('a weekday in the claim’s own source grounds a date inside the window', () => {
    const s = buildDateSupport(input([item('post:1', 'Vi løber hver fredag.')]));
    expect(dueAtSupported('2026-08-14', 'post:1', s)).toBe(true); // next Friday
    expect(dueAtSupported('2026-10-02', 'post:1', s)).toBe(false); // a Friday far outside the window
  });

  test('a weekday from another source does not ground it', () => {
    const s = buildDateSupport(
      input([item('post:1', 'Ingen datoer her.'), item('post:2', 'Vi løber hver fredag.')]),
    );
    expect(dueAtSupported('2026-08-14', 'post:1', s)).toBe(false);
  });

  test('"i morgen" is resolved from the day the source was written', () => {
    const s = buildDateSupport(input([item('post:1', 'I morgen holder vi løbedag.')]));
    expect(dueAtSupported('2026-08-11', 'post:1', s)).toBe(true);
    expect(dueAtSupported('2026-08-14', 'post:1', s)).toBe(false);
  });

  test('a source timestamp cannot license the same month and day in another year', () => {
    const s = buildDateSupport(input([item('post:1', 'Skrevet uden en dato i teksten.')]));
    expect(dueAtSupported('2030-08-10', 'post:1', s)).toBe(false);
  });

  test('a source-backed date must stay inside fetched history through one year ahead', () => {
    const s = buildDateSupport(
      input([
        item('post:old', 'Skrevet uden en dato i teksten.', '2026-07-29T11:00:00+00:00'),
        item('post:future', 'Arrangement 14. august 2027.'),
      ]),
    );
    expect(dueAtSupported('2026-07-29', 'post:old', s)).toBe(false);
    expect(dueAtSupported('2027-08-14', 'post:future', s)).toBe(false);
  });

  test('an ungrounded date fails', () => {
    const s = buildDateSupport(input([item('post:1', 'Husk turtasken.')]));
    expect(dueAtSupported('2026-08-24', 'post:1', s)).toBe(false);
  });

  test('an impossible ISO date always fails', () => {
    const s = buildDateSupport(input([item('post:1', 'Frist 31/2.')]));
    expect(dueAtSupported('2026-02-31', 'post:1', s)).toBe(false);
  });
});
