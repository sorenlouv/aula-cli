import { describe, expect, test } from 'bun:test';
import { briefInput, card, sourceItem } from '../testing/brief-fixtures.ts';
import { classifyAudience } from './collect.ts';
import { CARD_CAP, cardsFromRules, explain, rank } from './rank.ts';
import type { BriefInput, Card, SourceItem } from './types.ts';

const TODAY = new Date(2026, 7, 13); // Thursday 13 August 2026

function item(partial: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return sourceItem({ title: 'Titel', at: null, author: null, ...partial });
}

function input(items: SourceItem[]): BriefInput {
  return briefInput({ today: '2026-08-13', items });
}

const POST = item({ key: 'post:1', title: 'Skolefoto', text: 'Tilmeld jeres barn senest 17/8.' });
const THREAD = item({ key: 'thread:2', kind: 'thread', title: 'Møde om Alma' });
const PLAN = item({ key: 'plan:x:0', kind: 'plan', title: 'Idræt', at: '2026-08-14T08:00:00' });
const DIARY = item({ key: 'post:3', title: 'Tirsdag på stuen', text: 'Vi malede sten.' });
const DENTIST = item({
  key: 'cal:far@eksempel.dk:dentist:2026-08-14T13:30:00+02:00',
  kind: 'personal',
  title: 'Tandlæge',
  at: '2026-08-14T13:30:00',
  audience: 'family',
});
const AULA_MEETING = item({
  key: 'event:4',
  kind: 'event',
  title: 'Forældremøde',
  at: '2026-08-14T15:00:00',
  endsAt: '2026-08-14T17:00:00',
});
const DENTIST_VERDICT = {
  sourceKey: DENTIST.key,
  relevant: true,
  summary: 'Tandlægetid fredag eftermiddag.',
  reason: 'Aftalen påvirker familiens fredag.',
};

describe('classifyAudience', () => {
  const classes = new Set(['Sommerfuglene', '1B']);
  test("a child's own stue or class is `class`", () => {
    expect(classifyAudience(['Sommerfuglene', 'Mariehønsene'], classes)).toBe('class');
  });
  test('the whole house or school is `institution`', () => {
    expect(classifyAudience(['Børnehuset Eksemplet'], classes)).toBe('institution');
  });
  test('every parent in the municipality is `municipal`', () => {
    expect(classifyAudience(['Alle forældre alle skoler'], classes)).toBe('municipal');
  });
  test('no groups at all is not municipal — absence of evidence fails towards showing', () => {
    expect(classifyAudience([], classes)).toBe('institution');
  });
});

describe('rank: placement', () => {
  const cards: Card[] = [
    card({ id: 'a', title: 'Senere', date: '2026-08-20', sourceKeys: ['post:1'] }),
    card({ id: 'b', title: 'Snart', date: '2026-08-14', sourceKeys: ['thread:2'] }),
    card({ id: 'c', title: 'Udateret', date: null, sourceKeys: ['post:3'] }),
    card({ id: 'd', title: 'Forbi', date: '2026-08-11', sourceKeys: ['plan:x:0'] }),
  ];
  const brief = rank(input([POST, THREAD, DIARY, PLAN]), { model: cards, rules: [], hidden: [] });

  test('upcoming by date, then undated, then past', () => {
    expect(brief.cards.map((c) => c.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(brief.cards.map((c) => c.placement)).toEqual([
      'upcoming',
      'upcoming',
      'undated',
      'past',
    ]);
  });

  test('today counts as upcoming, not past', () => {
    const today = card({ id: 't', date: '2026-08-13', sourceKeys: ['post:1'] });
    const b = rank(input([POST]), { model: [today], rules: [], hidden: [] });
    expect(b.cards[0]?.placement).toBe('upcoming');
  });

  test('an undated weekly routine is placed on today when today is its weekday', () => {
    const running = item({
      key: 'post:running',
      title: 'Fast løbedag',
      text: 'Vi løber fast om mandagen. Husk løbetøj og løbesko.',
    });
    const next = item({ key: 'post:next', title: 'Turdag' });
    const monday = briefInput({ today: '2026-08-24', items: [running, next] });
    const brief = rank(monday, {
      model: [
        card({
          id: 'running',
          title: 'Send Alma i løbetøj om mandagen',
          summary: 'Det er en fast løbedag om mandagen.',
          date: null,
          sourceKeys: [running.key],
        }),
        card({ id: 'next', title: 'Turdag', date: '2026-08-25', sourceKeys: [next.key] }),
      ],
      rules: [],
      hidden: [],
    });

    expect(brief.cards.map((entry) => entry.id)).toEqual(['running', 'next']);
    expect(brief.cards[0]).toMatchObject({
      date: '2026-08-24',
      placement: 'upcoming',
      recurrenceWeekday: 1,
    });
  });

  test("on the same day, the model's order survives", () => {
    const info = card({ id: 'i', date: '2026-08-14', sourceKeys: ['post:1'] });
    const act = card({ id: 'x', date: '2026-08-14', needsAction: true, sourceKeys: ['thread:2'] });
    const b = rank(input([POST, THREAD]), { model: [info, act], rules: [], hidden: [] });
    expect(b.cards.map((c) => c.id)).toEqual(['i', 'x']);
  });

  test('among past cards the most recent comes first', () => {
    const older = card({ id: 'o', date: '2026-08-01', sourceKeys: ['post:1'] });
    const newer = card({ id: 'n', date: '2026-08-10', sourceKeys: ['thread:2'] });
    const b = rank(input([POST, THREAD]), { model: [older, newer], rules: [], hidden: [] });
    expect(b.cards.map((c) => c.id)).toEqual(['n', 'o']);
  });

  test('the sources a card rests on are resolved onto it', () => {
    expect(brief.cards.find((c) => c.id === 'a')?.sources.map((s) => s.key)).toEqual(['post:1']);
  });
});

describe('rank: the cap', () => {
  test('the first CARD_CAP model cards stay, regardless of date or action', () => {
    const items: SourceItem[] = [];
    const cards: Card[] = [];
    for (let i = 0; i < CARD_CAP + 3; i++) {
      items.push(item({ key: `post:${i}` }));
      const shape = i % 3;
      cards.push(
        card({
          id: `c${i}`,
          title: `Kort ${i}`,
          date: shape === 2 ? null : `2026-08-${String(14 + (i % 10)).padStart(2, '0')}`,
          needsAction: shape === 0,
          sourceKeys: [`post:${i}`],
        }),
      );
    }
    const brief = rank(input(items), { model: cards, rules: [], hidden: [] });
    expect(brief.cards).toHaveLength(CARD_CAP);
    expect(brief.folded).toHaveLength(3);
    expect(new Set(brief.cards.map((c) => c.id))).toEqual(
      new Set(cards.slice(0, CARD_CAP).map((c) => c.id)),
    );
    expect(brief.folded.map((c) => c.id)).toEqual(cards.slice(CARD_CAP).map((c) => c.id));
    expect(brief.folded.every((c) => c.reasons.some((r) => r.includes('CARD_CAP')))).toBe(true);
    // The kept cards are still in page order.
    const dated = brief.cards.filter((c) => c.placement === 'upcoming').map((c) => c.date);
    expect(dated).toEqual([...dated].sort());
  });

  test('a folded card is neither a card nor lost: its sources are covered', () => {
    const items = Array.from({ length: CARD_CAP + 1 }, (_, i) => item({ key: `post:${i}` }));
    const cards = items.map((s, i) => card({ id: `c${i}`, sourceKeys: [s.key] }));
    const brief = rank(input(items), { model: cards, rules: [], hidden: [] });
    expect(brief.folded).toHaveLength(1);
    expect(brief.rest).toHaveLength(0);
  });

  test('a card after next week is folded without consuming an in-window slot', () => {
    const items = Array.from({ length: CARD_CAP + 1 }, (_, i) => item({ key: `post:${i}` }));
    const later = card({
      id: 'later',
      title: 'Forældremøde senere',
      date: '2026-08-24',
      sourceKeys: [items[0]!.key],
    });
    const within = items.slice(1).map((source, i) =>
      card({
        id: `within:${i}`,
        title: `Kort ${i}`,
        date: '2026-08-14',
        sourceKeys: [source.key],
      }),
    );

    const brief = rank(input(items), {
      model: [later, ...within],
      rules: [],
      hidden: [],
    });

    expect(brief.cards).toHaveLength(CARD_CAP);
    expect(brief.cards.some((entry) => entry.id === 'later')).toBe(false);
    expect(brief.folded.map((entry) => entry.id)).toEqual(['later']);
    expect(brief.folded[0]?.reasons).toContain('after overview(2026-08-23) → folded');
    expect(brief.rest).toEqual([]);
  });
});

describe('rank: personal appointments in the shared timeline', () => {
  test('known starts on the same day are chronological across Aula and Google', () => {
    const meeting = card({
      id: 'meeting',
      title: 'Forældremøde',
      date: '2026-08-14',
      sourceKeys: [AULA_MEETING.key],
    });
    const brief = rank(input([AULA_MEETING, DENTIST]), {
      model: [meeting],
      personalEvents: [DENTIST_VERDICT],
      rules: [],
      hidden: [],
    });

    expect(brief.timeline.map((entry) => entry.title)).toEqual(['Tandlæge', 'Forældremøde']);
    expect(brief.personalEvents[0]).toMatchObject({
      sourceKey: DENTIST.key,
      summary: DENTIST_VERDICT.summary,
      modelRank: 1,
    });
  });

  test('irrelevant appointments are hidden; missing verdicts fail open', () => {
    const hidden = rank(input([DENTIST]), {
      model: [],
      personalEvents: [{ ...DENTIST_VERDICT, relevant: false }],
      rules: [],
      hidden: [],
    });
    expect(hidden.timeline).toEqual([]);
    expect(hidden.hidden.map((source) => source.key)).toEqual([DENTIST.key]);

    const missing = rank(input([DENTIST]), {
      model: [],
      personalEvents: [],
      rules: [],
      hidden: [],
    });
    expect(missing.personalEvents).toHaveLength(1);
    expect(missing.personalEvents[0]?.summary).toBe('');
    expect(missing.personalEvents[0]?.reasons).toContain('calendar verdict missing → shown');
  });

  test('compact appointments do not consume the full-card cap', () => {
    const items = Array.from({ length: CARD_CAP + 1 }, (_, index) =>
      item({ key: `post:${100 + index}` }),
    );
    const cards = items.map((source, index) => card({ id: `c${index}`, sourceKeys: [source.key] }));
    const brief = rank(input([...items, DENTIST]), {
      model: cards,
      personalEvents: [DENTIST_VERDICT],
      rules: [],
      hidden: [],
    });

    expect(brief.cards).toHaveLength(CARD_CAP);
    expect(brief.personalEvents).toHaveLength(1);
    expect(brief.timeline).toHaveLength(CARD_CAP + 1);
    expect(brief.folded).toHaveLength(1);
  });

  test('an appointment after next week is excluded explicitly, never silently', () => {
    const later = item({
      ...DENTIST,
      key: 'cal:family:later',
      at: '2026-08-24T13:30:00',
    });
    const brief = rank(input([later]), {
      model: [],
      personalEvents: [
        {
          sourceKey: later.key,
          relevant: true,
          summary: 'En senere aftale.',
          reason: 'Aftalen vedrører et barn.',
        },
      ],
      rules: [],
      hidden: [],
    });

    expect(brief.timeline).toEqual([]);
    expect(brief.personalEvents).toEqual([]);
    expect(brief.degraded).toEqual([
      'Kalenderaftalen "Tandlæge" den 2026-08-24 ligger efter oversigtens slutdato 2026-08-23 og blev ikke vist.',
    ]);
  });
});

describe('rank: what is not a card', () => {
  test('sources no card covers are the rest; the family calendar is neither', () => {
    const brief = rank(input([POST, DIARY, DENTIST]), {
      model: [card({ id: 'a', sourceKeys: ['post:1'] })],
      rules: [],
      hidden: [],
    });
    expect(brief.rest.map((s) => s.key)).toEqual(['post:3']);
    expect(brief.hidden).toEqual([]);
  });

  test('hidden sources are listed as hidden, never as rest', () => {
    const brief = rank(input([POST, DIARY]), {
      model: [card({ id: 'a', sourceKeys: ['post:1'] })],
      rules: [],
      hidden: ['post:3'],
    });
    expect(brief.hidden.map((s) => s.key)).toEqual(['post:3']);
    expect(brief.rest).toEqual([]);
  });

  test('a source cited by a card is shown, even when the model also hid it', () => {
    const brief = rank(input([POST, THREAD]), {
      model: [card({ id: 'a', sourceKeys: ['post:1', 'thread:2'] })],
      rules: [],
      hidden: ['thread:2'],
    });

    expect(brief.cards[0]?.sourceKeys).toEqual(['post:1', 'thread:2']);
    expect(brief.hidden).toEqual([]);
  });

  test('a hidden key that names no source is ignored', () => {
    const brief = rank(input([POST]), { model: [], rules: [], hidden: ['post:404'] });
    expect(brief.hidden).toEqual([]);
  });

  test('a card citing a source that is not in the input is dropped and reported', () => {
    const brief = rank(input([POST]), {
      model: [card({ id: 'ghost', title: 'Opdigtet', sourceKeys: ['post:404'] })],
      rules: [],
      hidden: [],
    });
    expect(brief.cards).toEqual([]);
    expect(brief.degraded.some((d) => d.includes('Opdigtet'))).toBe(true);
  });
});

describe('rank: without a model', () => {
  test('the rule cards are the cards', () => {
    const rules = cardsFromRules(input([POST, PLAN]), TODAY);
    const brief = rank(input([POST, PLAN]), { model: null, rules, hidden: [] });
    expect(brief.cards.length).toBe(rules.length);
    expect(brief.cards.every((c) => c.origin === 'rule')).toBe(true);
  });

  test('when the model ran, rule cards for uncovered, unflagged sources are not added', () => {
    // The model chose not to make a card of it; that is a choice, not a gap.
    const rules = cardsFromRules(input([POST]), TODAY);
    const brief = rank(input([POST, THREAD]), {
      model: [card({ id: 'a', sourceKeys: ['thread:2'] })],
      rules,
      hidden: [],
    });
    expect(brief.cards.map((c) => c.id)).toEqual(['a']);
    expect(brief.rest.map((s) => s.key)).toEqual(['post:1']);
  });

  test('a partial model answer is supplemented by deterministic obligations', () => {
    const rules = cardsFromRules(input([POST]), TODAY);
    const brief = rank(input([POST, THREAD]), {
      model: [card({ id: 'a', sourceKeys: ['thread:2'] })],
      rules,
      hidden: [],
      supplementRules: true,
    });
    expect(rules[0]).toBeDefined();
    expect(brief.cards.map((entry) => entry.id)).toContain(rules[0]!.id);
  });
});

describe('cardsFromRules', () => {
  test('a gear reminder in a weekly plan lands on the plan’s day and asks for action', () => {
    const plan = item({
      key: 'plan:easyiq:2026-W33:0',
      kind: 'plan',
      title: 'Idræt',
      text: 'Husk skiftetøj og badeting til efter timen.',
      at: '2026-08-13T08:00:00',
      childNames: ['Alma Signe Eksempelsen'],
    });
    const [rule] = cardsFromRules(input([plan]), TODAY);
    expect(rule?.date).toBe('2026-08-13');
    expect(rule?.needsAction).toBe(true);
    expect(rule?.children).toEqual(['Alma']);
    expect(rule?.summary).toBe('Husk skiftetøj og badeting til efter timen.');
  });

  test('a dateless reminder in a thread is not dated to the day it was sent', () => {
    // Real case: an unread thread from 11 August reminding us of a meeting in
    // September. The rules found "minde om" but no date in that sentence, and
    // the card used to borrow the thread's timestamp as its date.
    const thread = item({
      key: 'thread:1',
      kind: 'thread',
      title: 'Møde ang. Alma',
      text: 'Jeg har lovet Merete fra kontoret at minde om netværksmødet.',
      at: '2026-08-11T20:19:00',
    });
    const [rule] = cardsFromRules(input([thread]), TODAY);
    expect(rule?.date).toBeNull();
  });

  test('a thread rule resolves relative language from the message that contains it', () => {
    const thread = item({
      key: 'thread:relative',
      kind: 'thread',
      title: 'Aftale',
      text: 'Husk at vi ses i morgen.\n\nTak for aftalen.',
      at: '2026-08-22T09:00:00+00:00',
      conversation: {
        messages: [
          {
            from: 'Palle',
            at: '2026-08-10T09:00:00+00:00',
            text: 'Husk at vi ses i morgen.',
          },
          { from: 'Yrsa', at: '2026-08-22T09:00:00+00:00', text: 'Tak for aftalen.' },
        ],
        total: 2,
        truncated: false,
      },
    });

    expect(cardsFromRules(input([thread]), TODAY)[0]?.date).toBe('2026-08-11');
  });

  test('the Danish extractors are not run over a calendar title', () => {
    const source = { ...DENTIST, title: 'Frist for tilmelding d. 18/9 kl. 09:00' };
    expect(cardsFromRules(input([source]), TODAY)).toEqual([]);
  });

  test('the same sentence matched twice is one card; two obligations are two', () => {
    const post = item({
      key: 'post:5',
      text: 'Tilmeld jeres barn senest 20/8. Udfyld kontaktsedlen senest 25/8.',
      at: '2026-08-12T09:00:00',
    });
    const brief = rank(input([post]), {
      model: null,
      rules: cardsFromRules(input([post]), TODAY),
      hidden: [],
    });
    expect([...brief.cards, ...brief.folded].map((c) => c.date).sort()).toEqual([
      '2026-08-20',
      '2026-08-25',
    ]);
    expect(brief.folded.map((c) => c.date)).toEqual(['2026-08-25']);
  });

  test('two different obligations on the same day remain two cards', () => {
    const post = item({
      key: 'post:6',
      text: 'Husk badetøj på mandag. Husk madpakke på mandag.',
      at: '2026-08-12T09:00:00',
    });
    const brief = rank(input([post]), {
      model: null,
      rules: cardsFromRules(input([post]), TODAY),
      hidden: [],
    });
    expect(brief.cards.map((c) => c.summary)).toEqual([
      'Husk badetøj på mandag.',
      'Husk madpakke på mandag.',
    ]);
  });
});

describe('explain', () => {
  test('names every card with its placement and sources', () => {
    const brief = rank(input([POST, THREAD]), {
      model: [
        card({
          id: 'a',
          title: 'Skolefoto',
          date: '2026-08-17',
          needsAction: true,
          sourceKeys: ['post:1'],
        }),
        card({ id: 'b', title: 'Møde', sourceKeys: ['thread:2'] }),
      ],
      rules: [],
      hidden: [],
    });
    const text = explain(brief);
    expect(text).toContain('2 Aula-kort');
    expect(text).toContain('[upcoming] ! Skolefoto  (2026-08-17)');
    expect(text).toContain('[undated]   Møde');
    expect(text).toContain('model rank:1');
    expect(text).toContain('model rank:2');
    expect(text).toContain('kilder: post:1');
  });
});
