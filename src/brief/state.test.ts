import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BriefState,
  loadState,
  markSeen,
  recordDeploy,
  recordRun,
  saveState,
  todayIsComplete,
  whichAreNew,
} from './state.ts';

const dirs: string[] = [];
function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-state-test-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Local noon, so "today" is unambiguous whatever the machine's offset.
const today = new Date(2026, 7, 21, 12, 0, 0);
const earlierToday = new Date(2026, 7, 21, 6, 30, 0);
const yesterday = new Date(2026, 7, 20, 6, 30, 0);

describe('whichAreNew', () => {
  test('unseen keys are new', () => {
    const state: BriefState = { seen: {} };
    expect(whichAreNew(state, ['a', 'b'], today)).toEqual(new Set(['a', 'b']));
  });

  test('a key first seen earlier today is still new — the scheduler may build the page twice in a morning', () => {
    const state: BriefState = { seen: {} };
    markSeen(state, ['a'], earlierToday);
    expect(whichAreNew(state, ['a'], today)).toEqual(new Set(['a']));
  });

  test('a key seen on an earlier day is old', () => {
    const state: BriefState = { seen: {} };
    markSeen(state, ['a'], yesterday);
    expect(whichAreNew(state, ['a'], today)).toEqual(new Set());
  });

  test('markSeen keeps the first sighting, so a rerun cannot refresh an old item into a new one', () => {
    const state: BriefState = { seen: {} };
    markSeen(state, ['a'], yesterday);
    markSeen(state, ['a'], today);
    expect(state.seen.a).toBe(yesterday.toISOString());
  });
});

describe('the run ledger', () => {
  test('todayIsComplete needs a complete run on the same local day', () => {
    const state: BriefState = { seen: {} };
    expect(todayIsComplete(state, today)).toBe(false);

    recordRun(state, { day: '2026-08-21', complete: false }, earlierToday);
    expect(todayIsComplete(state, today)).toBe(false);

    recordRun(state, { day: '2026-08-21', complete: true }, earlierToday);
    expect(todayIsComplete(state, today)).toBe(true);

    // Yesterday's complete run says nothing about today.
    expect(todayIsComplete(state, new Date(2026, 7, 22, 6, 30, 0))).toBe(false);
  });

  test('lastRun and lastDeploy round-trip through the file', () => {
    const path = statePath();
    const state: BriefState = { seen: {} };
    recordRun(state, { day: '2026-08-21', complete: true }, earlierToday);
    recordDeploy(
      state,
      'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      earlierToday,
    );
    saveState(state, path);
    const loaded = loadState(path);
    expect(loaded.lastRun).toEqual({
      day: '2026-08-21',
      at: earlierToday.toISOString(),
      complete: true,
    });
    expect(loaded.lastDeploy).toEqual({
      url: 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      at: earlierToday.toISOString(),
      day: '2026-08-21',
    });
  });

  test('a state file with no ledger yet loads with none', () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({ seen: { a: yesterday.toISOString() } }));
    expect(loadState(path)).toEqual({ seen: { a: yesterday.toISOString() } });
  });

  test('valid JSON with the wrong shape degrades to safe state', () => {
    const path = statePath();
    writeFileSync(
      path,
      JSON.stringify({
        seen: 'not a map',
        lastRun: { day: 42, at: null, complete: 'yes' },
        lastDeploy: ['not', 'an', 'object'],
      }),
    );
    expect(loadState(path)).toEqual({ seen: {} });
  });

  test('keeps valid fields and drops malformed entries independently', () => {
    const path = statePath();
    writeFileSync(
      path,
      JSON.stringify({
        seen: { good: yesterday.toISOString(), bad: 42, invalidTimestamp: 'yesterday-ish' },
        lastRun: { day: '2026-08-21', at: earlierToday.toISOString(), complete: true },
        lastDeploy: { url: false, at: earlierToday.toISOString(), day: '2026-08-21' },
      }),
    );
    expect(loadState(path)).toEqual({
      seen: { good: yesterday.toISOString() },
      lastRun: { day: '2026-08-21', at: earlierToday.toISOString(), complete: true },
    });
  });

  test('drops ledger entries whose date-looking strings are not real dates', () => {
    const path = statePath();
    writeFileSync(
      path,
      JSON.stringify({
        seen: {},
        lastRun: { day: '2026-02-31', at: 'not-a-timestamp', complete: true },
        lastDeploy: {
          url: 'https://example.test',
          at: earlierToday.toISOString(),
          day: '2026-13-01',
        },
      }),
    );
    expect(loadState(path)).toEqual({ seen: {} });
  });
});
