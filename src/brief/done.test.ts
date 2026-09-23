import { describe, expect, test } from 'bun:test';
import { type HTMLElement, Window } from 'happy-dom';
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
  const HOSTED = 'https://aula-brief.eksempel.workers.dev/';
  const ON_DISK = 'file:///Users/eksempel/.aula/brief/latest.html';
  const STORE = 'aula.done.v1';
  const stamp = () => new Date().toISOString();

  /** Two date groups: one card that gathers two sources, and a mixed pair. */
  const MARKUP = `
    <section data-section="cards">
      <div class="panel" data-empty hidden>Ingen punkter i dag.</div>
      <button class="done-toggle" type="button" data-done-toggle hidden></button>
      <div class="timeline-group" data-timeline-group="2026-08-17">
        <div class="card" id="meeting" data-done-keys="post:1|2026-08-17 thread:88|2026-08-17"><button class="tick" type="button"></button></div>
      </div>
      <div class="timeline-group" data-timeline-group="2026-08-18">
        <div class="card" id="aula" data-done-keys="post:2|2026-08-18"><button class="tick" type="button"></button></div>
        <div class="card" id="personal" data-done-keys="cal:family:1|2026-08-18"><button class="tick" type="button"></button></div>
      </div>
    </section>`;

  type Call = { url: string; method: string; body: unknown };
  type Answer = Record<string, string> | 'offline' | Promise<Record<string, string>>;

  /**
   * Runs the brief's own script against a real DOM. happy-dom supplies the
   * document, storage and location; `fetch` is the Worker, answering each
   * call with `answer(call)` — the whole set, as the real one does.
   */
  function load(opts: {
    url: string;
    markup?: string;
    cached?: Record<string, string>;
    answer?: (call: Call) => Answer;
  }) {
    const window = new Window({ url: opts.url });
    const document = window.document;
    document.body.innerHTML = opts.markup ?? MARKUP;
    if (opts.cached) window.localStorage.setItem(STORE, JSON.stringify(opts.cached));

    const calls: Call[] = [];
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const call = {
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const answer = opts.answer ? opts.answer(call) : {};
      if (answer === 'offline') throw new TypeError('Failed to fetch');
      return Response.json({ done: await answer });
    };

    // Running the brief's own client-side script is the entire point of these
    // tests — there is no other way to prove DONE_SCRIPT behaves, short of a
    // browser.
    // oxlint-disable-next-line typescript/no-implied-eval
    new Function('document', 'localStorage', 'location', 'fetch', DONE_SCRIPT)(
      document,
      window.localStorage,
      window.location,
      fetch,
    );

    const card = (id: string) => document.getElementById(id)!;
    return {
      window,
      document,
      calls,
      card,
      isDone: (id: string) => card(id).classList.contains('is-done'),
      tick: (id: string) => (card(id).querySelector('.tick') as HTMLElement).click(),
      group: (key: string) =>
        document.querySelector(`[data-timeline-group="${key}"]`) as HTMLElement,
      cached: () =>
        JSON.parse(window.localStorage.getItem(STORE) ?? '{}') as Record<string, string>,
    };
  }

  /** Lets the fetch promise chains run to the end. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('viewing a regrouped done card does not renew or widen its stored keys', () => {
    // Opened from disk, where the page's own storage is the record.
    const original = { 'post:1|2026-08-17': stamp() };
    const page = load({ url: ON_DISK, cached: original });

    expect(page.cached()).toEqual(original);
    expect(page.isDone('meeting')).toBe(true);
    expect(page.group('2026-08-17').hidden).toBe(true);
  });

  test('a live personal card keeps a mixed date group visible', () => {
    const page = load({ url: ON_DISK, cached: { 'post:2|2026-08-18': stamp() } });
    expect(page.isDone('aula')).toBe(true);
    expect(page.isDone('personal')).toBe(false);
    expect(page.group('2026-08-18').hidden).toBe(false);
  });

  test('a page opened from disk never asks a server', async () => {
    const page = load({ url: ON_DISK });
    page.tick('aula');
    await settle();
    expect(page.calls).toEqual([]);
    expect(Object.keys(page.cached())).toEqual(['post:2|2026-08-18']);
  });

  test('the hosted page paints from its cache, then the shared set replaces it', async () => {
    // Cached: this phone ticked the meeting. Shared: the other parent unticked
    // it since, and ticked the Aula card.
    const shared = { 'post:2|2026-08-18': stamp() };
    const page = load({
      url: HOSTED,
      cached: { 'post:1|2026-08-17': stamp() },
      answer: () => shared,
    });
    expect(page.isDone('meeting')).toBe(true);

    await settle();
    expect(page.calls).toEqual([{ url: '/api/done', method: 'GET', body: null }]);
    expect(page.isDone('meeting')).toBe(false);
    expect(page.isDone('aula')).toBe(true);
    expect(page.cached()).toEqual(shared);
  });

  test("a tick sends every key the card carries and takes the other parent's ticks back", async () => {
    const theirs = { 'cal:family:1|2026-08-18': stamp() };
    const page = load({
      url: HOSTED,
      answer: (call) =>
        call.method === 'POST' ? { ...theirs, 'post:1|2026-08-17': stamp() } : theirs,
    });
    await settle();
    page.tick('meeting');
    expect(page.isDone('meeting')).toBe(true);
    await settle();

    expect(page.calls[1]).toEqual({
      url: '/api/done',
      method: 'POST',
      body: { keys: ['post:1|2026-08-17', 'thread:88|2026-08-17'], done: true },
    });
    expect(page.isDone('personal')).toBe(true);
    expect(page.isDone('meeting')).toBe(true);
  });

  test('a slow load answering after a tick does not undo the tick', async () => {
    let answerLoad: (done: Record<string, string>) => void = () => undefined;
    const page = load({
      url: HOSTED,
      answer: (call) =>
        call.method === 'GET'
          ? new Promise((resolve) => (answerLoad = resolve))
          : { 'post:2|2026-08-18': stamp() },
    });
    page.tick('aula');
    await settle();
    expect(page.isDone('aula')).toBe(true);

    // The load left before the tick, so its answer is the world without it.
    answerLoad({});
    await settle();
    expect(page.isDone('aula')).toBe(true);
    expect(Object.keys(page.cached())).toEqual(['post:2|2026-08-18']);
  });

  test('with the server unreachable a tick still takes', async () => {
    const page = load({ url: HOSTED, answer: () => 'offline' });
    page.tick('aula');
    await settle();
    expect(page.isDone('aula')).toBe(true);
    expect(Object.keys(page.cached())).toEqual(['post:2|2026-08-18']);
  });

  test('coming back to the tab asks again', async () => {
    const page = load({ url: HOSTED });
    await settle();
    page.document.dispatchEvent(new page.window.Event('visibilitychange'));
    await settle();
    expect(page.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  test('drives the markup the renderer actually writes', async () => {
    const input = briefInput({ today: '2026-08-13', items: [SOURCE] });
    const html = renderPage(rankedBrief(input, [CARD]));
    const page = load({
      url: HOSTED,
      markup: html,
      answer: (call) => (call.method === 'POST' ? { 'post:13311009|2026-08-17': stamp() } : {}),
    });
    await settle();

    const card = page.document.querySelector('[data-done-keys="post:13311009|2026-08-17"]')!;
    (card.querySelector('.tick') as HTMLElement).click();
    await settle();

    expect(card.classList.contains('is-done')).toBe(true);
    expect(card.querySelector('.tick')!.getAttribute('aria-pressed')).toBe('true');
    expect(page.document.querySelector('[data-done-toggle]')!.textContent).toBe('1 klaret · vis');
    expect(page.document.querySelector('[data-empty]')!.hasAttribute('hidden')).toBe(false);
  });
});
