import type { BriefInput } from '../src/brief/types.ts';

export type ExpectedCard = {
  /** At least one returned card must cite every key in this list. */
  sourceKeys: string[];
  needsAction?: boolean;
  date?: string | null;
  children?: string[];
  /** Disambiguates several obligations carried by the same source. */
  textContains?: string;
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
