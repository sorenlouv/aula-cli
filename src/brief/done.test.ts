import { describe, expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { doneKeys } from './done.ts';
import { renderPage } from './render.ts';
import { validatePage } from './validate.ts';

const SOURCE = sourceItem({
  key: 'post:13311009',
  title: 'Skolefoto',
  text: 'Husk at tilmelde jeres barn til skolefoto senest mandag 17/8.',
  at: '2026-08-12T09:00:00',
  childNames: ['Alma Eksempelsen'],
  audience: 'institution',
});

const CARD = card({
  id: 'model:0',
  title: 'Tilmeld Alma til skolefoto inden mandag',
  summary: 'Tilmeldingen skal være på plads senest mandag.',
  children: ['Alma'],
  date: '2026-08-17',
  needsAction: true,
  sourceKeys: ['post:13311009'],
});

describe('doneKeys', () => {
  test('survives the model rewording the card', () => {
    // The one thing that must hold: yesterday's tick still matches today's
    // card, however differently the model chose to phrase it.
    const reworded = { ...CARD, id: 'model:4', title: 'Skolefoto: tilmeld Alma', summary: '' };
    expect(doneKeys(reworded)).toEqual(doneKeys(CARD));
  });

  test('is not the card id, which is only a position', () => {
    expect(doneKeys(CARD)).toEqual(['post:13311009|2026-08-17']);
    expect(doneKeys(CARD).join(' ')).not.toContain('model:0');
  });

  test('covers every source a card gathers', () => {
    // The same meeting arrives as an invitation and as a reminder, and which
    // sources a card gathers can change between runs.
    const merged = { ...CARD, sourceKeys: ['post:13311009', 'thread:88', 'post:91'] };
    expect(doneKeys(merged)).toEqual([
      'post:13311009|2026-08-17',
      'thread:88|2026-08-17',
      'post:91|2026-08-17',
    ]);
  });

  test('a recurring obligation comes back on its next date', () => {
    expect(doneKeys({ ...CARD, date: '2026-08-24' })).not.toEqual(doneKeys(CARD));
  });

  test('an undated obligation still gets a key', () => {
    expect(doneKeys({ ...CARD, date: null })).toEqual(['post:13311009|-']);
  });
});

describe('the rendered page', () => {
  const input = briefInput({ today: '2026-08-13', items: [SOURCE] });
  const brief = rankedBrief(input, [CARD]);
  const html = renderPage(brief);

  test('every card carries its keys and a tick', () => {
    expect(html).toContain('data-done-keys="post:13311009|2026-08-17"');
    expect(html).toContain('aria-label="Markér som klaret"');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('the section the script drives is marked up for it', () => {
    expect(html).toContain('data-section="cards"');
    expect(html).toContain('<span class="count" data-count>');
    expect(html).toContain('data-done-toggle');
  });

  test('the empty-state sentence is present but hidden while work remains', () => {
    // Ticking off the last card has to reveal something, and the script does
    // not build markup — so it ships hidden rather than being created later.
    expect(html).toContain('data-empty hidden');
  });

  test('a day with no cards shows that sentence instead', () => {
    const page = renderPage(rankedBrief(input, []));
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
