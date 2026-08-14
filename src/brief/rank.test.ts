import { describe, expect, test } from 'bun:test';
import { classifyAudience } from './collect.ts';
import { ACT_CAP, rank, signalsFromRules } from './rank.ts';
import type { BriefInput, Signal, SourceItem } from './types.ts';

const TODAY = new Date(2026, 7, 13);

function item(partial: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return {
    kind: 'post',
    title: 'Titel',
    text: '',
    at: null,
    author: null,
    authorRole: 'employee',
    groups: [],
    childNames: [],
    audience: 'class',
    important: false,
    url: null,
    attachments: [],
    ...partial,
  };
}

function input(items: SourceItem[]): BriefInput {
  return {
    generatedAt: TODAY.toISOString(),
    today: '2026-08-13',
    isoWeek: '2026-W33',
    windowDays: 14,
    family: { guardian: 'Mikkel', children: [], isSteppedUp: true },
    items,
    health: [],
    albums: [],
    notificationCount: 0,
    newMediaCount: 0,
  };
}

describe('classifyAudience', () => {
  const classGroups = new Set(['Myretuen', 'Troldeungerne', '2E']);

  test('a childs own stue is class-level', () => {
    expect(classifyAudience(['Myretuen', 'Regnbuen'], classGroups)).toBe('class');
  });

  test('the whole institution is institution-level, not class-level', () => {
    // Every child belongs to this group, which is what makes membership alone
    // useless as a filter.
    expect(classifyAudience(['Børnehuset Eksemplet'], classGroups)).toBe('institution');
  });

  test('a year band is institution-level', () => {
    expect(classifyAudience(['Indskoling (elever+forældre+klasseteams) 26-27'], classGroups)).toBe(
      'institution',
    );
  });

  test('the school photo lists stay institution-level', () => {
    // Sent school-wide, and genuinely relevant — the whole point of keeping
    // `institution` separate from `municipal`.
    expect(
      classifyAudience(
        ['PERSONALE (Alle)', 'Gruppeordningen (elever+forældre+personale) 26-27', 'Eksempelskolen (elever+forældre+medarbejdere) 26-27'],
        classGroups,
      ),
    ).toBe('institution');
  });

  test('cross-institution distribution lists are municipal', () => {
    expect(
      classifyAudience(['Alle forældre alle skoler', 'Alle forældre i alle dagtilbud'], classGroups),
    ).toBe('municipal');
  });

  test('one non-municipal group is enough to keep it institution-level', () => {
    expect(classifyAudience(['Alle forældre alle skoler', 'Eksempelskolen'], classGroups)).toBe(
      'institution',
    );
  });

  test('an unknown audience is not a municipal one', () => {
    // Aula leaves sharedWithGroups off often enough that this decides whether
    // real school content is shown. `every` on an empty list says yes to
    // anything, which put these posts in the one tier that is never rendered.
    expect(classifyAudience([], classGroups)).toBe('institution');
  });
});

describe('rank', () => {
  test('a municipal offer with a real deadline is still hidden', () => {
    // The exact case that was wrong in the first mockup: the deadline is
    // genuine, and it must not buy the item a place at the top.
    const brief = rank(
      input([
        item({
          key: 'post:1',
          title: 'Tilbud om forældrekursus',
          text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
          audience: 'municipal',
        }),
      ]),
      signalsFromRules(
        input([
          item({
            key: 'post:1',
            title: 'Tilbud om forældrekursus',
            text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
            audience: 'municipal',
          }),
        ]),
        TODAY,
      ),
    );
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('hidden');
    expect(brief.signals[0]?.mustShow).toBe(false);
  });

  test('a broad item Aula itself flagged important is not buried', () => {
    const items = [
      item({
        key: 'post:2',
        title: 'Skolen er lukket',
        text: 'Husk at skolen er lukket på mandag.',
        audience: 'municipal',
        important: true,
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    // A closure the school deliberately flagged is something to act on, not
    // something to file away — the content carries it past its broad address.
    expect(brief.signals[0]?.tier).toBe('act');
  });

  test('a gear reminder for one child reaches the action tier', () => {
    const items = [
      item({
        key: 'plan:easyiq:2026-W33:0',
        kind: 'plan',
        title: 'Idræt',
        text: 'Husk skiftetøj og badeting til efter timen.',
        at: '2026-08-13T08:00:00',
        childNames: ['Alma Sofie Eksempelsen'],
        audience: 'child',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals[0]?.tier).toBe('act');
    expect(brief.signals[0]?.child).toBe('Alma');
    expect(brief.signals[0]?.dueAt).toBe('2026-08-13');
    expect(brief.signals[0]?.mustShow).toBe(true);
  });

  test('the same offer sent by two institutions is merged, not shown twice', () => {
    const items = [
      item({
        key: 'post:10',
        title: 'Forældrekurset Trivsel i familien',
        text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
        audience: 'municipal',
      }),
      item({
        key: 'post:11',
        title: 'Forældrekurset Trivsel i familien',
        text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
        audience: 'municipal',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.mergedSourceKeys).toHaveLength(1);
  });

  test('two obligations in one post both survive, on their own dates', () => {
    // Every rule hit inherits the item's title, so a title-only dedupe key
    // collapsed these into one and the 25/8 deadline disappeared — not even
    // into unusedSources, because the source counted as used.
    const items = [
      item({
        key: 'post:20',
        title: 'Nyt fra Myretuen',
        text: 'Husk at tilmelde jer sommerfesten senest d. 20/8. I skal også udfylde kontaktsedlen d. 25/8.',
        audience: 'class',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals.map((s) => s.dueAt).sort()).toEqual(['2026-08-20', '2026-08-25']);
  });

  test('an event and its application deadline are two dates, not one', () => {
    // rules.ts deliberately emits the second date in a sentence so the later
    // one is not lost; the ranker has to keep that promise.
    const items = [
      item({
        key: 'post:21',
        title: 'Informationsaften',
        text: 'Vi holder informationsaften d. 25. august og ansøgningsfrist d. 1. september.',
        audience: 'class',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals.map((s) => s.dueAt).sort()).toEqual(['2026-08-25', '2026-09-01']);
  });

  test('action tier is capped, and the overflow drops a tier rather than vanishing', () => {
    // Distinct subjects and no dates, so these are genuinely different things
    // rather than one thing said several times.
    const items = Array.from({ length: ACT_CAP + 3 }, (_, i) =>
      item({
        key: `plan:x:${i}`,
        title: `Opgave ${i}`,
        text: `Husk ${i} madpakke.`,
        childNames: ['Viggo Emil Eksempelsen'],
        audience: 'child',
      }),
    );
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals.filter((s) => s.tier === 'act')).toHaveLength(ACT_CAP);
    expect(brief.signals.filter((s) => s.tier === 'week')).toHaveLength(3);
    // Nothing was dropped.
    expect(brief.signals).toHaveLength(ACT_CAP + 3);
  });

  test('a signal citing an unknown source is refused, and says so', () => {
    const orphan: Signal = {
      id: 'x',
      kind: 'action',
      title: 'Opdigtet',
      child: null,
      dueAt: '2026-08-20',
      urgency: 'week',
      quote: null,
      why: null,
      sourceKey: 'post:does-not-exist',
      origin: 'model',
      concernsChild: false,
    };
    const brief = rank(input([]), [orphan]);
    expect(brief.signals).toHaveLength(0);
    expect(brief.degraded[0] ?? "").toContain('ukendt kilde');
  });

  test('a municipal message is judged on content, not just on its address', () => {
    // Every school being shut still shuts ours. Breadth is a prior, not a veto.
    const items = [
      item({
        key: 'post:30',
        title: 'Lærerstrejke',
        text: 'Alle skoler er lukket på mandag. Eleverne skal blive hjemme.',
        audience: 'municipal',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals[0]?.concernsChild).toBe(true);
    expect(brief.signals[0]?.tier).not.toBe('hidden');
  });

  test('a school-wide message about our own child is shown', () => {
    // School photo day: sent to the whole school, and it needs doing. Breadth
    // alone must not bury it.
    const items = [
      item({
        key: 'post:20',
        title: 'Skolefoto - uge 35',
        text: 'Fotografen kommer i uge 35. I bedes tilmelde jeres barn senest fredag.',
        audience: 'institution',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals[0]?.concernsChild).toBe(true);
    expect(brief.signals[0]?.tier).not.toBe('hidden');
    expect(brief.signals[0]?.tier).not.toBe('context');
  });

  test('a school-wide offer for the parents is folded away', () => {
    // Same breadth, same deadline, different thing entirely.
    const items = [
      item({
        key: 'post:21',
        title: 'Tilbud om forældrekursus',
        text: 'Kurset er målrettet forældre til børn, der oplever uro i hverdagen. Ansøgningsfristen er senest 1. september 2026.',
        audience: 'institution',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals[0]?.concernsChild).toBe(false);
    expect(brief.signals[0]?.tier).toBe('context');
  });

  test('sources that produced no signal are reported, never silently dropped', () => {
    const items = [item({ key: 'post:99', title: 'Hyggedag', text: 'Vi malede sten i dag.' })];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals).toHaveLength(0);
    expect(brief.unusedSources.map((s) => s.key)).toEqual(['post:99']);
  });
});
