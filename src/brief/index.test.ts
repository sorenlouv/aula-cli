import { expect, test } from 'bun:test';
import { briefInput, card, rankedBrief, sourceItem } from '../testing/brief-fixtures.ts';
import { isBriefRunComplete, pageViolationMessages } from './index.ts';
import { renderPage } from './render.ts';
import { validatePage } from './validate.ts';

test('a rendered invariant violation keeps the run incomplete', () => {
  const source = sourceItem({ key: 'post:1' });
  const brief = rankedBrief(briefInput({ items: [source] }), [
    card({ id: 'model:0', sourceKeys: [source.key] }),
  ]);
  const broken = renderPage(brief).replace(/ data-done-keys="[^"]*"/, '');
  const violations = validatePage(broken, brief);

  expect(violations.map((violation) => violation.rule)).toContain('dismissible');
  brief.degraded.push(...pageViolationMessages(violations));
  expect(renderPage(brief)).toContain('Sidekontrol: dismissible');
  expect(
    isBriefRunComplete({
      modelWasRequested: true,
      extractionRan: true,
      origin: 'model',
      deploymentFailed: false,
      retryableFetchFailures: false,
      violations,
    }),
  ).toBe(false);
});

test('a retryable fetch failure keeps the run incomplete', () => {
  expect(
    isBriefRunComplete({
      modelWasRequested: true,
      extractionRan: true,
      origin: 'model',
      deploymentFailed: false,
      retryableFetchFailures: true,
      violations: [],
    }),
  ).toBe(false);
});
