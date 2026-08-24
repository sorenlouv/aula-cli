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
          recurring: false,
          needsAction: true,
          actionableNow: true,
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

  test('one merged card cannot satisfy two distinct obligations', () => {
    const evalCase = briefExtractionCases.find(
      (candidate) => candidate.id === 'same-day-distinct-obligations',
    )!;
    const merged: ExtractResult = {
      ...EMPTY_RESULT,
      cards: [
        {
          id: 'model:0',
          title: 'Husk badetøj og madpakke til Alma',
          summary: 'Husk badetøj og madpakke på mandag.',
          children: ['Alma'],
          date: '2026-08-31',
          recurring: false,
          needsAction: true,
          actionableNow: false,
          reason: 'To ting skal med.',
          sourceKeys: ['post:two-obligations'],
          origin: 'model',
        },
      ],
    };

    const failures = assertBriefExtraction(evalCase, merged);
    expect(failures.some((failure) => failure.assertion.startsWith('a distinct card'))).toBe(true);
  });

  test('checks the final visible placement through the production ranker', () => {
    const evalCase = briefExtractionCases.find(
      (candidate) => candidate.id === 'actionable-now-and-future-sections',
    )!;
    const result: ExtractResult = {
      ...EMPTY_RESULT,
      cards: [
        {
          id: 'model:0',
          title: 'Tilmeld Alma og Otto til fotografering',
          summary: 'Tilmeld børnene til fotograferingen den 9. september.',
          children: ['Alma', 'Otto'],
          date: '2026-09-09',
          recurring: false,
          needsAction: true,
          actionableNow: false,
          reason: 'Tilmelding er nødvendig.',
          sourceKeys: ['post:future-photo-registration'],
          origin: 'model',
        },
      ],
    };

    const failures = assertBriefExtraction(evalCase, result);
    expect(
      failures.some((failure) => failure.assertion.includes('is visible in placement=action')),
    ).toBe(true);
  });

  test('checks every split child card for the expected date', () => {
    const evalCase = briefExtractionCases.find(
      (candidate) => candidate.id === 'actionable-now-and-future-sections',
    )!;
    const registration = (id: string, child: string, date: string) => ({
      id,
      title: `Tilmeld ${child} til fotografering`,
      summary: `Tilmeld ${child} til fotograferingen.`,
      children: [child],
      date,
      recurring: false,
      needsAction: true,
      actionableNow: true,
      reason: 'Tilmelding er nødvendig.',
      sourceKeys: ['post:future-photo-registration'],
      origin: 'model' as const,
    });
    const result: ExtractResult = {
      ...EMPTY_RESULT,
      cards: [
        registration('model:0', 'Alma', '2026-09-09'),
        registration('model:1', 'Otto', '2026-09-11'),
      ],
    };

    const failures = assertBriefExtraction(evalCase, result);
    expect(
      failures.some(
        (failure) =>
          failure.assertion.includes('post:future-photo-registration') &&
          failure.assertion.includes('date=2026-09-09'),
      ),
    ).toBe(true);
  });
});
