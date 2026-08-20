/**
 * Shared builders for the brief tests' fixtures.
 *
 * Every brief test needs a `SourceItem` or a `BriefInput`, and each test file
 * used to spell the whole literal out — so a schema change meant the same
 * mechanical edit in five files (dropping the write-only fields took exactly
 * that sweep once). The defaults live here; each test overrides only what it
 * is actually about.
 */

import type { BriefInput, SourceItem } from '../brief/types.ts';

export function sourceItem(overrides: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return {
    kind: 'post',
    title: 'Opslag',
    text: '',
    at: '2026-08-10T11:00:00+00:00',
    author: 'Palle',
    groups: [],
    childNames: [],
    audience: 'class',
    important: false,
    url: null,
    ...overrides,
  };
}

/** 2026-08-13 is a Thursday; the default item timestamp above is a Monday. */
export function briefInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    today: '2026-08-13',
    isoWeek: '2026-W33',
    windowDays: 14,
    family: { children: [], isSteppedUp: true },
    items: [],
    health: [],
    albums: [],
    newMediaCount: 0,
    ...overrides,
  };
}
