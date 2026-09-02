import { describe, expect, test } from 'bun:test';
import {
  coordinateScheduledBrief,
  DEFER_POLL_MS,
  INCOMPLETE_RETRY_MS,
  MAX_ATTEMPTS,
  shouldDeferForDarkWake,
  type MacPowerState,
} from './scheduled-brief.ts';
import { scheduleTimes } from './schedule.ts';

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

  test('gives up after the declared window instead of retrying until midnight', async () => {
    // The loop used to end only at the local day boundary, so a cause retrying
    // could never fix — an expired `claude` login — cost thirty-one full runs
    // across nine hours, each one a spawned model process and a permission
    // prompt.
    const waits: number[] = [];
    const logs: string[] = [];
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => morning,
      isComplete: () => false,
      powerState: () => ({ source: 'ac', fullWake: true }),
      runBrief: async () => {
        runs += 1;
        return 0;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      log: (message) => logs.push(message),
    });

    expect(outcome).toEqual({ status: 'retries-exhausted', attempts: MAX_ATTEMPTS });
    expect(runs).toBe(MAX_ATTEMPTS);
    // One wait fewer than attempts: the last failure gives up rather than
    // sleeping through a quarter hour it has no intention of using.
    expect(waits).toEqual(Array(MAX_ATTEMPTS - 1).fill(INCOMPLETE_RETRY_MS));
    expect(logs.at(-1)).toContain('gave up');
  });

  test('the attempt budget is exactly the schedule it implements', () => {
    // Both sides derive from RETRY_EVERY_MINUTES and RETRY_FOR_MINUTES, and
    // this is what stops one of them being pinned to a literal again: when they
    // disagree, `aula schedule` prints a window the coordinator does not keep.
    expect(MAX_ATTEMPTS).toBe(scheduleTimes({ hour: 6, minute: 30 }).length);
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
