import { describe, expect, test } from 'bun:test';
import { DEFAULT_PREFERENCES, MUNICIPAL_IS_NOISE } from '../preferences.ts';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { classifyAudience } from './collect.ts';
import { ACT_CAP, namedInPreferences, rank, signalsFromRules } from './rank.ts';
import type { BriefInput, Signal, SourceItem } from './types.ts';

const TODAY = new Date(2026, 7, 13);

function item(partial: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return sourceItem({ title: 'Titel', at: null, author: null, ...partial });
}

/**
 * A real installation, which always has the shipped opinions on its list —
 * `preferences.md` is seeded on first use. Ranking now depends on that list,
 * so a fixture without it would be testing an install nobody has.
 */
function input(items: SourceItem[], preferences: string[] = []): BriefInput {
  return briefInput({ items, preferences: [...DEFAULT_PREFERENCES, ...preferences] });
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
    expect(classifyAudience(['Indskoling Eksempel 26-27'], classGroups)).toBe(
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

  test('an important item no signal covered still reaches the page', () => {
    // The model-benchmark failure: mid-tier models read the vigtig-marked
    // photo sign-up as background noise and produced nothing for it.
    const items = [
      item({
        key: 'post:3',
        title: 'Skolefoto - uge 35!',
        text: 'Det er vigtigt at hver elev bliver oprettet.',
        audience: 'institution',
        important: true,
      }),
    ];
    const brief = rank(input(items), []); // no model, no rule signals at all
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.mustShow).toBe(true);
    expect(brief.signals[0]?.origin).toBe('rule');
    expect(brief.unusedSources).toHaveLength(0);
  });

  test('an important signal under-read as background is promoted to week', () => {
    const items = [
      item({ key: 'post:4', title: 'Skolefoto', text: 'Hver elev skal oprettes.', audience: 'institution', important: true }),
    ];
    const underRead: Signal = {
      id: 'model:0',
      kind: 'info',
      title: 'Skolefoto er på vej',
      child: null,
      dueAt: null,
      urgency: 'fyi',
      quote: null,
      why: null,
      sourceKey: 'post:4',
      origin: 'model',
      concernsChild: false,
    };
    const brief = rank(input(items), [underRead]);
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.mustShow).toBe(true);
    expect(brief.signals[0]?.reasons).toContain('aula-important floor → week');
  });

  test('an unimportant background item is not floored', () => {
    const items = [
      item({ key: 'post:5', title: 'Nyt fra køkkenet', text: 'Vi bager i næste uge.', audience: 'institution' }),
    ];
    const brief = rank(input(items), []);
    expect(brief.signals).toHaveLength(0);
    expect(brief.unusedSources).toHaveLength(1);
  });

  test('a gear reminder for one child reaches the action tier', () => {
    const items = [
      item({
        key: 'plan:easyiq:2026-W33:0',
        kind: 'plan',
        title: 'Idræt',
        text: 'Husk skiftetøj og badeting til efter timen.',
        at: '2026-08-13T08:00:00',
        childNames: ['Alma Signe Eksempelsen'],
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
        childNames: ['Viggo Birk Eksempelsen'],
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

describe('namedInPreferences', () => {
  const WISH = 'beskeder fra John (Hjaltes far) er altid vigtige';
  const JOHN = [WISH];

  test('finds the sender the family named', () => {
    expect(namedInPreferences('Esben Bille', JOHN)).toBe(WISH);
  });

  test('matches the Danish genitive, so "Idas mor" finds Ida', () => {
    expect(namedInPreferences('Karla Bille', ['Idas mor skriver om vigtige ting'])).not.toBeNull();
  });

  test('a name is a word, not a substring — this is the false positive that matters', () => {
    // "Ida" inside "sidan", "Per" inside "perfekt": a wish that merely happens
    // to contain those letters must not quietly promote a stranger's post.
    expect(namedInPreferences('Karla Bille', ['vi vil gerne vide besked om sidan'])).toBeNull();
    expect(namedInPreferences('Per Storm', ['dagen skal helst være perfekt'])).toBeNull();
  });

  test('short name parts are skipped: initials and particles match everything', () => {
    expect(namedInPreferences('Jo Berg', ['jo, det er vigtigt for os'])).toBeNull();
  });

  test('an author Aula did not give us matches nothing', () => {
    expect(namedInPreferences(null, JOHN)).toBeNull();
  });
});

describe('the preference floor', () => {
  const JOHN = 'beskeder fra John (Hjaltes far) er altid vigtige';

  const withWish = (items: SourceItem[], wishes: string[]) => input(items, wishes);

  const backgroundNote: Signal = {
    id: 'model:0',
    kind: 'info',
    title: 'John skriver om legeaftalen',
    child: null,
    dueAt: null,
    urgency: 'fyi',
    quote: null,
    why: null,
    sourceKey: 'thread:7',
    origin: 'model',
    concernsChild: false,
  };

  test('a named sender read as background is promoted to week', () => {
    const items = [
      item({ key: 'thread:7', kind: 'thread', title: 'Legeaftale', author: 'Esben Bille', audience: 'institution' }),
    ];
    const brief = rank(withWish(items, [JOHN]), [backgroundNote]);
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.mustShow).toBe(true);
    expect(brief.signals[0]?.reasons.join(' ')).toContain('preference floor → week');
  });

  test('a named sender no signal covered still reaches the page', () => {
    // The promise is "sig altid til når John skriver". A model that extracted
    // nothing from his message is exactly the day that promise is tested.
    const items = [
      item({ key: 'thread:8', kind: 'thread', title: 'Hej igen', text: 'Vi ses på fredag.', author: 'Esben Bille' }),
    ];
    const brief = rank(withWish(items, [JOHN]), []);
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.origin).toBe('rule');
    expect(brief.unusedSources).toHaveLength(0);
  });

  test('a wish for less of something never promotes', () => {
    // "jeg er ligeglad med hvad John skriver" asks for the opposite, and the
    // floor only ever pushes up — so it must decline to read this one at all.
    const items = [
      item({ key: 'thread:9', kind: 'thread', title: 'Endnu en besked', author: 'Esben Bille' }),
    ];
    const brief = rank(withWish(items, ['jeg er ligeglad med hvad John skriver']), [
      { ...backgroundNote, sourceKey: 'thread:9' },
    ]);
    expect(brief.signals[0]?.tier).toBe('context');
    expect(brief.signals[0]?.reasons.join(' ')).not.toContain('preference floor');
  });

  test('an explicit wish outranks the audience prior', () => {
    // Municipal breadth is the strongest suppressor there is, and a name the
    // family wrote down themselves is the one thing allowed past it.
    const items = [
      item({ key: 'post:10', title: 'Fra forvaltningen', author: 'Esben Bille', audience: 'municipal' }),
    ];
    const brief = rank(withWish(items, [JOHN]), [{ ...backgroundNote, sourceKey: 'post:10' }]);
    expect(brief.signals[0]?.tier).toBe('week');
  });

  test('with no preferences nothing moves', () => {
    const items = [
      item({ key: 'thread:11', kind: 'thread', title: 'Legeaftale', author: 'Esben Bille', audience: 'institution' }),
    ];
    const brief = rank(briefInput({ items }), [{ ...backgroundNote, sourceKey: 'thread:11' }]);
    expect(brief.signals[0]?.tier).toBe('context');
    expect(brief.signals[0]?.reasons.join(' ')).not.toContain('preference');
  });
});

describe('a shipped opinion the family disagrees with', () => {
  const municipalOffer = () =>
    item({
      key: 'post:30',
      title: 'Tilbud om forældrekursus',
      text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
      audience: 'municipal',
    });

  test('is enforced deterministically while the list still says so', () => {
    const items = [municipalOffer()];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals[0]?.tier).toBe('hidden');
  });

  test('stops being enforced the moment it is dropped', () => {
    // The whole point of moving these out of the prompt: a family that wants
    // the municipality's messages can have them. Without this, dropping the
    // line would change the prompt and nothing else — a setting that visibly
    // does nothing, which is worse than no setting.
    const items = [municipalOffer()];
    const kept = DEFAULT_PREFERENCES.filter((line) => line !== MUNICIPAL_IS_NOISE);
    const theirs = briefInput({ items, preferences: [...kept] });
    const brief = rank(theirs, signalsFromRules(theirs, TODAY));
    expect(brief.signals[0]?.tier).not.toBe('hidden');
  });

  test('an emptied list hides nothing at all', () => {
    const items = [municipalOffer()];
    const theirs = briefInput({ items, preferences: [] });
    const brief = rank(theirs, signalsFromRules(theirs, TODAY));
    expect(brief.signals[0]?.tier).not.toBe('hidden');
  });

  test('breadth still sorts it low — dropping the line shows it, it does not promote it', () => {
    const items = [
      municipalOffer(),
      item({ key: 'post:31', title: 'Husk gummistøvler på torsdag', text: 'Husk gummistøvler på torsdag.' }),
    ];
    const theirs = briefInput({
      items,
      preferences: DEFAULT_PREFERENCES.filter((line) => line !== MUNICIPAL_IS_NOISE),
    });
    const brief = rank(theirs, signalsFromRules(theirs, TODAY));
    const municipal = brief.signals.find((s) => s.sourceKey === 'post:30');
    const ours = brief.signals.find((s) => s.sourceKey === 'post:31');
    expect((ours?.score ?? 0) > (municipal?.score ?? 0)).toBe(true);
  });
});
