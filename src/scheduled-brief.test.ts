import { describe, expect, test } from 'bun:test';
import {
  coordinateScheduledBrief,
  DEFER_POLL_MS,
  INCOMPLETE_RETRY_MS,
  shouldDeferForDarkWake,
  type MacPowerState,
} from './scheduled-brief.ts';

describe('shouldDeferForDarkWake', () => {
  test('defers only a positively identified battery DarkWake', () => {
    expect(shouldDeferForDarkWake({ source: 'battery', fullWake: false })).toBe(true);
    expect(shouldDeferForDarkWake({ source: 'battery', fullWake: true })).toBe(false);
    expect(shouldDeferForDarkWake({ source: 'ac', fullWake: false })).toBe(false);
    expect(shouldDeferForDarkWake({ source: 'unknown', fullWake: null })).toBe(false);
  });
});

describe('coordinateScheduledBrief', () => {
  const morning = new Date(2026, 7, 25, 6, 30);

  test('waits through DarkWake, then runs once after a full wake', async () => {
    const power: MacPowerState[] = [
      { source: 'battery', fullWake: false },
      { source: 'battery', fullWake: true },
    ];
    const waits: number[] = [];
    const logs: string[] = [];
    let complete = false;
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => morning,
      isComplete: () => complete,
      powerState: () => power.shift() ?? { source: 'battery', fullWake: true },
      runBrief: async () => {
        runs += 1;
        complete = true;
        return 0;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      log: (message) => logs.push(message),
    });

    expect(outcome).toEqual({ status: 'complete', attempts: 1 });
    expect(runs).toBe(1);
    expect(waits).toEqual([DEFER_POLL_MS]);
    expect(logs).toEqual([
      'Scheduled brief deferred: Mac is in battery DarkWake.',
      'Scheduled brief resumed after a full wake or AC connection.',
      'Scheduled brief attempt 1 started.',
    ]);
  });

  test('retries an incomplete awake run without overlapping it', async () => {
    const waits: number[] = [];
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => morning,
      isComplete: () => runs === 2,
      powerState: () => ({ source: 'ac', fullWake: false }),
      runBrief: async () => {
        runs += 1;
        return 0;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      log: () => {},
    });

    expect(outcome).toEqual({ status: 'complete', attempts: 2 });
    expect(waits).toEqual([INCOMPLETE_RETRY_MS]);
  });

  test('stops instead of generating yesterday after the local day changes', async () => {
    const nextDay = new Date(2026, 7, 26, 0, 1);
    const times = [morning, morning, nextDay];
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => times.shift() ?? nextDay,
      isComplete: () => false,
      powerState: () => ({ source: 'battery', fullWake: false }),
      runBrief: async () => {
        runs += 1;
        return 0;
      },
      wait: async () => {},
      log: () => {},
    });

    expect(outcome).toEqual({ status: 'day-ended', attempts: 0 });
    expect(runs).toBe(0);
  });
});
