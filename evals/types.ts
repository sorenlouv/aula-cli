import type { BriefInput, Placement } from '../src/brief/types.ts';

export type ExpectedCard = {
  /** At least one returned card must cite every key in this list. */
  sourceKeys: string[];
  /** Reject extra citations so *Læs mere* contains only this card's subject. */
  sourceKeysExactly?: boolean;
  /** Sources that would prove the model merged an unrelated subject. */
  excludedSourceKeys?: string[];
  needsAction?: boolean;
  /** Every expected card pins whether it can be completed now. */
  actionableNow: boolean;
  /** Final visible section after the production ranker has placed the card. */
  placement: Placement;
  date?: string | null;
  recurring?: boolean;
  children?: string[];
  /** Children covered across one combined card or several child-specific cards. */
  childrenCovered?: string[];
  /** Stable wording that must be visible in the card title itself. */
  titleContains?: string;
  /** Disambiguates several obligations carried by the same source. */
  textContains?: string;
  /** Wording from an unrelated subject that must not leak into the card. */
  textNotContains?: string[];
  /** One-based position in the model answer; used to protect priority-sensitive cases. */
  maxRank?: number;
};

export type BriefExtractionExpectation = {
  relevantPersonalEvents?: string[];
  irrelevantPersonalEvents?: string[];
  requiredCards?: ExpectedCard[];
  /** Aula sources expected to remain visible in the collapsed remainder. */
  foldedIncludes?: string[];
  hiddenIncludes?: string[];
  hiddenExcludes?: string[];
  toplineNotContains?: string[];
  childSummariesNotContain?: string[];
};

/** One reviewable, fictionalised semantic contract for the production prompt. */
export type BriefExtractionEvalCase = {
  id: string;
  description: string;
  /** Where the expected judgement came from, without retaining real content. */
  provenance: 'user-labelled' | 'synthetic';
  input: BriefInput;
  expected: BriefExtractionExpectation;
};

export type EvalFailure = {
  assertion: string;
  actual?: unknown;
};
