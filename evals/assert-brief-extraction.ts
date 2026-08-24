import type { ExtractResult } from '../src/brief/llm.ts';
import type { BriefExtractionEvalCase, EvalFailure, ExpectedCard } from './types.ts';

function includesInsensitive(value: string, needle: string): boolean {
  return value.toLocaleLowerCase('da-DK').includes(needle.toLocaleLowerCase('da-DK'));
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function matchingCard(result: ExtractResult, expected: ExpectedCard) {
  return result.cards.find(
    (card) =>
      expected.sourceKeys.every((sourceKey) => card.sourceKeys.includes(sourceKey)) &&
      (expected.textContains === undefined ||
        includesInsensitive(`${card.title}\n${card.summary}`, expected.textContains)),
  );
}

/**
 * Checks decisions, not wording. Summaries are generative; inclusion, action,
 * dates and source grounding are the stable product behaviour under test.
 */
export function assertBriefExtraction(
  evalCase: BriefExtractionEvalCase,
  result: ExtractResult,
): EvalFailure[] {
  const failures: EvalFailure[] = [];

  if (result.problems.length > 0) {
    failures.push({
      assertion: 'the production validator accepts the complete answer',
      actual: result.problems,
    });
  }

  const verdicts = new Map(result.personalEvents.map((verdict) => [verdict.sourceKey, verdict]));
  for (const sourceKey of evalCase.expected.relevantPersonalEvents ?? []) {
    const verdict = verdicts.get(sourceKey);
    if (verdict?.relevant !== true) {
      failures.push({ assertion: `${sourceKey} is relevant`, actual: verdict ?? null });
    }
  }
  for (const sourceKey of evalCase.expected.irrelevantPersonalEvents ?? []) {
    const verdict = verdicts.get(sourceKey);
    if (verdict?.relevant !== false) {
      failures.push({ assertion: `${sourceKey} is irrelevant`, actual: verdict ?? null });
    }
  }

  for (const expected of evalCase.expected.requiredCards ?? []) {
    const card = matchingCard(result, expected);
    if (!card) {
      failures.push({
        assertion: `a card cites ${expected.sourceKeys.join(', ')}`,
        actual: result.cards.map((candidate) => candidate.sourceKeys),
      });
      continue;
    }
    if (expected.needsAction !== undefined && card.needsAction !== expected.needsAction) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} has needsAction=${expected.needsAction}`,
        actual: card.needsAction,
      });
    }
    if (expected.date !== undefined && card.date !== expected.date) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} has date=${String(expected.date)}`,
        actual: card.date,
      });
    }
    if (expected.children && !sameStrings(card.children, expected.children)) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} concerns ${expected.children.join(', ')}`,
        actual: card.children,
      });
    }
  }

  for (const sourceKey of evalCase.expected.foldedIncludes ?? []) {
    const card = result.cards.find((candidate) => candidate.sourceKeys.includes(sourceKey));
    if (card || result.hidden.includes(sourceKey)) {
      failures.push({
        assertion: `${sourceKey} remains in the collapsed remainder`,
        actual: card ? { card: card.sourceKeys } : { hidden: result.hidden },
      });
    }
  }

  for (const sourceKey of evalCase.expected.hiddenIncludes ?? []) {
    if (!result.hidden.includes(sourceKey)) {
      failures.push({ assertion: `${sourceKey} is hidden`, actual: result.hidden });
    }
  }
  for (const sourceKey of evalCase.expected.hiddenExcludes ?? []) {
    if (result.hidden.includes(sourceKey)) {
      failures.push({ assertion: `${sourceKey} is not hidden`, actual: result.hidden });
    }
  }

  for (const forbidden of evalCase.expected.toplineNotContains ?? []) {
    if (result.topline && includesInsensitive(result.topline, forbidden)) {
      failures.push({ assertion: `topline excludes “${forbidden}”`, actual: result.topline });
    }
  }
  const childSummaryText = Object.values(result.childSummaries).join('\n');
  for (const forbidden of evalCase.expected.childSummariesNotContain ?? []) {
    if (includesInsensitive(childSummaryText, forbidden)) {
      failures.push({
        assertion: `child summaries exclude “${forbidden}”`,
        actual: result.childSummaries,
      });
    }
  }

  return failures;
}
