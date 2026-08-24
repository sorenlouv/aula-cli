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

function matchesCardIdentity(
  card: ExtractResult['cards'][number],
  expected: ExpectedCard,
): boolean {
  const text = `${card.title}\n${card.summary}`;
  return (
    expected.sourceKeys.every((sourceKey) => card.sourceKeys.includes(sourceKey)) &&
    (!expected.sourceKeysExactly || sameStrings(card.sourceKeys, expected.sourceKeys)) &&
    !(expected.excludedSourceKeys ?? []).some((sourceKey) => card.sourceKeys.includes(sourceKey)) &&
    (expected.titleContains === undefined ||
      includesInsensitive(card.title, expected.titleContains)) &&
    (expected.textContains === undefined || includesInsensitive(text, expected.textContains)) &&
    !(expected.textNotContains ?? []).some((needle) => includesInsensitive(text, needle))
  );
}

/**
 * Find a maximum one-to-one assignment between expectations and returned
 * cards. Without this, one broad merged card can satisfy two expectations and
 * make an eval named "distinct obligations" pass while the page still hides
 * one action inside the other.
 */
function distinctCardMatches(result: ExtractResult, expectations: ExpectedCard[]): number[] {
  const candidates = expectations.map((expected) =>
    result.cards.flatMap((card, index) => (matchesCardIdentity(card, expected) ? [index] : [])),
  );
  const expectedByCard = new Array<number>(result.cards.length).fill(-1);

  const assign = (expectedIndex: number, seenCards: Set<number>): boolean => {
    for (const cardIndex of candidates[expectedIndex] ?? []) {
      if (seenCards.has(cardIndex)) continue;
      seenCards.add(cardIndex);
      const previousExpected = expectedByCard[cardIndex] ?? -1;
      if (previousExpected !== -1 && !assign(previousExpected, seenCards)) continue;
      expectedByCard[cardIndex] = expectedIndex;
      return true;
    }
    return false;
  };

  for (let index = 0; index < expectations.length; index++) assign(index, new Set());
  const cardByExpected = new Array<number>(expectations.length).fill(-1);
  for (const [cardIndex, expectedIndex] of expectedByCard.entries()) {
    if (expectedIndex !== -1) cardByExpected[expectedIndex] = cardIndex;
  }
  return cardByExpected;
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

  const requiredCards = evalCase.expected.requiredCards ?? [];
  const matches = distinctCardMatches(result, requiredCards);
  for (const [expectedIndex, expected] of requiredCards.entries()) {
    const cardIndex = matches[expectedIndex] ?? -1;
    const card = result.cards[cardIndex];
    if (!card) {
      failures.push({
        assertion: `a distinct card matches ${expected.sourceKeys.join(', ')}`,
        actual: result.cards.map((candidate) => ({
          title: candidate.title,
          sourceKeys: candidate.sourceKeys,
        })),
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
    if (expected.recurring !== undefined && card.recurring !== expected.recurring) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} has recurring=${expected.recurring}`,
        actual: card.recurring,
      });
    }
    if (expected.children && !sameStrings(card.children, expected.children)) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} concerns ${expected.children.join(', ')}`,
        actual: card.children,
      });
    }
    if (expected.maxRank !== undefined && cardIndex + 1 > expected.maxRank) {
      failures.push({
        assertion: `${expected.sourceKeys.join(', ')} ranks at or above ${expected.maxRank}`,
        actual: cardIndex + 1,
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
