import { describe, expect, test } from 'bun:test';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { fallbackPage } from './compose.ts';
import type { BriefInput, RankedBrief, RankedSignal, SourceItem } from './types.ts';
import { validatePage } from './validate.ts';

const SOURCE: SourceItem = sourceItem({
  key: 'plan:x:0',
  kind: 'plan',
  title: 'Idræt',
  text: 'Husk skiftetøj og badeting til efter timen.',
  at: '2026-08-13T08:00:00',
  author: 'EasyIQ',
  childNames: ['Alma Sofie Eksempelsen'],
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

const HIDDEN: RankedSignal = {
  ...MUST_SHOW,
  id: 'post:9#0',
  title: 'Forældrekurset',
  tier: 'hidden',
  mustShow: false,
  audience: 'municipal',
  relevance: 'hide',
  sourceKey: 'post:9',
  source: { ...SOURCE, key: 'post:9', title: 'Forældrekursus', audience: 'municipal', groups: ['Alle forældre'] },
};

const INPUT: BriefInput = briefInput({
  family: {
    children: [
      { name: 'Alma Sofie Eksempelsen', firstName: 'Alma', institution: 'Eksempelskolen', className: '2E', presence: null },
    ],
    isSteppedUp: true,
  },
  items: [SOURCE],
  health: [
    { level: 'warn', message: 'Ugeplan for Viggo kunne ikke hentes — EasyIQ svarede HTTP 500.' },
  ],
});

const BRIEF: RankedBrief = {
  input: INPUT,
  signals: [MUST_SHOW, HIDDEN],
  unusedSources: [],
  degraded: [],
};

describe('validatePage', () => {
  test('the fallback layout satisfies every invariant', () => {
    // The fallback is held to exactly the same standard as the model's output;
    // it is the thing that ships on a bad day.
    expect(validatePage(fallbackPage(BRIEF), BRIEF)).toEqual([]);
  });

  test('catches a page that quietly dropped a required item', () => {
    // The dangerous failure: it looks fine and the meeting is simply gone.
    const html = fallbackPage(BRIEF).replace(`data-signal-id="${MUST_SHOW.id}"`, 'data-x="1"');
    const rules = validatePage(html, BRIEF).map((v) => v.rule);
    expect(rules).toContain('must-show');
  });

  test('catches a claim with no source attached', () => {
    const html = fallbackPage(BRIEF).replace(`data-source-id="${MUST_SHOW.sourceKey}"`, '');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('attribution');
  });

  test('catches a missing datastatus block', () => {
    const html = fallbackPage(BRIEF).replace('data-block="datastatus"', 'data-block="andet"');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('datastatus');
  });

  test('catches a fetch failure that was not reported', () => {
    const html = fallbackPage(BRIEF).replace(/Ugeplan for Viggo[^<]*/, 'Alt er hentet');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('datastatus');
  });

  test('catches a suppressed broadcast promoted to a card', () => {
    const html = `${fallbackPage(BRIEF)}<div class="card" data-signal-id="${HIDDEN.id}" data-source-id="post:9">Forældrekursus</div>`;
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('noise');
  });

  test('catches external resources, which break the file and the PDF', () => {
    for (const bad of [
      '<img src="https://x/y.png">',
      '<script src="https://x/y.js"></script>',
      '<link rel="stylesheet" href="https://x/y.css">',
      '<style>@import url(https://x/y.css)</style>',
      '<iframe src="https://x/y"></iframe>',
    ]) {
      const rules = validatePage(fallbackPage(BRIEF) + bad, BRIEF).map((v) => v.rule);
      expect(rules).toContain('self-contained');
    }
  });

  // The page now carries verbatim Aula prose behind its "læs mere" toggles, and
  // this check cannot tell a tag it rendered from one a parent typed. Tags are
  // safe to match because `escapeHtml` neuters them; the CSS patterns this rule
  // used to carry were not, and would have failed the whole layout over a
  // stylesheet URL someone pasted into a message.
  test('quoted prose that merely looks like CSS is not an external resource', () => {
    for (const prose of [
      '<p>Se @import url(https://x/y.css) i vejledningen</p>',
      '<p>Skriv &lt;img src="foo"&gt; for at indsætte et billede</p>',
    ]) {
      expect(validatePage(fallbackPage(BRIEF) + prose, BRIEF)).toEqual([]);
    }
  });

  test('allows ordinary links back into Aula', () => {
    expect(validatePage(fallbackPage(BRIEF), BRIEF)).toEqual([]);
  });

  test('catches a full document where a fragment was required', () => {
    const html = `<!doctype html><html><body>${fallbackPage(BRIEF)}</body></html>`;
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('fragment');
  });

  test('catches an empty page', () => {
    expect(validatePage('<div></div>', BRIEF).map((v) => v.rule)).toContain('empty');
  });
});
