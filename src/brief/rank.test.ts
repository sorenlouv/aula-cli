import { describe, expect, test } from 'bun:test';
import { DEFAULT_PREFERENCES } from '../preferences.ts';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { classifyAudience } from './collect.ts';
import { ACT_CAP, rank, signalsFromRules } from './rank.ts';
import type { BriefInput, Relevance, Signal, SourceItem } from './types.ts';

const TODAY = new Date(2026, 7, 13);

function item(partial: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return sourceItem({ title: 'Titel', at: null, author: null, ...partial });
}

/**
 * A real installation, which always has the shipped opinions on its list —
 * `preferences.md` is seeded on first use. The ranker never reads the prose
 * itself (the model's verdicts are passed to `rank` directly), but the list
 * travels in `BriefInput`, and a fixture without it would be an install nobody
 * has.
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
  const municipalOffer = () =>
    item({
      key: 'post:1',
      title: 'Tilbud om forældrekursus',
      text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
      audience: 'municipal',
    });

  test('a municipal offer with a real deadline is never a card', () => {
    // The exact case that was wrong in the first mockup: the deadline is
    // genuine, and it must not buy the item a place at the top. With no
    // verdict from the model — the rules-only path — breadth alone keeps it
    // under "Godt at vide": shown, not promoted, not hidden.
    const items = [municipalOffer()];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('context');
    expect(brief.signals[0]?.mustShow).toBe(false);
  });

  test('a municipal offer is hidden when the family\'s list says so — which the model reports as a verdict', () => {
    const items = [municipalOffer()];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY), { 'post:1': 'hide' });
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

  test('an item Aula flagged important is never merged away into one it did not', () => {
    // The loser of a cross-source merge survives only as a bare key in
    // `mergedSourceKeys`, which counts as covered everywhere downstream: no
    // card, no "Godt at vide", no muted foot, and not even `unusedSources`.
    // The vigtig floor only ever inspects the winner, so once the flagged item
    // has lost there is nothing left to rescue it. The class-level copy
    // outscores it here — breadth beats the +12 — which is exactly when the
    // flag matters most.
    const items = [
      item({
        key: 'post:30',
        title: 'Sommerfest',
        text: 'Husk at tilmelde jer senest d. 20/8.',
        audience: 'class',
      }),
      item({
        key: 'post:31',
        title: 'Sommerfest',
        text: 'Husk at tilmelde jer senest d. 20/8.',
        audience: 'institution',
        important: true,
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY));
    const flagged = brief.signals.find((s) => s.sourceKey === 'post:31');
    expect(flagged).toBeDefined();
    expect(flagged?.tier === 'context' || flagged?.tier === 'hidden').toBe(false);
    // And it stands on its own rather than being absorbed by the other copy.
    expect(brief.signals.flatMap((s) => s.mergedSourceKeys)).not.toContain('post:31');
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

describe("the family's list, as the model read it", () => {
  // One verdict per source, from the extraction call. The ranker never reads
  // `preferences.md` itself — it used to, with a regex over sender names, and
  // floored a teacher called Hjalte on a wish about Hjaltes far.
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
  const johnsThread = (key = 'thread:7') =>
    item({ key, kind: 'thread', title: 'Legeaftale', author: 'Esben Bille', audience: 'institution' });

  test('high lifts a source read as background to week', () => {
    const brief = rank(input([johnsThread()]), [backgroundNote], { 'thread:7': 'high' });
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.mustShow).toBe(true);
    expect(brief.signals[0]?.relevance).toBe('high');
    expect(brief.signals[0]?.reasons).toContain('relevance:high floor → week');
  });

  test('high never manufactures an action', () => {
    // A wish makes something wanted, not something to do: "Kræver handling"
    // stays for actionable kinds.
    const brief = rank(input([johnsThread()]), [backgroundNote], { 'thread:7': 'high' });
    expect(brief.signals[0]?.tier).not.toBe('act');
  });

  test('a high source no signal covered still reaches the page', () => {
    // The promise is "sig altid til når John skriver". A model that extracted
    // nothing from his message is exactly the day that promise is tested.
    const items = [item({ key: 'thread:8', kind: 'thread', title: 'Hej igen', text: 'Vi ses på fredag.', author: 'Esben Bille' })];
    const brief = rank(input(items), [], { 'thread:8': 'high' });
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('week');
    expect(brief.signals[0]?.mustShow).toBe(true);
    expect(brief.signals[0]?.origin).toBe('rule');
    expect(brief.unusedSources).toHaveLength(0);
  });

  test('high outranks the audience prior', () => {
    // Municipal breadth is the strongest suppressor there is, and a family's
    // own wish is the one thing allowed past it.
    const items = [item({ key: 'post:10', title: 'Fra forvaltningen', author: 'Esben Bille', audience: 'municipal' })];
    const brief = rank(input(items), [{ ...backgroundNote, sourceKey: 'post:10' }], { 'post:10': 'high' });
    expect(brief.signals[0]?.tier).toBe('week');
  });

  test('low keeps it off the cards, not off the page', () => {
    // A class-level sign-up the family said they care less about: still under
    // "Godt at vide", never a card — so a verdict the model got wrong costs a
    // fold, not the item.
    const items = [
      item({ key: 'post:40', title: 'Forældrenetværk', text: 'Tilmeld jer forældrenetværket senest mandag d. 17/8.', audience: 'class' }),
    ];
    const plain = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(plain.signals[0]?.tier).toBe('act');
    const theirs = rank(input(items), signalsFromRules(input(items), TODAY), { 'post:40': 'low' });
    expect(theirs.signals[0]?.tier).toBe('context');
    expect(theirs.signals[0]?.mustShow).toBe(false);
    expect(theirs.unusedSources).toHaveLength(0);
  });

  test('Aula\'s own vigtig flag beats hide and low alike', () => {
    // The school shouting is not something a preference can mute.
    const closure = () =>
      item({ key: 'post:2', title: 'Skolen er lukket', text: 'Husk at skolen er lukket på mandag.', audience: 'municipal', important: true });
    for (const verdict of ['hide', 'low'] as const) {
      const items = [closure()];
      const brief = rank(input(items), signalsFromRules(input(items), TODAY), { 'post:2': verdict });
      expect(brief.signals[0]?.tier).toBe('act');
    }
  });

  test('a hide source no signal covered is accounted for in the hidden tier, not under Godt at vide', () => {
    // Listed in the muted foot with the rest of what was hidden; surfacing it
    // as an "unused source" would be the opposite of what the family asked.
    const items = [item({ key: 'post:31', title: 'Nyt fra forvaltningen', text: 'Kære forældre.', audience: 'municipal' })];
    const brief = rank(input(items), [], { 'post:31': 'hide' });
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('hidden');
    expect(brief.signals[0]?.mustShow).toBe(false);
    expect(brief.signals[0]?.origin).toBe('rule');
    expect(brief.unusedSources).toHaveLength(0);
  });

  test('a hide verdict on something that asks us about our own child is demoted, not hidden', () => {
    // "Fællesbeskeder til alle forældre i kommunen er aldrig relevante" is a
    // fair thing to want and a bad thing to apply to "alle skoler er lukket på
    // mandag". The wish still keeps it off the cards; the item stays findable.
    const items = [
      item({
        key: 'post:closure',
        title: 'Lærerstrejke',
        text: 'Alle skoler er lukket på mandag. Eleverne skal blive hjemme.',
        audience: 'municipal',
      }),
    ];
    const brief = rank(input(items), signalsFromRules(input(items), TODAY), { 'post:closure': 'hide' });
    expect(brief.signals[0]?.concernsChild).toBe(true);
    expect(brief.signals[0]?.tier).toBe('context');
    // …while the same verdict on an offer, which asks nothing of us, still hides.
    const offer = [
      item({
        key: 'post:course',
        title: 'Tilbud om forældrekursus',
        text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
        audience: 'municipal',
      }),
    ];
    const hidden = rank(input(offer), signalsFromRules(input(offer), TODAY), { 'post:course': 'hide' });
    expect(hidden.signals[0]?.concernsChild).toBe(false);
    expect(hidden.signals[0]?.tier).toBe('hidden');
  });

  test('a hidden signal never merges with a visible one — in either direction', () => {
    // Merging keeps the higher scorer and reduces the loser to a count, which
    // is right for two tellings of one story and wrong the moment the family
    // weighs them differently. The merged-away source is `covered` everywhere
    // downstream, so it would land in no card, no "Godt at vide" and no muted
    // foot: the one way a source can leave the page without being counted.
    const sameOfferTwice = () => [
      item({
        key: 'post:60',
        title: 'Forældrekurset Trivsel i familien',
        text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
        audience: 'institution',
      }),
      item({
        key: 'post:61',
        title: 'Forældrekurset Trivsel i familien',
        text: 'Ansøgningsfristen er tirsdag den 1. september 2026.',
        audience: 'municipal',
      }),
    ];
    for (const hiddenKey of ['post:61', 'post:60']) {
      const verdicts: Record<string, Relevance> = { [hiddenKey]: 'hide' };
      const items = sameOfferTwice();
      const brief = rank(input(items), signalsFromRules(input(items), TODAY), verdicts);
      const keys = brief.signals.map((s) => s.sourceKey).sort();
      expect(keys).toEqual(['post:60', 'post:61']);
      expect(brief.signals.every((s) => s.mergedSourceKeys.length === 0)).toBe(true);
      expect(brief.signals.filter((s) => s.tier === 'hidden')).toHaveLength(1);
      expect(brief.unusedSources).toHaveLength(0);
    }
  });

  test('two tellings of one story still merge when the family weighs them the same', () => {
    // The behaviour the boundary above must not break.
    const items = [
      item({ key: 'post:70', title: 'Forældrekurset', text: 'Ansøgningsfristen er tirsdag den 1. september 2026.', audience: 'municipal' }),
      item({ key: 'post:71', title: 'Forældrekurset', text: 'Ansøgningsfristen er tirsdag den 1. september 2026.', audience: 'municipal' }),
    ];
    const both: Record<string, Relevance> = { 'post:70': 'hide', 'post:71': 'hide' };
    const brief = rank(input(items), signalsFromRules(input(items), TODAY), both);
    expect(brief.signals).toHaveLength(1);
    expect(brief.signals[0]?.mergedSourceKeys).toHaveLength(1);
    expect(brief.signals[0]?.tier).toBe('hidden');
  });

  test('no verdict is normal: nothing moves, nothing hides', () => {
    // The rules-only path, and a source the model skipped. Fails towards
    // showing more, never less.
    const items = [johnsThread('thread:11')];
    const brief = rank(input(items), [{ ...backgroundNote, sourceKey: 'thread:11' }]);
    expect(brief.signals[0]?.tier).toBe('context');
    expect(brief.signals[0]?.relevance).toBe('normal');
    expect(brief.signals[0]?.reasons.join(' ')).not.toContain('relevance');
  });

  test('an emptied list hides nothing at all', () => {
    // The model is told an empty list means everything is normal; the ranker
    // holds the same line when no verdicts arrive.
    const items = [item({ key: 'post:30', title: 'Tilbud om forældrekursus', text: 'Ansøgningsfristen er tirsdag den 1. september 2026.', audience: 'municipal' })];
    const theirs = briefInput({ items, preferences: [] });
    const brief = rank(theirs, signalsFromRules(theirs, TODAY));
    expect(brief.signals[0]?.tier).not.toBe('hidden');
  });

  test('the verdict moves the score, so high survives the cap', () => {
    // Same kind, same date, same audience: the last one in is the one that
    // overflows — unless the family's word puts it ahead of the rest.
    const items = Array.from({ length: ACT_CAP + 1 }, (_, i) =>
      item({ key: `plan:x:${i}`, title: `Opgave ${i}`, text: `Husk ${i} madpakke.`, childNames: ['Viggo Birk Eksempelsen'], audience: 'child' }),
    );
    const last = `plan:x:${ACT_CAP}`;
    const plain = rank(input(items), signalsFromRules(input(items), TODAY));
    expect(plain.signals.filter((s) => s.tier === 'week').map((s) => s.sourceKey)).toEqual([last]);

    const theirs = rank(input(items), signalsFromRules(input(items), TODAY), { [last]: 'high' });
    expect(theirs.signals.filter((s) => s.tier === 'week').map((s) => s.sourceKey)).toEqual([`plan:x:${ACT_CAP - 1}`]);
    const high = theirs.signals.find((s) => s.sourceKey === last);
    const normal = theirs.signals.find((s) => s.sourceKey === 'plan:x:1');
    expect((high?.score ?? 0) > (normal?.score ?? 0)).toBe(true);
    expect(high?.reasons).toContain('relevance:high +25');
  });

  test('low sinks the score as well as the tier', () => {
    const items = [
      item({ key: 'post:50', title: 'Fællesspisning', text: 'Vi holder fællesspisning i næste uge.', audience: 'class' }),
      item({ key: 'post:51', title: 'Fællesspisning', text: 'Vi holder fællesspisning i næste uge.', audience: 'class' }),
    ];
    const note = (key: string): Signal => ({ ...backgroundNote, id: `model:${key}`, title: `Fællesspisning ${key}`, sourceKey: key });
    const brief = rank(input(items), [note('post:50'), note('post:51')], { 'post:51': 'low' });
    const plain = brief.signals.find((s) => s.sourceKey === 'post:50');
    const low = brief.signals.find((s) => s.sourceKey === 'post:51');
    expect((plain?.score ?? 0) > (low?.score ?? 0)).toBe(true);
    expect(low?.reasons).toContain('relevance:low -25');
  });
});
