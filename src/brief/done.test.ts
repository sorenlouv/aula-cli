import { describe, expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { DONE_SCRIPT, doneKeys } from './done.ts';
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
    expect(html).toContain('aria-label="Aula-overblik"');
    expect(html).toContain('data-timeline-group');
    expect(html).not.toContain('data-count');
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

describe('the page behaviour', () => {
  test('viewing a regrouped done card does not renew or widen its stored keys', () => {
    const originalStamp = new Date().toISOString();
    let stored = JSON.stringify({ 'post:13311009|2026-08-17': originalStamp });
    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    const classList = {
      contains: (name: string) => classes.has(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    };
    const tick = {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      setAttribute: () => undefined,
    };
    const card = {
      classList,
      getAttribute: () => 'post:13311009|2026-08-17 thread:88|2026-08-17',
      querySelector: () => tick,
    };
    const empty = { hidden: true };
    const group = {
      hidden: false,
      querySelectorAll: (selector: string) => (selector === '[data-done-keys]' ? [card] : []),
    };
    const section = {
      classList: {
        contains: () => false,
        remove: () => undefined,
        toggle: () => undefined,
      },
      querySelectorAll: (selector: string) =>
        selector === '[data-done-keys]'
          ? [card]
          : selector === '[data-timeline-group]'
            ? [group]
            : [],
      querySelector: (selector: string) => (selector === '[data-empty]' ? empty : null),
    };
    const document = { querySelectorAll: () => [section] };
    const localStorage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };

    // Running the brief's own client-side script against a fake DOM is the
    // entire point of this test — there is no other way to prove DONE_SCRIPT
    // behaves, short of a browser.
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function('document', 'localStorage', DONE_SCRIPT)(document, localStorage);

    expect(JSON.parse(stored)).toEqual({ 'post:13311009|2026-08-17': originalStamp });
    expect(classes.has('is-done')).toBe(true);
    expect(group.hidden).toBe(true);
    expect(listeners.has('click')).toBe(true);
  });

  test('a live personal card keeps a mixed date group visible', () => {
    const classSet = () => {
      const names = new Set<string>();
      return {
        names,
        classList: {
          contains: (name: string) => names.has(name),
          toggle: (name: string, force?: boolean) => {
            const enabled = force ?? !names.has(name);
            if (enabled) names.add(name);
            else names.delete(name);
            return enabled;
          },
        },
      };
    };
    const aula = classSet();
    const personal = classSet();
    const card = (classes: ReturnType<typeof classSet>, keys: string) => ({
      classList: classes.classList,
      getAttribute: () => keys,
      querySelector: () => null,
    });
    const aulaCard = card(aula, 'post:1|2026-08-17');
    const personalCard = card(personal, 'cal:family:1|2026-08-17');
    const cards = [aulaCard, personalCard];
    const group = {
      hidden: false,
      querySelectorAll: (selector: string) => (selector === '[data-done-keys]' ? cards : []),
    };
    const section = {
      classList: {
        contains: () => false,
        remove: () => undefined,
        toggle: () => undefined,
      },
      querySelectorAll: (selector: string) =>
        selector === '[data-done-keys]'
          ? cards
          : selector === '[data-timeline-group]'
            ? [group]
            : [],
      querySelector: () => null,
    };
    const document = { querySelectorAll: () => [section] };
    const localStorage = {
      getItem: () => JSON.stringify({ 'post:1|2026-08-17': new Date().toISOString() }),
      setItem: () => undefined,
    };

    // Running the brief's own client-side script against a fake DOM is the
    // entire point of this test — there is no other way to prove DONE_SCRIPT
    // behaves, short of a browser.
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function('document', 'localStorage', DONE_SCRIPT)(document, localStorage);

    expect(aula.names.has('is-done')).toBe(true);
    expect(personal.names.has('is-done')).toBe(false);
    expect(group.hidden).toBe(false);
  });
});
