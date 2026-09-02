import { describe, expect, test } from 'bun:test';
import {
  coordinateScheduledBrief,
  DEFER_POLL_MS,
  INCOMPLETE_RETRY_MS,
  RETRY_WINDOW_MS,
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
    let clock = morning.getTime();
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => new Date(clock),
      isComplete: () => false,
      powerState: () => ({ source: 'ac', fullWake: true }),
      runBrief: async () => {
        runs += 1;
        return 0;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      log: (message) => logs.push(message),
    });

    // Instant runs land one per retry interval, so the window admits exactly
    // the launchd slots `scheduleTimes` writes for the same window — the two
    // derive from the same constants and this is what keeps them saying the
    // same thing.
    const slots = scheduleTimes({ hour: 6, minute: 30 }).length;
    expect(outcome).toEqual({ status: 'retries-exhausted', attempts: slots });
    expect(runs).toBe(slots);
    // One wait fewer than attempts: the last failure gives up rather than
    // sleeping through a quarter hour it has no intention of using.
    expect(waits).toEqual(Array(slots - 1).fill(INCOMPLETE_RETRY_MS));
    expect(logs.at(-1)).toContain('gave up');
  });

  test('a slow run spends the window in wall-clock time, not in attempts', async () => {
    // Each attempt burns half an hour — two ten-minute model timeouts and the
    // wait between them. A budget counted in attempts would allow thirteen of
    // those and sit there for seven hours; the window admits six.
    const slow = 30 * 60_000;
    let clock = morning.getTime();
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => new Date(clock),
      isComplete: () => false,
      powerState: () => ({ source: 'ac', fullWake: true }),
      runBrief: async () => {
        runs += 1;
        clock += slow;
        return 0;
      },
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      log: () => {},
    });

    expect(outcome.status).toBe('retries-exhausted');
    // Thirteen attempts at this speed would be nearly ten hours. Five fit.
    expect(runs).toBe(5);
    // The window bounds when a new attempt may *start*, not when a running one
    // must finish: a brief in flight is never killed mid-run, so the process
    // can outlive the window by at most the length of one attempt.
    expect(clock - morning.getTime()).toBeLessThanOrEqual(RETRY_WINDOW_MS + slow);
  });

  test('sleeping through the scheduled hour does not spend the window', async () => {
    // The clock starts at the first attempt that runs, not at process start.
    // A Mac that wakes at noon gets the same three hours it would have had at
    // 06:30 — the case the coordinator exists for.
    const power: MacPowerState[] = [
      { source: 'battery', fullWake: false },
      { source: 'battery', fullWake: false },
    ];
    let clock = morning.getTime();
    let runs = 0;

    const outcome = await coordinateScheduledBrief({
      now: () => new Date(clock),
      isComplete: () => runs === 1,
      powerState: () => power.shift() ?? { source: 'ac', fullWake: true },
      runBrief: async () => {
        runs += 1;
        return 0;
      },
      // Five hours of DarkWake polling, well past the window, before any run.
      wait: async () => {
        clock += 150 * 60_000;
      },
      log: () => {},
    });

    expect(outcome).toEqual({ status: 'complete', attempts: 1 });
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
