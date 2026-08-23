import { describe, expect, test } from 'bun:test';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { fallbackPage, parsePlan, renderPlan } from './compose.ts';
import type { BriefInput, RankedBrief, RankedSignal, SourceItem } from './types.ts';
import { validatePage } from './validate.ts';

const SOURCE: SourceItem = sourceItem({
  key: 'plan:x:0',
  kind: 'plan',
  title: 'Idræt',
  text: 'Husk skiftetøj og badeting til efter timen.',
  at: '2026-08-13T08:00:00',
  author: 'EasyIQ',
  childNames: ['Alma Signe Eksempelsen'],
  audience: 'child',
  url: 'https://www.aula.dk/portal/#/ugeplan',
});

const MUST_SHOW: RankedSignal = {
  id: 'plan:x:0#0',
  kind: 'bring',
  title: 'Send skiftetøj og badeting med',
  child: 'Alma',
  dueAt: '2026-08-13',
  urgency: 'now',
  quote: 'Husk skiftetøj og badeting til efter timen.',
  why: null,
  sourceKey: 'plan:x:0',
  origin: 'model',
  concernsChild: false,
  score: 123,
  tier: 'act',
  mustShow: true,
  audience: 'child',
  relevance: 'normal',
  reasons: [],
  source: SOURCE,
  mergedSourceKeys: [],
};

const UPCOMING: RankedSignal = {
  ...MUST_SHOW,
  id: 'post:7#0',
  title: 'Forældremøde onsdag',
  tier: 'week',
  urgency: 'week',
  quote: null,
  sourceKey: 'post:7',
  source: { ...SOURCE, key: 'post:7', title: 'Forældremøde' },
};

const HIDDEN: RankedSignal = {
  ...MUST_SHOW,
  id: 'post:9#0',
  title: 'Forældrekurset',
  tier: 'hidden',
  mustShow: false,
  audience: 'municipal',
  relevance: 'hide',
  sourceKey: 'post:9',
  source: {
    ...SOURCE,
    key: 'post:9',
    title: 'Forældrekursus',
    audience: 'municipal',
    groups: ['Alle forældre'],
  },
};

const INPUT: BriefInput = briefInput({
  family: {
    children: [
      {
        name: 'Alma Signe Eksempelsen',
        firstName: 'Alma',
        institution: 'Eksempelskolen',
        className: '2E',
        presence: null,
      },
    ],
    isSteppedUp: true,
  },
  items: [SOURCE],
  health: [
    { level: 'warn', message: 'Ugeplan for Viggo kunne ikke hentes — EasyIQ svarede HTTP 500.' },
  ],
  albums: [{ title: 'Skovtur med 2E', at: '2026-08-12', childNames: ['Alma'] }],
});

/**
 * One of the family's own appointments — today (2026-08-13), a Thursday. The
 * source is what `toPersonalSourceItem` produces: bare title, time as fields.
 */
function appointment(
  overrides: Omit<Partial<RankedSignal>, 'source'> & { source?: Partial<SourceItem> } = {},
): RankedSignal {
  const { source: sourceOverrides, ...rest } = overrides;
  const source: SourceItem = sourceItem({
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
    ...sourceOverrides,
  });
  return {
    ...UPCOMING,
    id: `${source.key}#0`,
    kind: 'event',
    title: source.title,
    child: null,
    dueAt: (source.at ?? '').slice(0, 10),
    urgency: 'week',
    quote: null,
    why: null,
    sourceKey: source.key,
    origin: 'rule',
    audience: 'family',
    source,
    ...rest,
  };
}

const DENTIST = appointment();

const BRIEF: RankedBrief = {
  input: INPUT,
  signals: [MUST_SHOW, UPCOMING, HIDDEN],
  unusedSources: [],
  degraded: [],
};

describe('parsePlan', () => {
  test('keeps known ids, in the model’s order, with trimmed rewording', () => {
    const { plan, problems } = parsePlan(
      {
        topline: '  Fotodag i morgen.  ',
        act: [{ signalId: MUST_SHOW.id, title: '  Pak badeting  ' }],
        week: [{ signalId: UPCOMING.id }],
      },
      BRIEF,
    );
    expect(problems).toEqual([]);
    expect(plan.topline).toBe('Fotodag i morgen.');
    expect(plan.act).toEqual([{ signalId: MUST_SHOW.id, title: 'Pak badeting' }]);
    expect(plan.week).toEqual([{ signalId: UPCOMING.id }]);
  });

  test('drops an invented signalId and reports it', () => {
    const { plan, problems } = parsePlan({ act: [{ signalId: 'digtet:op#0' }] }, BRIEF);
    expect(plan.act).toEqual([]);
    expect(problems.some((p) => p.includes('digtet:op#0'))).toBe(true);
  });

  test('refuses to let the plan reopen the noise gate', () => {
    const { plan, problems } = parsePlan({ act: [{ signalId: HIDDEN.id }] }, BRIEF);
    expect(plan.act).toEqual([]);
    expect(problems.some((p) => p.includes(HIDDEN.id))).toBe(true);
  });

  test('first placement wins when the model lists an id twice', () => {
    const { plan } = parsePlan(
      { act: [{ signalId: MUST_SHOW.id }], week: [{ signalId: MUST_SHOW.id }] },
      BRIEF,
    );
    expect(plan.act).toHaveLength(1);
    expect(plan.week).toHaveLength(0);
  });

  test('tolerates garbage without throwing', () => {
    const { plan, problems } = parsePlan({ act: 'alt muligt', week: [null, 42] }, BRIEF);
    expect(plan.act).toEqual([]);
    expect(plan.week).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });

  test('strips a rewording that asserts a date no source supports', () => {
    const { plan, problems } = parsePlan(
      { act: [{ signalId: MUST_SHOW.id, title: 'Aflever sedlen inden søndag' }] },
      BRIEF,
    );
    expect(plan.act).toEqual([{ signalId: MUST_SHOW.id }]); // rewording gone, card stays
    expect(problems.some((p) => p.includes('dato uden kilde') && p.includes('søndag'))).toBe(true);
  });

  test('a rewording may echo the signal’s own date', () => {
    // MUST_SHOW.dueAt 2026-08-13 is a Thursday.
    const { plan, problems } = parsePlan(
      { act: [{ signalId: MUST_SHOW.id, title: 'Badeting med torsdag' }] },
      BRIEF,
    );
    expect(problems).toEqual([]);
    expect(plan.act[0]?.title).toBe('Badeting med torsdag');
  });

  test('drops a plan topline with an invented date, keeping the fallback', () => {
    const { plan, problems } = parsePlan({ topline: 'Stor uge — fest 24/9!' }, BRIEF);
    expect(plan.topline).toBeUndefined();
    expect(problems.some((p) => p.startsWith('topline'))).toBe(true);
  });

  test('an appointment is not the composer’s to place, whatever it answers', () => {
    // The composer never sees the family's calendar, so an id naming an
    // appointment is a guess. Both placements are refused; the row still
    // renders, verbatim, in the calendar fold.
    const brief: RankedBrief = { ...BRIEF, signals: [DENTIST] };
    const { plan, problems } = parsePlan(
      {
        act: [{ signalId: DENTIST.id, why: 'Kolliderer med skoledagen' }],
        week: [{ signalId: DENTIST.id, title: 'Flyt tandlægen', why: 'Der er et sammenstød' }],
      },
      brief,
    );
    expect(plan.act).toEqual([]);
    expect(plan.week).toEqual([]);
    expect(problems.filter((p) => p.includes('ikke komponistens at placere'))).toHaveLength(2);
    const html = renderPlan(brief, plan);
    expect(html).toContain(`data-signal-id="${DENTIST.id}"`);
    expect(html).toContain('Tandlæge');
    expect(html).not.toContain('Flyt tandlægen');
    expect(html).not.toContain('sammenstød');
    expect(html).toContain('åbn i kalender');
  });
});

describe('renderPlan', () => {
  test('a planned page satisfies every invariant', () => {
    const { plan } = parsePlan(
      { topline: 'Én ting i dag.', act: [{ signalId: MUST_SHOW.id, why: 'Idræt i dag.' }] },
      BRIEF,
    );
    expect(validatePage(renderPlan(BRIEF, plan), BRIEF)).toEqual([]);
  });

  test('an omission in the plan deprioritises, never deletes', () => {
    const { plan } = parsePlan({ act: [], week: [] }, BRIEF);
    const html = renderPlan(BRIEF, plan);
    expect(html).toContain(`data-signal-id="${MUST_SHOW.id}"`);
    expect(html).toContain(`data-signal-id="${UPCOMING.id}"`);
    expect(validatePage(html, BRIEF)).toEqual([]);
  });

  test('the plan’s order is the display order', () => {
    const second: RankedSignal = {
      ...MUST_SHOW,
      id: 'plan:x:0#1',
      title: 'Aflever seddel',
    };
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, second, UPCOMING, HIDDEN] };
    const { plan } = parsePlan(
      { act: [{ signalId: second.id }, { signalId: MUST_SHOW.id }] },
      brief,
    );
    const html = renderPlan(brief, plan);
    expect(html.indexOf(`data-signal-id="${second.id}"`)).toBeLessThan(
      html.indexOf(`data-signal-id="${MUST_SHOW.id}"`),
    );
  });

  test('rewording is escaped before it reaches the page', () => {
    const { plan } = parsePlan(
      { act: [{ signalId: MUST_SHOW.id, title: '<script>alert(1)</script>' }] },
      BRIEF,
    );
    const html = renderPlan(BRIEF, plan);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('quotes come verbatim from the signal, whatever the plan says', () => {
    const { plan } = parsePlan({ act: [{ signalId: MUST_SHOW.id, title: 'Kort' }] }, BRIEF);
    expect(renderPlan(BRIEF, plan)).toContain('«Husk skiftetøj og badeting til efter timen.»');
  });

  test('a promoted context signal does not repeat in the context section', () => {
    const context: RankedSignal = {
      ...UPCOMING,
      id: 'post:8#0',
      title: 'Ny pædagog på stuen',
      tier: 'context',
      sourceKey: 'post:8',
      source: { ...SOURCE, key: 'post:8', title: 'Velkommen' },
    };
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, UPCOMING, context, HIDDEN] };
    const { plan, problems } = parsePlan({ week: [{ signalId: context.id }] }, brief);
    expect(problems).toEqual([]);
    const html = renderPlan(brief, plan);
    expect(html).toContain(`data-signal-id="${context.id}"`);
    expect(html.split(`data-source-id="${context.sourceKey}"`).length).toBe(2);
  });

  test('the new-chip comes from isNew, not from the model', () => {
    const { plan } = parsePlan({ act: [{ signalId: MUST_SHOW.id }] }, BRIEF);
    const html = renderPlan(BRIEF, plan, { isNew: (key) => key === MUST_SHOW.sourceKey });
    expect(html).toContain('<span class="chip new">Ny</span>');
  });
});

describe('the family’s calendar', () => {
  const football = appointment({
    source: {
      key: 'cal:far@eksempel.dk:football:2026-08-19T16:25:00+02:00',
      title: 'Half fodbold',
      at: '2026-08-19T16:25:00',
      endsAt: '2026-08-19T17:45:00',
    },
  });
  const gymnastics = appointment({
    source: {
      key: 'cal:far@eksempel.dk:gym:2026-08-20T17:10:00+02:00',
      title: 'Viggo gymnastik',
      at: '2026-08-20T17:10:00',
      endsAt: '2026-08-20T18:10:00',
    },
  });
  const holiday = appointment({
    source: {
      key: 'cal:far@eksempel.dk:holiday:2026-08-20',
      title: 'Ferie',
      at: '2026-08-20T00:00:00',
      endsAt: '2026-08-22T23:59:00',
      allDay: true,
    },
  });
  /** A school card on the 20th, so that day is one the page already shows. */
  const meeting: RankedSignal = {
    ...UPCOMING,
    id: 'post:20#0',
    title: 'Forældremøde torsdag',
    dueAt: '2026-08-20',
    sourceKey: 'post:20',
    source: { ...SOURCE, key: 'post:20', title: 'Forældremøde' },
  };

  test('appointments fold into one collapsed section of rows, never cards', () => {
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, DENTIST, football] };
    const html = fallbackPage(brief);
    expect(html).toContain('<section data-section="calendar">');
    expect(html).toContain('<details class="cal">');
    expect(html).not.toContain('<details class="cal" open');
    for (const s of [DENTIST, football]) {
      const open = `<div class="cal-row" data-signal-id="${s.id}"`;
      expect(html).toContain(open);
      const row = html.slice(html.indexOf(open), html.indexOf('</div>', html.indexOf(open)));
      expect(row).toContain(`data-source-id="${s.sourceKey}"`);
      expect(row).toContain('data-done-keys=');
      expect(row).toContain('åbn i kalender');
    }
    expect(html.match(/class="card /g) ?? []).toHaveLength(1); // MUST_SHOW only
    expect(html).toContain('Egen kalender <span class="count" data-count>2</span>');
    // Rows under their day, time beside the title, from the source's fields.
    expect(html).toContain('<div class="cal-day">Onsdag 19. august</div>');
    expect(html).toContain('<span class="cal-when">kl. 16:25–17:45</span>');
    expect(html).toContain('<span class="cal-title">Half fodbold</span>');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('the summary names today, and any day a school card lands on — nothing else', () => {
    const brief: RankedBrief = {
      ...BRIEF,
      signals: [MUST_SHOW, meeting, DENTIST, football, gymnastics, holiday],
    };
    const html = fallbackPage(brief);
    const summary = /<details class="cal"><summary>(.*?)<\/summary>/.exec(html)?.[1];
    // Today by the constant; the 20th because the forældremøde is that day; an
    // all-day entry without a clock time. The 19th has nothing from school.
    expect(summary).toBe('I dag: Tandlæge 13:30 · torsdag 20/8: Ferie, Viggo gymnastik 17:10');
    expect(summary).not.toContain('fodbold');
  });

  test('a day Kræver handling lands on counts as a school day too', () => {
    const act: RankedSignal = { ...MUST_SHOW, dueAt: '2026-08-19' };
    const brief: RankedBrief = { ...BRIEF, signals: [act, football] };
    expect(fallbackPage(brief)).toContain('<summary>Onsdag 19/8: Half fodbold 16:25</summary>');
  });

  test('with nothing to single out the summary says so, and claims nothing', () => {
    const brief: RankedBrief = { ...BRIEF, signals: [football] };
    expect(fallbackPage(brief)).toContain('<summary>Alle aftaler i perioden</summary>');
  });

  test('a low-rated appointment stays in Godt at vide, with its time and no more-block', () => {
    const low: RankedSignal = { ...DENTIST, tier: 'context', mustShow: false, relevance: 'low' };
    const html = fallbackPage({ ...BRIEF, signals: [MUST_SHOW, low] });
    expect(html).not.toContain('data-section="calendar"');
    expect(html).toContain(
      `<div class="di" data-source-id="${low.sourceKey}"><b>Tandlæge</b><p>Torsdag 13. august · kl. 13:30–14:15 · Familien</p></div>`,
    );
  });

  test('a ticked row carries the same key shape as a card', () => {
    const html = fallbackPage({ ...BRIEF, signals: [DENTIST] });
    expect(html).toContain(`data-done-keys="${DENTIST.sourceKey}|2026-08-13"`);
  });
});

describe('Kommende order', () => {
  const on = (day: string | null, id: string): RankedSignal => ({
    ...UPCOMING,
    id,
    title: `Ting ${id}`,
    dueAt: day,
    sourceKey: `post:${id}`,
    source: { ...SOURCE, key: `post:${id}`, title: `Post ${id}` },
  });
  const later = on('2026-08-20', 'a');
  const soon = on('2026-08-14', 'b');
  const undated = on(null, 'c');
  const position = (html: string, s: RankedSignal) => html.indexOf(`data-signal-id="${s.id}"`);

  test('is by date whatever the plan said, undated last under a divider', () => {
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, later, soon, undated] };
    const { plan } = parsePlan(
      { week: [{ signalId: undated.id }, { signalId: later.id }, { signalId: soon.id }] },
      brief,
    );
    const html = renderPlan(brief, plan);
    expect(position(html, soon)).toBeLessThan(position(html, later));
    expect(position(html, later)).toBeLessThan(html.indexOf('Uden fast dato'));
    expect(html.indexOf('Uden fast dato')).toBeLessThan(position(html, undated));
    expect(html).toContain('Kommende <span class="count" data-count>3</span>');
  });

  test('within a day the plan’s order holds', () => {
    const second = on('2026-08-14', 'd');
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, soon, second] };
    const { plan } = parsePlan({ week: [{ signalId: second.id }, { signalId: soon.id }] }, brief);
    const html = renderPlan(brief, plan);
    expect(position(html, second)).toBeLessThan(position(html, soon));
  });

  test('a card whose day has passed goes last, under Tidligere — never leading the list', () => {
    // A floor (`important`, `high`) can keep a past-dated signal in the week
    // tier; chronological order would otherwise put it first. The chip keeps
    // its real date; it just does not head a list called "upcoming".
    const stale = on('2026-08-11', 'e');
    const brief: RankedBrief = { ...BRIEF, signals: [stale, soon, undated] };
    const html = fallbackPage(brief);
    expect(position(html, soon)).toBeLessThan(position(html, undated));
    expect(position(html, undated)).toBeLessThan(html.indexOf('Tidligere'));
    expect(html.indexOf('Tidligere')).toBeLessThan(position(html, stale));
    expect(html).toContain('Tirsdag 11. august');
    // A stale card on its own is still shown, without a divider to separate it from nothing.
    expect(fallbackPage({ ...BRIEF, signals: [stale] })).not.toContain('Tidligere');
  });

  test('no divider when everything is dated, or nothing is', () => {
    expect(fallbackPage({ ...BRIEF, signals: [soon, later] })).not.toContain('Uden fast dato');
    expect(fallbackPage({ ...BRIEF, signals: [undated] })).not.toContain('Uden fast dato');
  });
});

// The reader's escape hatch: a card is a summary, and a summary is only worth
// trusting if the thing it summarises is one tap away.
describe('more-block', () => {
  const conversation = (
    count: number,
    extra: Partial<{ total: number; truncated: boolean }> = {},
  ) => ({
    messages: Array.from({ length: count }, (_, i) => ({
      from: i % 2 === 0 ? 'Yrsa Storm' : 'Søren',
      at: `2026-08-1${i}T09:0${i}:00`,
      text: `Besked nummer ${i}.`,
    })),
    total: extra.total ?? count,
    truncated: extra.truncated ?? false,
  });

  const threadBrief = (
    source: Partial<SourceItem>,
    signal: Partial<RankedSignal> = {},
  ): RankedBrief => {
    const item = sourceItem({ key: 'thread:9', kind: 'thread', title: 'Møde om Alma', ...source });
    const ranked: RankedSignal = { ...MUST_SHOW, sourceKey: item.key, source: item, ...signal };
    return { ...BRIEF, signals: [ranked], input: { ...INPUT, items: [item] } };
  };

  test('a conversation opens as the whole exchange, sender and time on each message', () => {
    const brief = threadBrief({ text: 'Møde om Alma', conversation: conversation(4) });
    const html = fallbackPage(brief);
    expect(html).toContain('Læs hele samtalen · 4 beskeder');
    for (let i = 0; i < 4; i++) expect(html).toContain(`Besked nummer ${i}.`);
    expect(html).toContain('<b>Yrsa Storm</b>');
    expect(html).toContain('10. aug');
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('it is collapsed by default — most days the summary is enough', () => {
    const html = fallbackPage(threadBrief({ text: 'Møde om Alma', conversation: conversation(4) }));
    expect(html).toContain('<details class="more">');
    expect(html).not.toContain('<details class="more" open');
  });

  test('a thread fetched in part says so rather than passing for the whole', () => {
    const brief = threadBrief({
      text: 'Møde om Alma',
      conversation: conversation(3, { total: 11, truncated: true }),
    });
    const html = fallbackPage(brief);
    expect(html).toContain('Læs samtalen · 3 af 11 beskeder');
    expect(html).toContain('Ikke alle beskeder i tråden vises her');
  });

  test('the conversation summary sits on the card, above the exchange', () => {
    const brief = threadBrief({ text: 'Møde om Alma', conversation: conversation(4) });
    const html = fallbackPage(brief, {
      conversations: { 'thread:9': 'Yrsa foreslår tre datoer; I har ikke svaret endnu.' },
    });
    expect(html).toContain(
      '<p class="gist">Yrsa foreslår tre datoer; I har ikke svaret endnu.</p>',
    );
    expect(html.indexOf('class="gist"')).toBeLessThan(html.indexOf('<details class="more">'));
  });

  test('a post longer than its quote gets a plain "Læs mere" with the whole text', () => {
    const long = sourceItem({
      key: 'post:7',
      title: 'Skolefoto',
      text: 'Kære forældre.\n\nVi holder skolefoto på tirsdag.\n\nHusk pænt tøj.',
    });
    const brief: RankedBrief = {
      ...BRIEF,
      signals: [{ ...MUST_SHOW, sourceKey: long.key, source: long, quote: 'Husk pænt tøj.' }],
      input: { ...INPUT, items: [long] },
    };
    const html = fallbackPage(brief);
    expect(html).toContain('Læs mere');
    expect(html).toContain('<p>Kære forældre.</p>');
    expect(html).toContain('<p>Vi holder skolefoto på tirsdag.</p>');
  });

  test('no toggle when the card already shows the whole source', () => {
    const short = sourceItem({ key: 'post:7', title: 'Fri', text: 'Vi holder fri på fredag.' });
    const brief: RankedBrief = {
      ...BRIEF,
      signals: [
        { ...MUST_SHOW, sourceKey: short.key, source: short, quote: 'Vi holder fri på fredag.' },
      ],
      input: { ...INPUT, items: [short] },
    };
    expect(fallbackPage(brief)).not.toContain('class="more"');
  });

  test('source prose is escaped, not rendered', () => {
    const nasty = sourceItem({
      key: 'thread:9',
      kind: 'thread',
      title: 'Hej',
      text: 'x',
      conversation: {
        messages: [
          { from: '<img src=x onerror=alert(1)>', at: null, text: 'a' },
          { from: 'Yrsa', at: null, text: '<script>alert(1)</script>' },
          { from: 'Yrsa', at: null, text: 'Se @import url(https://evil.example/x.css)' },
        ],
        total: 3,
        truncated: false,
      },
    });
    const brief: RankedBrief = {
      ...BRIEF,
      signals: [{ ...MUST_SHOW, sourceKey: nasty.key, source: nasty, quote: null }],
      input: { ...INPUT, items: [nasty] },
    };
    const html = fallbackPage(brief);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    // A parent quoting a stylesheet URL must not fail the whole layout — the
    // self-contained rule is about tags this renderer wrote, not about prose.
    expect(validatePage(html, brief)).toEqual([]);
  });

  test('the context section carries it too — that is where the unexplained things live', () => {
    const item = sourceItem({
      key: 'thread:12',
      kind: 'thread',
      title: 'Legeaftale',
      text: 'Legeaftale',
      conversation: conversation(3),
    });
    const brief: RankedBrief = { ...BRIEF, signals: [], unusedSources: [item] };
    const html = fallbackPage(brief, {
      conversations: { 'thread:12': 'Fire forældre aftaler en legedag.' },
    });
    expect(html).toContain('Fire forældre aftaler en legedag.');
    expect(html).toContain('Læs hele samtalen · 3 beskeder');
  });
});

describe('fallbackPage', () => {
  test('still satisfies every invariant through the shared renderer', () => {
    expect(validatePage(fallbackPage(BRIEF), BRIEF)).toEqual([]);
  });

  test('renders albums as tiles', () => {
    expect(fallbackPage(BRIEF)).toContain('Skovtur med 2E');
  });

  test('a day with a failed fetch hoists datastatus above the action list', () => {
    const html = fallbackPage(BRIEF); // INPUT carries a warn-level health note
    expect(html.indexOf('data-block="datastatus"')).toBeLessThan(html.indexOf('Kræver handling'));
  });

  test('a clean day keeps datastatus at the bottom', () => {
    const clean: RankedBrief = {
      ...BRIEF,
      input: { ...INPUT, health: [{ level: 'ok', message: 'Alle kilder svarede.' }] },
    };
    const html = fallbackPage(clean);
    expect(html.indexOf('data-block="datastatus"')).toBeGreaterThan(
      html.indexOf('Kræver handling'),
    );
    expect(validatePage(html, clean)).toEqual([]);
  });
});

// The renderer serves whatever family and whatever day it is handed. Each
// shape must hold for the fallback, for an empty plan (model contributed
// nothing) and for an eager plan (model touched everything it may touch).
describe('data shapes', () => {
  const child = (firstName: string, className: string | null) => ({
    name: `${firstName} Eksempelsen`,
    firstName,
    institution: className ? 'Eksempelskolen' : 'Børnehuset Eksemplet',
    className,
    presence: null,
  });

  const withChildren = (...children: ReturnType<typeof child>[]): RankedBrief => ({
    ...BRIEF,
    input: { ...INPUT, family: { ...INPUT.family, children } },
  });

  const SHAPES: Array<[string, RankedBrief]> = [
    ['single school child', BRIEF],
    [
      'three children across two institutions',
      withChildren(child('Alma', '2E'), child('Viggo', null), child('Ida', null)),
    ],
    ['single daycare child, no class name', withChildren(child('Ida', null))],
    [
      'empty day — no signals, no albums, no warnings',
      { ...BRIEF, signals: [], input: { ...INPUT, albums: [], health: [] } },
    ],
    [
      'sparse signal — no child, quote, why or date',
      {
        ...BRIEF,
        signals: [{ ...MUST_SHOW, child: null, quote: null, why: null, dueAt: null }, HIDDEN],
      },
    ],
    [
      'heavy day — twelve action items',
      {
        ...BRIEF,
        signals: [
          ...Array.from({ length: 12 }, (_, i) => ({ ...MUST_SHOW, id: `plan:x:0#${i}` })),
          HIDDEN,
        ],
      },
    ],
  ];

  for (const [name, brief] of SHAPES) {
    test(`every layout holds for: ${name}`, () => {
      expect(validatePage(fallbackPage(brief), brief)).toEqual([]);

      const empty = parsePlan({}, brief).plan;
      expect(validatePage(renderPlan(brief, empty), brief)).toEqual([]);

      const eager = parsePlan(
        {
          topline: 'Simuleret topline.',
          emptyAct: 'Helt roligt i dag.',
          act: [...brief.signals.filter((s) => s.tier === 'act')].reverse().map((s) => ({
            signalId: s.id,
            title: `Omskrevet: ${s.title}`,
            why: 'Simuleret begrundelse.',
          })),
          week: brief.signals.filter((s) => s.tier === 'week').map((s) => ({ signalId: s.id })),
        },
        brief,
      ).plan;
      expect(validatePage(renderPlan(brief, eager), brief)).toEqual([]);
    });
  }
});
