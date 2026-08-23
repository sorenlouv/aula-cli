import { describe, expect, test } from 'bun:test';
import type { ExtractResult } from '../src/brief/llm.ts';
import { assertBriefExtraction } from './assert-brief-extraction.ts';
import { briefExtractionCases } from './cases/brief-extraction.ts';

const EMPTY_RESULT: ExtractResult = {
  topline: null,
  cards: [],
  personalEvents: [],
  childSummaries: {},
  hidden: [],
  problems: [],
};

describe('brief extraction eval assertions', () => {
  test('reports a missed labelled personal event', () => {
    const evalCase = briefExtractionCases.find(
      (candidate) => candidate.id === 'personal-calendar-relevance',
    )!;
    const failures = assertBriefExtraction(evalCase, EMPTY_RESULT);

    expect(failures.some((failure) => failure.assertion.endsWith('is relevant'))).toBe(true);
    expect(failures.some((failure) => failure.assertion.endsWith('is irrelevant'))).toBe(true);
  });

  test('matches required cards by their grounded source keys', () => {
    const evalCase = briefExtractionCases.find(
      (candidate) => candidate.id === 'aula-actions-and-noise',
    )!;
    const result: ExtractResult = {
      ...EMPTY_RESULT,
      cards: [
        {
          id: 'model:0',
          title: 'Svar for Alma',
          summary: 'Svar om Alma må deltage.',
          children: ['Alma'],
          date: '2026-08-25',
          needsAction: true,
          reason: 'Der er en svarfrist.',
          sourceKeys: ['thread:trip-consent'],
          origin: 'model',
        },
      ],
    };

    const failures = assertBriefExtraction(evalCase, result);
    expect(failures.some((failure) => failure.assertion.includes('post:school-photo'))).toBe(true);
    expect(
      failures.some(
        (failure) =>
          failure.assertion.includes('thread:trip-consent') &&
          failure.assertion.includes('needsAction'),
      ),
    ).toBe(false);
  });
});
