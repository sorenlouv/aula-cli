import { describe, expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { CARD_CAP } from './rank.ts';
import { renderPage } from './render.ts';
import { BRIEF_CSS } from './styles.ts';
import type { BriefInput, Card, SourceItem } from './types.ts';
import { validatePage } from './validate.ts';

// 2026-08-13 is a Thursday.
const TODAY = '2026-08-13';

const PHOTO: SourceItem = sourceItem({
  key: 'post:1',
  title: 'Skolefoto - uge 35!',
  text: 'Eksempel Foto fotograferer 24.–28. august. I bedes tilmelde jeres barn på shop.eksempelfoto.dk med koden Eksempel26.',
  at: '2026-08-13T09:00:00',
  author: 'Yrsa S.',
  audience: 'institution',
  url: 'https://www.aula.dk/portal/#/opslag',
});

const PHOTO_REMINDER: SourceItem = sourceItem({
  key: 'thread:2',
  kind: 'thread',
  title: 'Fotografering på tirsdag',
  text: 'På tirsdag skal I finde det flotte tøj frem. Det er nemlig fotodag!',
  at: '2026-08-20T07:56:00',
  author: 'Vitus E.',
  audience: 'class',
  url: 'https://www.aula.dk/portal/#/beskeder',
  conversation: {
    messages: [
      {
        from: 'Vitus E.',
        at: '2026-08-20T07:56:00',
        text: 'På tirsdag skal I finde det flotte tøj frem. Det er nemlig fotodag!',
      },
    ],
    total: 1,
    truncated: false,
  },
});

const DIARY: SourceItem = sourceItem({
  key: 'post:3',
  title: 'Sommerfuglene, onsdag d. 12/8',
  text: 'I dag malede vi sten med guldfarve og lavede popcorn over bål.',
  at: '2026-08-12T15:00:00',
  author: 'Palle P.',
  audience: 'class',
});

const COURSE: SourceItem = sourceItem({
  key: 'post:4',
  title: 'Forældrekursus',
  text: 'Tilbud om kursus for forældre i kommunen. Ansøgningsfrist 1. september.',
  audience: 'municipal',
  groups: ['Alle forældre'],
});

const DENTIST: SourceItem = sourceItem({
  key: 'cal:far@eksempel.dk:dentist:2026-08-13T13:30:00+02:00',
  kind: 'personal',
  title: 'Tandlæge',
  text: 'Tandlæge · kl. 13:30–14:15 · Fra kalenderen «Familien»',
  at: '2026-08-13T13:30:00',
  endsAt: '2026-08-13T14:15:00',
  allDay: false,
  author: 'Familien',
  audience: 'family',
  url: 'https://calendar.google.com/calendar/event?eid=abc',
});

const INPUT: BriefInput = briefInput({
  today: TODAY,
  family: {
    children: [
      {
        name: 'Alma E.',
        firstName: 'Alma',
        institution: 'Skolen',
        className: '1B',
        presence: null,
      },
      {
        name: 'Viggo E.',
        firstName: 'Viggo',
        institution: 'Børnehuset Eksemplet',
        className: 'Sommerfuglene',
        presence: null,
      },
    ],
    isSteppedUp: true,
  },
  items: [PHOTO, PHOTO_REMINDER, DIARY, COURSE, DENTIST],
  albums: [{ title: 'Skovtur med 1B', at: '2026-08-12', childNames: ['Alma'] }],
});

const SIGNUP: Card = card({
  id: 'model:0',
  title: 'Tilmeld Alma til skolefoto inden mandag',
  summary: 'Eksempel Foto fotograferer 24.–28. august, og 1.B er på tirsdag. Koden er Eksempel26.',
  children: ['Alma'],
  date: '2026-08-24',
  needsAction: true,
  reason: 'Kræver tilmelding af Alma; fristen er hård.',
  sourceKeys: ['post:1', 'thread:2'],
});

const MEETING: Card = card({
  id: 'model:1',
  title: 'Forældremøde i 1.B onsdag kl. 17-19',
  summary: 'Årets første forældremøde.',
  children: ['Alma'],
  date: '2026-08-26',
  sourceKeys: ['thread:2'],
});

const page = (
  cards: Card[],
  opts: Parameters<typeof renderPage>[1] = {},
  hidden: string[] = [],
) => {
  const brief = rankedBrief(INPUT, cards, { hidden });
  return { brief, html: renderPage(brief, opts) };
};

describe('a card', () => {
  const { brief, html } = page([SIGNUP, MEETING]);

  test('carries title, summary, children, date chip and the action badge', () => {
    expect(html).toContain('<p class="title">Tilmeld Alma til skolefoto inden mandag</p>');
    expect(html).toContain('<p class="summary">Eksempel Foto fotograferer 24.–28. august');
    expect(html).toContain('<span class="chip soon">Mandag 24. august</span>');
    expect(html).toContain('<span class="chip act">Skal gøres</span>');
    expect(html).toContain('<span class="who"><span class="dot c1"></span>Alma</span>');
    expect(html).toMatch(/<div class="card act" data-signal-id="model:0"/);
    // A card to merely know is drawn without the badge or the warm edge.
    expect(html).toMatch(/<div class="card " data-signal-id="model:1"/);
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('today and tomorrow are named as such on the chip', () => {
    const today = card({ ...SIGNUP, id: 'a', date: TODAY });
    const tomorrow = card({ ...MEETING, id: 'b', date: '2026-08-14' });
    const { html } = page([today, tomorrow]);
    expect(html).toContain('<span class="chip now">I dag</span>');
    expect(html).toContain('<span class="chip soon">I morgen</span>');
  });

  test('a card that gathers several sources lists every one of them under Læs mere', () => {
    expect(html).toContain('<summary>Læs mere · 2 kilder</summary>');
    // Each source: its own head with a dateline and a link, then the original.
    expect(html).toContain(
      '<b>Skolefoto - uge 35!</b><span>skrevet 13. august · Yrsa S.</span><a href="https://www.aula.dk/portal/#/opslag">åbn i Aula</a>',
    );
    expect(html).toContain(
      '<b>Fotografering på tirsdag</b><span>skrevet 20. august · Vitus E.</span>',
    );
    expect(html).toContain('Eksempel Foto fotograferer 24.–28. august. I bedes tilmelde');
    expect(html).toContain('Det er nemlig fotodag!');
    // The attribution line says how many and how fresh, with one link.
    expect(html).toContain('<div class="src">2 kilder · seneste skrevet 20. august · <a href=');
    // Ticks cover every source, so a regrouping cannot resurrect it.
    expect(html).toContain('data-done-keys="post:1|2026-08-24 thread:2|2026-08-24"');
  });

  test('the reason sits first inside the fold, never on the card face', () => {
    const face = html.slice(
      html.indexOf('data-signal-id="model:0"'),
      html.indexOf('<details class="more">'),
    );
    expect(face).not.toContain('Kræver tilmelding');
    expect(html).toContain(
      '<p class="reason"><b>Vist fordi:</b> Kræver tilmelding af Alma; fristen er hård.</p>',
    );
  });

  test('a single-source card keeps the plain attribution line', () => {
    expect(html).toContain(
      'Fotografering på tirsdag · skrevet 20. august · Vitus E. · <a href="https://www.aula.dk/portal/#/beskeder">åbn i Aula</a>',
    );
  });

  test('the new-chip comes from isNew, on any of the card’s sources', () => {
    const { html } = page([SIGNUP], { isNew: (key) => key === 'thread:2' });
    expect(html.slice(0, html.indexOf('model:1'))).toContain('<span class="chip new">Ny</span>');
  });

  test('a rule-made card whose summary is the whole source gets no fold to open', () => {
    const rule = card({
      id: 'plan:x#0',
      title: 'Idræt',
      summary: 'Husk skiftetøj og badeting til efter timen.',
      origin: 'rule',
      sourceKeys: ['plan:x'],
    });
    const input = briefInput({
      today: TODAY,
      items: [
        sourceItem({
          key: 'plan:x',
          kind: 'plan',
          title: 'Idræt',
          text: 'Husk skiftetøj og badeting til efter timen.',
        }),
      ],
    });
    const brief = rankedBrief(input, [rule]);
    const html = renderPage(brief);
    expect(html).not.toContain('<details class="more">');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('model text is escaped before it reaches the page', () => {
    const { html } = page([card({ ...SIGNUP, title: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the list', () => {
  test('is by date with undated and past tails under dividers', () => {
    const undated = card({ id: 'u', title: 'Skolemælk', sourceKeys: ['post:3'] });
    const past = card({ id: 'p', title: 'Løbedag', date: '2026-08-10', sourceKeys: ['post:4'] });
    const { html } = page([MEETING, SIGNUP, undated, past]);
    const at = (needle: string) => html.indexOf(needle);
    expect(at('data-signal-id="model:0"')).toBeLessThan(at('data-signal-id="model:1"'));
    expect(at('data-signal-id="model:1"')).toBeLessThan(at('Uden fast dato'));
    expect(at('Uden fast dato')).toBeLessThan(at('data-signal-id="u"'));
    expect(at('data-signal-id="u"')).toBeLessThan(at('Tidligere'));
    expect(at('Tidligere')).toBeLessThan(at('data-signal-id="p"'));
  });

  test('no divider heads a list that is all one kind', () => {
    expect(page([SIGNUP, MEETING]).html).not.toContain('class="divider"');
    expect(page([card({ id: 'u', sourceKeys: ['post:3'] })]).html).not.toContain('class="divider"');
  });

  test('the count and the empty state follow the cards', () => {
    expect(page([SIGNUP, MEETING]).html).toContain(
      'Kommende <span class="count" data-count>2</span>',
    );
    const { html } = page([]);
    expect(html).toContain('data-empty>Ingen kort i dag');
  });

  test('the fallback topline counts what needs doing', () => {
    expect(page([SIGNUP, MEETING]).html).toContain(
      '<p class="topline">1 ting kræver handling.</p>',
    );
    expect(page([MEETING]).html).toContain('<p class="topline">Intet kræver handling lige nu.</p>');
    expect(page([MEETING], { topline: 'Alt er roligt.' }).html).toContain(
      '<p class="topline">Alt er roligt.</p>',
    );
  });
});

describe('what is not a card', () => {
  test('folded cards and the rest share one fold, named for what it holds', () => {
    const items = Array.from({ length: CARD_CAP + 1 }, (_, i) =>
      sourceItem({ key: `post:${100 + i}`, title: `Opslag ${i}`, text: `Tekst ${i}.` }),
    );
    const input = briefInput({ today: TODAY, items: [...items, DIARY] });
    const cards = items.map((s, i) =>
      card({ id: `c${i}`, title: `Kort ${i}`, sourceKeys: [s.key] }),
    );
    const brief = rankedBrief(input, cards);
    const html = renderPage(brief);
    expect(brief.folded).toHaveLength(1);
    expect(html).toContain('<h2>Øvrigt fra Aula</h2>');
    expect(html).toContain('<summary>2 opslag og beskeder, der ikke blev fremhævet</summary>');
    // The folded card keeps its title and summary; the rest source its title and dateline.
    expect(html).toContain(`<b>${brief.folded[0]?.title}</b>`);
    expect(html).toContain('<b>Sommerfuglene, onsdag d. 12/8</b><p>skrevet 12. august · Palle P.</p>');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('hidden sources are counted in the muted foot and nowhere else', () => {
    const { brief, html } = page([SIGNUP], {}, ['post:4']);
    expect(html).toContain('<summary>1 skjult</summary>');
    expect(html).toContain('<b>Forældrekursus</b>');
    expect(html).not.toContain('<h2>Øvrigt fra Aula</h2><details><summary>2');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('a page with no fold when every source is a card', () => {
    const input = briefInput({ today: TODAY, items: [PHOTO] });
    const html = renderPage(rankedBrief(input, [card({ id: 'a', sourceKeys: ['post:1'] })]));
    expect(html).not.toContain('<h2>Øvrigt fra Aula</h2>');
  });
});

describe('the family’s calendar', () => {
  test('appointments fold into one collapsed section of rows, never cards', () => {
    const { brief, html } = page([SIGNUP]);
    expect(html).toContain('<section data-section="calendar">');
    expect(html).toContain('<details class="cal">');
    expect(html).not.toContain('<details class="cal" open');
    const open = `<div class="cal-row" data-signal-id="${DENTIST.key}"`;
    expect(html).toContain(open);
    const row = html.slice(html.indexOf(open), html.indexOf('</div>', html.indexOf(open)));
    expect(row).toContain(`data-source-id="${DENTIST.key}"`);
    expect(row).toContain(`data-done-keys="${DENTIST.key}|2026-08-13"`);
    expect(row).toContain('åbn i kalender');
    expect(html).toContain('<span class="cal-when">kl. 13:30–14:15</span>');
    expect(html).toContain('<span class="cal-title">Tandlæge</span>');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('the summary names today, and any day a card lands on — nothing else', () => {
    const football = {
      ...DENTIST,
      key: 'cal:f',
      title: 'Half fodbold',
      at: '2026-08-19T16:25:00',
      endsAt: '2026-08-19T17:45:00',
    };
    const gym = {
      ...DENTIST,
      key: 'cal:g',
      title: 'Viggo gymnastik',
      at: '2026-08-26T17:10:00',
      endsAt: '2026-08-26T18:10:00',
    };
    const input = { ...INPUT, items: [...INPUT.items, football, gym] };
    const brief = rankedBrief(input, [MEETING]); // Wednesday 26th
    const html = renderPage(brief);
    const summary = /<details class="cal"><summary>(.*?)<\/summary>/.exec(html)?.[1];
    expect(summary).toBe('I dag: Tandlæge 13:30 · onsdag 26/8: Viggo gymnastik 17:10');
    expect(summary).not.toContain('fodbold');
  });

  test('a hidden appointment is not in the fold — that is the family saying no', () => {
    const { html } = page([SIGNUP], {}, [DENTIST.key]);
    expect(html).not.toContain('data-section="calendar"');
    expect(html).toContain('<summary>1 skjult</summary>');
  });
});

describe('the rest of the page', () => {
  test('phone layout lets the child-chip row shrink before it wraps', () => {
    expect(BRIEF_CSS).toContain('.kids{width:100%;min-width:0}');
    expect(BRIEF_CSS).toContain('.wrap{padding:26px 16px 60px;overflow-wrap:anywhere}');
  });

  test('per-child lines, album tiles and the kids in the header', () => {
    const { html } = page([SIGNUP], { summaries: { Alma: 'Fotodag tirsdag (fint tøj).' } });
    expect(html).toContain('<span>Fotodag tirsdag (fint tøj).</span>');
    expect(html).toContain('Skovtur med 1B');
    expect(html).toContain('<b>Viggo</b><span>Sommerfuglene</span>');
  });

  test('a failed fetch hoists datastatus above the cards; a clean day folds it at the foot', () => {
    const warn = {
      ...INPUT,
      health: [
        {
          level: 'warn' as const,
          message: 'Ugeplan for Viggo kunne ikke hentes — EasyIQ svarede HTTP 500.',
        },
      ],
    };
    const hoisted = renderPage(rankedBrief(warn, [SIGNUP]));
    expect(hoisted.indexOf('data-block="datastatus"')).toBeLessThan(
      hoisted.indexOf('data-section="cards"'),
    );
    const { html } = page([SIGNUP]);
    expect(html.indexOf('data-block="datastatus"')).toBeGreaterThan(
      html.indexOf('data-section="cards"'),
    );
    expect(html).toContain('<summary>Datastatus · alle kilder blev hentet</summary>');
  });

  test('a note about the overview itself does not hoist the block', () => {
    const brief = rankedBrief(INPUT, [SIGNUP]);
    brief.degraded.push('Modellens svar var ufuldstændigt (1 fejl).');
    const html = renderPage(brief);
    expect(html.indexOf('data-block="datastatus"')).toBeGreaterThan(
      html.indexOf('data-section="cards"'),
    );
    expect(html).toContain('· 1 bemærkning om oversigten</summary>');
    expect(html).toContain('Modellens svar var ufuldstændigt (1 fejl).');
  });

  test('the note for a day without a model lands in the header meta', () => {
    expect(page([SIGNUP], { note: 'kun reglerne' }).html).toContain('uge 2026-W33 · kun reglerne');
  });
});
