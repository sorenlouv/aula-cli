import { describe, expect, test } from 'bun:test';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { fallbackPage } from './compose.ts';
import { doneKeys } from './done.ts';
import type { RankedBrief, RankedSignal } from './types.ts';
import { validatePage } from './validate.ts';

const SOURCE = sourceItem({
  key: 'post:13311009',
  title: 'Skolefoto',
  text: 'Husk at tilmelde jeres barn til skolefoto senest mandag.',
  childNames: ['Alma Eksempelsen'],
  audience: 'institution',
});

const SIGNAL: RankedSignal = {
  id: 'model:0',
  kind: 'action',
  title: 'Tilmeld Alma til skolefoto inden mandag',
  child: 'Alma',
  dueAt: '2026-08-17',
  urgency: 'now',
  quote: 'Husk at tilmelde jeres barn til skolefoto senest mandag.',
  why: null,
  sourceKey: 'post:13311009',
  origin: 'model',
  concernsChild: true,
  score: 100,
  tier: 'act',
  mustShow: true,
  audience: 'institution',
  relevance: 'normal',
  reasons: [],
  source: SOURCE,
  mergedSourceKeys: [],
};

describe('doneKeys', () => {
  test('survives the composer rewording the card', () => {
    // The one thing that must hold: yesterday's tick still matches today's
    // card, however differently the model chose to phrase it.
    const reworded: RankedSignal = {
      ...SIGNAL,
      id: 'model:4',
      title: 'Skolefoto: tilmeld Alma',
      kind: 'deadline',
    };
    expect(doneKeys(reworded)).toEqual(doneKeys(SIGNAL));
  });

  test('is not the signal id, which is only a position', () => {
    expect(doneKeys(SIGNAL)).toEqual(['post:13311009|2026-08-17']);
    expect(doneKeys(SIGNAL).join(' ')).not.toContain('model:0');
  });

  test('covers every source a signal was merged from', () => {
    // The same meeting arrives as an invitation and as a reminder, and which
    // one wins the merge can change between runs.
    const merged: RankedSignal = { ...SIGNAL, mergedSourceKeys: ['thread:88', 'post:91'] };
    expect(doneKeys(merged)).toEqual([
      'post:13311009|2026-08-17',
      'thread:88|2026-08-17',
      'post:91|2026-08-17',
    ]);
    expect(doneKeys(merged).join(' ').split(' ')).toHaveLength(3);
  });

  test('a recurring obligation comes back on its next date', () => {
    const nextWeek: RankedSignal = { ...SIGNAL, dueAt: '2026-08-24' };
    expect(doneKeys(nextWeek)).not.toEqual(doneKeys(SIGNAL));
  });

  test('two obligations from one source on different dates are separable', () => {
    const other: RankedSignal = { ...SIGNAL, id: 'model:1', dueAt: '2026-08-25' };
    expect(doneKeys(other)[0]).not.toBe(doneKeys(SIGNAL)[0]);
  });

  test('an undated obligation still gets a key', () => {
    expect(doneKeys({ ...SIGNAL, dueAt: null })).toEqual(['post:13311009|-']);
  });
});

describe('the rendered page', () => {
  const brief: RankedBrief = {
    input: briefInput({ items: [SOURCE] }),
    signals: [SIGNAL],
    unusedSources: [],
    degraded: [],
  };
  const html = fallbackPage(brief);

  test('every card carries its keys and a tick', () => {
    expect(html).toContain('data-done-keys="post:13311009|2026-08-17"');
    expect(html).toContain('aria-label="Markér som klaret"');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('the sections the script drives are marked up for it', () => {
    expect(html).toContain('data-section="act"');
    expect(html).toContain('<span class="count" data-count>');
    expect(html).toContain('data-done-toggle');
  });

  test('the empty-state sentence is present but hidden while work remains', () => {
    // Ticking off the last card has to reveal something, and the script does
    // not build markup — so it ships hidden rather than being created later.
    expect(html).toContain('data-empty hidden');
  });

  test('a day with nothing to do shows that sentence instead', () => {
    const quiet: RankedBrief = { ...brief, signals: [] };
    const page = fallbackPage(quiet);
    expect(page).toContain('data-empty>');
    expect(page).not.toContain('data-empty hidden');
  });

  test('a card without keys fails the invariant', () => {
    // The renderer cannot currently produce this; the check exists so that a
    // future one cannot ship a dead tick unnoticed.
    const stripped = html.replace(/ data-done-keys="[^"]*"/g, '');
    expect(validatePage(stripped, brief).map((v) => v.rule)).toContain('dismissible');
  });
});
