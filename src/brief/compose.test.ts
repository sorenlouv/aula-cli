import { describe, expect, test } from 'bun:test';
import { fallbackPage, parsePlan, renderPlan } from './compose.ts';
import type { BriefInput, RankedBrief, RankedSignal, SourceItem } from './types.ts';
import { validatePage } from './validate.ts';

const SOURCE: SourceItem = {
  key: 'plan:x:0',
  kind: 'plan',
  title: 'Idræt',
  text: 'Husk skiftetøj og badeting til efter timen.',
  at: '2026-08-13T08:00:00',
  author: 'EasyIQ',
  authorRole: 'employee',
  groups: [],
  childNames: ['Alma Signe Eksempelsen'],
  audience: 'child',
  important: false,
  url: 'https://www.aula.dk/portal/#/ugeplan',
  attachments: [],
};

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
  sourceKey: 'post:9',
  source: { ...SOURCE, key: 'post:9', title: 'Forældrekursus', audience: 'municipal', groups: ['Alle forældre'] },
};

const INPUT: BriefInput = {
  generatedAt: '2026-08-13T06:30:00Z',
  today: '2026-08-13',
  isoWeek: '2026-W33',
  windowDays: 14,
  family: {
    guardian: 'Valdemar',
    children: [
      { name: 'Alma Signe Eksempelsen', firstName: 'Alma', institution: 'Eksempelskolen', className: '2E', presence: null },
    ],
    isSteppedUp: true,
  },
  items: [SOURCE],
  health: [
    { level: 'warn', message: 'Ugeplan for Viggo kunne ikke hentes — EasyIQ svarede HTTP 500.' },
  ],
  albums: [{ title: 'Skovtur med 2E', at: '2026-08-12', groups: ['2E'], childNames: ['Alma'] }],
  notificationCount: 0,
  newMediaCount: 0,
};

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
        handling: [{ signalId: MUST_SHOW.id, titel: '  Pak badeting  ' }],
        kommende: [{ signalId: UPCOMING.id }],
      },
      BRIEF,
    );
    expect(problems).toEqual([]);
    expect(plan.topline).toBe('Fotodag i morgen.');
    expect(plan.handling).toEqual([{ signalId: MUST_SHOW.id, titel: 'Pak badeting' }]);
    expect(plan.kommende).toEqual([{ signalId: UPCOMING.id }]);
  });

  test('drops an invented signalId and reports it', () => {
    const { plan, problems } = parsePlan({ handling: [{ signalId: 'digtet:op#0' }] }, BRIEF);
    expect(plan.handling).toEqual([]);
    expect(problems.some((p) => p.includes('digtet:op#0'))).toBe(true);
  });

  test('refuses to let the plan reopen the noise gate', () => {
    const { plan, problems } = parsePlan({ handling: [{ signalId: HIDDEN.id }] }, BRIEF);
    expect(plan.handling).toEqual([]);
    expect(problems.some((p) => p.includes(HIDDEN.id))).toBe(true);
  });

  test('first placement wins when the model lists an id twice', () => {
    const { plan } = parsePlan(
      { handling: [{ signalId: MUST_SHOW.id }], kommende: [{ signalId: MUST_SHOW.id }] },
      BRIEF,
    );
    expect(plan.handling).toHaveLength(1);
    expect(plan.kommende).toHaveLength(0);
  });

  test('tolerates garbage without throwing', () => {
    const { plan, problems } = parsePlan({ handling: 'alt muligt', kommende: [null, 42] }, BRIEF);
    expect(plan.handling).toEqual([]);
    expect(plan.kommende).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });

  test('strips a rewording that asserts a date no source supports', () => {
    const { plan, problems } = parsePlan(
      { handling: [{ signalId: MUST_SHOW.id, titel: 'Aflever sedlen inden søndag' }] },
      BRIEF,
    );
    expect(plan.handling).toEqual([{ signalId: MUST_SHOW.id }]); // rewording gone, card stays
    expect(problems.some((p) => p.includes('dato uden kilde') && p.includes('søndag'))).toBe(true);
  });

  test('a rewording may echo the signal’s own date', () => {
    // MUST_SHOW.dueAt 2026-08-13 is a Thursday.
    const { plan, problems } = parsePlan(
      { handling: [{ signalId: MUST_SHOW.id, titel: 'Badeting med torsdag' }] },
      BRIEF,
    );
    expect(problems).toEqual([]);
    expect(plan.handling[0]?.titel).toBe('Badeting med torsdag');
  });

  test('drops a plan topline with an invented date, keeping the fallback', () => {
    const { plan, problems } = parsePlan({ topline: 'Stor uge — fest 24/9!' }, BRIEF);
    expect(plan.topline).toBeUndefined();
    expect(problems.some((p) => p.startsWith('topline'))).toBe(true);
  });
});

describe('renderPlan', () => {
  test('a planned page satisfies every invariant', () => {
    const { plan } = parsePlan(
      { topline: 'Én ting i dag.', handling: [{ signalId: MUST_SHOW.id, hvorfor: 'Idræt i dag.' }] },
      BRIEF,
    );
    expect(validatePage(renderPlan(BRIEF, plan), BRIEF)).toEqual([]);
  });

  test('an omission in the plan deprioritises, never deletes', () => {
    const { plan } = parsePlan({ handling: [], kommende: [] }, BRIEF);
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
      { handling: [{ signalId: second.id }, { signalId: MUST_SHOW.id }] },
      brief,
    );
    const html = renderPlan(brief, plan);
    expect(html.indexOf(`data-signal-id="${second.id}"`)).toBeLessThan(
      html.indexOf(`data-signal-id="${MUST_SHOW.id}"`),
    );
  });

  test('rewording is escaped before it reaches the page', () => {
    const { plan } = parsePlan(
      { handling: [{ signalId: MUST_SHOW.id, titel: '<script>alert(1)</script>' }] },
      BRIEF,
    );
    const html = renderPlan(BRIEF, plan);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('quotes come verbatim from the signal, whatever the plan says', () => {
    const { plan } = parsePlan({ handling: [{ signalId: MUST_SHOW.id, titel: 'Kort' }] }, BRIEF);
    expect(renderPlan(BRIEF, plan)).toContain('«Husk skiftetøj og badeting til efter timen.»');
  });

  test('a promoted context signal does not repeat under Godt at vide', () => {
    const context: RankedSignal = {
      ...UPCOMING,
      id: 'post:8#0',
      title: 'Ny pædagog på stuen',
      tier: 'context',
      sourceKey: 'post:8',
      source: { ...SOURCE, key: 'post:8', title: 'Velkommen' },
    };
    const brief: RankedBrief = { ...BRIEF, signals: [MUST_SHOW, UPCOMING, context, HIDDEN] };
    const { plan, problems } = parsePlan({ kommende: [{ signalId: context.id }] }, brief);
    expect(problems).toEqual([]);
    const html = renderPlan(brief, plan);
    expect(html).toContain(`data-signal-id="${context.id}"`);
    expect(html.split(`data-source-id="${context.sourceKey}"`).length).toBe(2);
  });

  test('the new-chip comes from isNew, not from the model', () => {
    const { plan } = parsePlan({ handling: [{ signalId: MUST_SHOW.id }] }, BRIEF);
    const html = renderPlan(BRIEF, plan, { isNew: (key) => key === MUST_SHOW.sourceKey });
    expect(html).toContain('<span class="chip new">Ny</span>');
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
    expect(html.indexOf('data-block="datastatus"')).toBeGreaterThan(html.indexOf('Kræver handling'));
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
    ['three children across two institutions', withChildren(child('Alma', '2E'), child('Viggo', null), child('Ida', null))],
    ['single daycare child, no class name', withChildren(child('Ida', null))],
    ['empty day — no signals, no albums, no warnings', { ...BRIEF, signals: [], input: { ...INPUT, albums: [], health: [] } }],
    [
      'sparse signal — no child, quote, why or date',
      { ...BRIEF, signals: [{ ...MUST_SHOW, child: null, quote: null, why: null, dueAt: null }, HIDDEN] },
    ],
    [
      'heavy day — twelve action items',
      { ...BRIEF, signals: [...Array.from({ length: 12 }, (_, i) => ({ ...MUST_SHOW, id: `plan:x:0#${i}` })), HIDDEN] },
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
          tomHandling: 'Helt roligt i dag.',
          handling: [...brief.signals.filter((s) => s.tier === 'act')]
            .reverse()
            .map((s) => ({ signalId: s.id, titel: `Omskrevet: ${s.title}`, hvorfor: 'Simuleret begrundelse.' })),
          kommende: brief.signals.filter((s) => s.tier === 'week').map((s) => ({ signalId: s.id })),
        },
        brief,
      ).plan;
      expect(validatePage(renderPlan(brief, eager), brief)).toEqual([]);
    });
  }
});
