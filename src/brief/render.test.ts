import { describe, expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { CARD_CAP } from './rank.ts';
import { renderPage } from './render.ts';
import { BRIEF_CSS } from './styles.ts';
import type { BriefInput, Card, SourceItem } from './types.ts';
import { validatePage } from './validate.ts';

// 2026-08-17 is a Monday.
const TODAY = '2026-08-17';

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
  location: 'Tandlægehuset',
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
  items: [PHOTO, PHOTO_REMINDER, DIARY, COURSE],
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

const DENTIST_VERDICT = {
  sourceKey: DENTIST.key,
  relevant: true,
  summary: 'Tandlægetid i Tandlægehuset i eftermiddag.',
  reason: 'Aftalen påvirker familiens plan i dag.',
};

const page = (
  cards: Card[],
  opts: Parameters<typeof renderPage>[1] = {},
  hidden: string[] = [],
) => {
  const brief = rankedBrief(INPUT, cards, { hidden });
  return { brief, html: renderPage(brief, opts) };
};

const calendarPage = (
  cards: Card[],
  opts: Parameters<typeof renderPage>[1] = {},
  personalEvents = [DENTIST_VERDICT],
  extraItems: SourceItem[] = [],
) => {
  const input = { ...INPUT, items: [...INPUT.items, DENTIST, ...extraItems] };
  const brief = rankedBrief(input, cards, { personalEvents });
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
    const tomorrow = card({ ...MEETING, id: 'b', date: '2026-08-18' });
    const { html } = page([today, tomorrow]);
    expect(html).toContain('<h3 class="timeline-heading">I dag (d. 17. august)</h3>');
    expect(html).toContain('<h3 class="timeline-heading">I morgen (d. 18. august)</h3>');
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
  test('marks a projected weekly occurrence and keeps it in chronological order', () => {
    const running = sourceItem({
      key: 'post:running',
      title: 'Løbedag',
      text: 'Vi løber fast om mandagen. Husk løbetøj og løbesko.',
    });
    const input = briefInput({ today: '2026-08-24', items: [running] });
    const brief = rankedBrief(input, [
      card({
        id: 'running',
        title: 'Send Viggo i løbetøj og løbesko om mandagen',
        summary: 'Løbedagen gentages om mandagen.',
        needsAction: true,
        sourceKeys: [running.key],
      }),
    ]);
    const html = renderPage(brief);

    expect(html).toContain('<span class="chip now">I dag</span>');
    expect(html).toContain('<span class="chip recurring">Gentages hver mandag</span>');
    expect(html).not.toContain('Uden fast dato');
    expect(html).toContain('data-done-keys="post:running|2026-08-24"');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('is grouped by date with undated and past tails', () => {
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

  test('next week is one group and there is no visible Kommende heading', () => {
    const html = page([SIGNUP, MEETING]).html;
    expect(html.match(/<h3 class="timeline-heading">Næste uge<\/h3>/g)).toHaveLength(1);
    expect(html).not.toContain('<h2>Kommende');
    expect(html).toContain('<section data-section="cards" aria-label="Kommende">');
    expect(html).toContain('<div class="timeline"><div class="timeline-group"');
    expect(BRIEF_CSS).toContain('.timeline-group:last-child{margin-bottom:0}');
    expect(BRIEF_CSS).not.toContain('.timeline-group:last-of-type');
  });

  test('remaining days this week use weekday headings', () => {
    const wednesday = card({ ...MEETING, id: 'wednesday', date: '2026-08-19' });
    const html = page([wednesday]).html;

    expect(html).toContain('<h3 class="timeline-heading">Onsdag (d. 19. august)</h3>');
    expect(html).not.toContain('<h3 class="timeline-heading">Næste uge</h3>');
  });

  test('tomorrow keeps its own heading when it is the first day of next week', () => {
    const mondaySource = sourceItem({ key: 'post:monday' });
    const tuesdaySource = sourceItem({ key: 'post:tuesday' });
    const input = briefInput({
      today: '2026-08-30',
      items: [mondaySource, tuesdaySource],
    });
    const brief = rankedBrief(input, [
      card({ id: 'monday', date: '2026-08-31', sourceKeys: [mondaySource.key] }),
      card({ id: 'tuesday', date: '2026-09-01', sourceKeys: [tuesdaySource.key] }),
    ]);
    const html = renderPage(brief);

    expect(html).toContain('<h3 class="timeline-heading">I morgen (d. 31. august)</h3>');
    expect(html).toContain('<h3 class="timeline-heading">Næste uge</h3>');
  });

  test('the empty state follows the cards without a generic count', () => {
    expect(page([SIGNUP, MEETING]).html).not.toContain('data-count');
    const { html } = page([]);
    expect(html).toContain('data-empty>Ingen punkter i dag');
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
  test('a relevant appointment is a compact collapsed card inside the timeline', () => {
    const { brief, html } = calendarPage([SIGNUP]);
    expect(html).not.toContain('<h2>Egen kalender');
    expect(html).not.toContain('data-section="calendar"');
    expect(html).not.toContain('<h2>Kommende');
    expect(brief.timeline).toHaveLength(2);
    expect(html).toContain('<details class="calendar-details">');
    expect(html).not.toContain('<details class="calendar-details" open');
    const open = `<div class="card calendar-card" data-signal-id="personal:${DENTIST.key}"`;
    expect(html).toContain(open);
    const row = html.slice(html.indexOf(open), html.indexOf('</div>', html.indexOf(open)));
    expect(row).toContain(`data-source-id="${DENTIST.key}"`);
    expect(row).toContain(`data-done-keys="${DENTIST.key}|2026-08-13"`);
    expect(html).toContain('<span class="calendar-when">kl. 13:30–14:15</span>');
    expect(html).toContain('<span class="calendar-title">Tandlæge</span>');
    expect(html).toContain('<span class="calendar-origin">Egen kalender</span>');
    expect(html).toContain(DENTIST_VERDICT.summary);
    expect(html).toContain(`<b>Vist fordi:</b> ${DENTIST_VERDICT.reason}`);
    expect(html).toContain('Tandlægehuset · Familien · <a href=');
    expect(html).toContain('åbn i kalender');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('Google and structured Aula events on the same day are interleaved by start time', () => {
    const aulaEvent = sourceItem({
      key: 'event:meeting',
      kind: 'event',
      title: 'Forældremøde',
      at: '2026-08-13T15:00:00',
      endsAt: '2026-08-13T17:00:00',
    });
    const meeting = card({
      id: 'meeting',
      title: 'Forældremøde',
      date: '2026-08-13',
      sourceKeys: [aulaEvent.key],
    });
    const { html } = calendarPage([meeting], {}, [DENTIST_VERDICT], [aulaEvent]);

    expect(html.indexOf('calendar-title">Tandlæge')).toBeLessThan(
      html.indexOf('class="title">Forældremøde'),
    );
  });

  test('an irrelevant appointment is absent from the timeline and counted as hidden', () => {
    const { brief, html } = calendarPage([SIGNUP], {}, [
      { ...DENTIST_VERDICT, relevant: false, reason: 'Ikke relevant for skoleugen.' },
    ]);
    expect(html).not.toContain('calendar-title">Tandlæge');
    expect(html).toContain('<summary>1 skjult</summary>');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('a defensive out-of-window appointment leaves a visible degraded note', () => {
    const later = {
      ...DENTIST,
      key: 'cal:family:later',
      at: '2026-09-07T13:30:00',
      endsAt: '2026-09-07T14:15:00',
    };
    const input = briefInput({ today: '2026-08-24', items: [later] });
    const brief = rankedBrief(input, [], {
      personalEvents: [
        {
          sourceKey: later.key,
          relevant: true,
          summary: 'En senere tandlægetid.',
          reason: 'Aftalen vedrører et barn.',
        },
      ],
    });
    const html = renderPage(brief);

    expect(html).not.toContain(`data-signal-id="personal:${later.key}"`);
    expect(html).toContain(
      'Kalenderaftalen &quot;Tandlæge&quot; den 2026-09-07 ligger efter oversigtens slutdato 2026-09-06 og blev ikke vist.',
    );
    expect(validatePage(html, brief)).toEqual([]);
  });
});

describe('the rest of the page', () => {
  test('phone layout lets the child-chip row shrink before it wraps', () => {
    expect(BRIEF_CSS).toContain('.kids{width:100%;min-width:0}');
    expect(BRIEF_CSS).toContain('.wrap{padding:26px 16px 60px;overflow-wrap:anywhere}');
    expect(BRIEF_CSS).toContain('.calendar-origin{flex-basis:100%;margin-left:0}');
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
