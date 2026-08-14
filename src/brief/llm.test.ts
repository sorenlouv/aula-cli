import { describe, expect, test } from 'bun:test';
import { parseJsonLoosely, validateExtraction } from './llm.ts';
import type { BriefInput, SourceItem } from './types.ts';

const SOURCE: SourceItem = {
  key: 'post:1',
  kind: 'post',
  title: 'Myretuens løbedag',
  text: 'Kære alle.\n\nI morgen holder vi løbedag, og børnene må meget gerne have løbetøj og sko med, de kan løbe i!',
  at: '2026-08-10T11:42:00+00:00',
  author: 'Palle',
  authorRole: 'employee',
  groups: ['Myretuen'],
  childNames: ['Viggo Emil Eksempelsen'],
  audience: 'class',
  important: false,
  url: null,
  attachments: [],
};

const INPUT: BriefInput = {
  generatedAt: '2026-08-13T06:30:00Z',
  today: '2026-08-13',
  isoWeek: '2026-W33',
  windowDays: 14,
  family: {
    guardian: 'Mikkel',
    children: [
      { name: 'Viggo Emil Eksempelsen', firstName: 'Viggo', institution: 'Eksemplet', className: 'Myretuen', presence: null },
    ],
    isSteppedUp: true,
  },
  items: [SOURCE],
  health: [],
  albums: [],
  notificationCount: 0,
  newMediaCount: 0,
};

const good = {
  kind: 'bring',
  title: 'Løbetøj med på mandag',
  child: 'Viggo',
  dueAt: '2026-08-17',
  urgency: 'week',
  quote: 'have løbetøj og sko med',
  why: 'Fast ugentlig løbedag',
  sourceKey: 'post:1',
};

describe('parseJsonLoosely', () => {
  test('accepts a bare object, a fenced block, and prose around it', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('Her er svaret:\n{"a":1}\nHåber det hjælper.')).toEqual({ a: 1 });
  });

  test('throws when there is no object at all', () => {
    expect(() => parseJsonLoosely('beklager, det kan jeg ikke')).toThrow();
  });
});

describe('validateExtraction', () => {
  test('keeps a well-formed signal', () => {
    const result = validateExtraction(INPUT, { topline: 'Rolig uge.', signals: [good] });
    expect(result.problems).toEqual([]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.origin).toBe('model');
    expect(result.topline).toBe('Rolig uge.');
  });

  test('drops a signal whose quote is not literally in the source', () => {
    // The whole point: a plausible sentence the teacher never wrote.
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, quote: 'Husk gummistøvler og regntøj på fredag' }],
    });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? "").toContain('ordret');
  });

  test('tolerates whitespace differences in an otherwise literal quote', () => {
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, quote: 'have  løbetøj og sko\nmed' }],
    });
    expect(result.signals).toHaveLength(1);
  });

  test('drops a signal citing a source that was never supplied', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, sourceKey: 'post:999' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? "").toContain('ukendt sourceKey');
  });

  test('drops an unparseable date rather than guessing', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, dueAt: 'på mandag' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? "").toContain('ikke en dato');
  });

  test('ignores a child name that is not one of ours', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, child: 'Emil' }] });
    expect(result.signals[0]?.child).toBeNull();
  });

  test('falls back to safe values for unknown kind and urgency', () => {
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, kind: 'panik', urgency: 'straks' }],
    });
    expect(result.signals[0]?.kind).toBe('info');
    expect(result.signals[0]?.urgency).toBe('later');
  });

  test('keeps only child summaries for real children', () => {
    const result = validateExtraction(INPUT, {
      signals: [],
      childSummaries: { Viggo: 'Har løbedag om mandagen.', Ukendt: 'Findes ikke.' },
    });
    expect(Object.keys(result.childSummaries)).toEqual(['Viggo']);
  });

  test('survives complete rubbish without throwing', () => {
    expect(validateExtraction(INPUT, null).signals).toEqual([]);
    expect(validateExtraction(INPUT, { signals: 'nope' }).signals).toEqual([]);
    expect(validateExtraction(INPUT, { signals: [null] }).signals).toEqual([]);
  });
});
