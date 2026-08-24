import { describe, expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { renderPage } from './render.ts';
import type { BriefInput, SourceItem } from './types.ts';
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

const COURSE: SourceItem = sourceItem({
  key: 'post:9',
  title: 'Forældrekursus',
  text: 'Tilbud om kursus for forældre i kommunen.',
  audience: 'municipal',
  groups: ['Alle forældre'],
});

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
  items: [SOURCE, COURSE],
  health: [
    { level: 'warn', message: 'Ugeplan for Viggo kunne ikke hentes — EasyIQ svarede HTTP 500.' },
  ],
});

const CARD = card({
  id: 'model:0',
  title: 'Send skiftetøj og badeting med til Alma',
  summary: 'Idræt i dag; alle skal i bad bagefter.',
  children: ['Alma'],
  date: '2026-08-13',
  needsAction: true,
  sourceKeys: ['plan:x:0'],
});

const BRIEF = rankedBrief(INPUT, [CARD], { hidden: ['post:9'] });

describe('validatePage', () => {
  test('the page satisfies every invariant', () => {
    expect(validatePage(renderPage(BRIEF), BRIEF)).toEqual([]);
  });

  test('catches a page that quietly dropped a card', () => {
    // The dangerous failure: it looks fine and the meeting is simply gone.
    const html = renderPage(BRIEF).replace(`data-signal-id="${CARD.id}"`, 'data-x="1"');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('must-show');
  });

  test('catches a card rendered with the wrong placement', () => {
    const html = renderPage(BRIEF).replace('data-placement="upcoming"', 'data-placement="future"');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('placement');
  });

  test('catches a future group carrying the wrong parent-facing heading', () => {
    const future = { ...CARD, id: 'future', date: '2026-09-09', actionableNow: false };
    const ranked = rankedBrief(INPUT, [future]);
    const html = renderPage(ranked).replace('>Senere</h3>', '>Næste uge</h3>');

    expect(validatePage(html, ranked).map((violation) => violation.rule)).toContain(
      'section-label',
    );
  });

  test('catches timeline groups rendered in the wrong order', () => {
    const ranked = rankedBrief(INPUT, [
      { ...CARD, id: 'action', date: '2026-09-09', actionableNow: true },
      { ...CARD, id: 'future', date: '2026-09-11', actionableNow: false },
    ]);
    const html = renderPage(ranked)
      .replace('data-timeline-group="action"', 'data-timeline-group="temporary"')
      .replace('data-timeline-group="future"', 'data-timeline-group="action"')
      .replace('data-timeline-group="temporary"', 'data-timeline-group="future"');

    expect(validatePage(html, ranked).map((violation) => violation.rule)).toContain(
      'section-order',
    );
  });

  test('holds compact personal cards to must-show and noise invariants too', () => {
    const appointment = sourceItem({
      key: 'cal:family:dentist:2026-08-13T13:30:00',
      kind: 'personal',
      title: 'Tandlæge',
      at: '2026-08-13T13:30:00',
      endsAt: '2026-08-13T14:15:00',
      audience: 'family',
    });
    const input = { ...INPUT, items: [...INPUT.items, appointment] };
    const ranked = rankedBrief(input, [CARD], {
      personalEvents: [
        {
          sourceKey: appointment.key,
          relevant: true,
          summary: 'Tandlægetid i eftermiddag.',
          reason: 'Aftalen påvirker familiens dag.',
        },
      ],
    });
    const html = renderPage(ranked);
    const event = ranked.personalEvents[0]!;

    expect(
      validatePage(html.replace(`data-signal-id="${event.id}"`, 'data-x="1"'), ranked).map(
        (violation) => violation.rule,
      ),
    ).toContain('must-show');
    const inconsistent = { ...ranked, hidden: [appointment] };
    expect(validatePage(html, inconsistent).map((violation) => violation.rule)).toContain('noise');
  });

  test('catches a claim with no source attached', () => {
    const html = renderPage(BRIEF).replace(`data-source-id="${CARD.sourceKeys[0]}"`, '');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('attribution');
  });

  test('catches a missing datastatus block', () => {
    const html = renderPage(BRIEF).replace('data-block="datastatus"', 'data-block="andet"');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('datastatus');
  });

  test('catches a fetch failure that was not reported', () => {
    const html = renderPage(BRIEF).replace(/Ugeplan for Viggo[^<]*/, 'Alt er hentet');
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('datastatus');
  });

  test('catches a hidden source drawn as a card', () => {
    const html = `${renderPage(BRIEF)}<div class="card" data-signal-id="x" data-source-id="post:9" data-done-keys="post:9|-">Forældrekursus</div>`;
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('noise');
  });

  test("checks every source a card cites, not only the card's first", () => {
    const ranked = rankedBrief(INPUT, [{ ...CARD, sourceKeys: [SOURCE.key, COURSE.key] }]);
    const inconsistent = { ...ranked, hidden: [COURSE] };

    expect(validatePage(renderPage(inconsistent), inconsistent).map((v) => v.rule)).toContain(
      'noise',
    );
  });

  test('catches external resources, which break the file and the PDF', () => {
    for (const bad of [
      '<img src="https://x/y.png">',
      '<script src="https://x/y.js"></script>',
      '<link rel="stylesheet" href="https://x/y.css">',
      '<style>@import url(https://x/y.css)</style>',
      '<iframe src="https://x/y"></iframe>',
    ]) {
      const rules = validatePage(renderPage(BRIEF) + bad, BRIEF).map((v) => v.rule);
      expect(rules).toContain('self-contained');
    }
  });

  // The page carries verbatim Aula prose behind its more-block toggles, and
  // this check cannot tell a tag it rendered from one a parent typed. Tags are
  // safe to match because `escapeHtml` neuters them; the CSS patterns this rule
  // used to carry were not, and would have failed the whole layout over a
  // stylesheet URL someone pasted into a message.
  test('quoted prose that merely looks like CSS is not an external resource', () => {
    for (const prose of [
      '<p>Se @import url(https://x/y.css) i vejledningen</p>',
      '<p>Skriv &lt;img src="foo"&gt; for at indsætte et billede</p>',
    ]) {
      expect(validatePage(renderPage(BRIEF) + prose, BRIEF)).toEqual([]);
    }
  });

  test('catches a full document where a fragment was required', () => {
    const html = `<!doctype html><html><body>${renderPage(BRIEF)}</body></html>`;
    expect(validatePage(html, BRIEF).map((v) => v.rule)).toContain('fragment');
  });

  test('catches an empty page', () => {
    expect(validatePage('<div></div>', BRIEF).map((v) => v.rule)).toContain('empty');
  });
});
