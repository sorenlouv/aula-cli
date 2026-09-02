/**
 * The macOS schedule coordinator.
 *
 * A StartCalendarInterval can run during battery DarkWake. That window is too
 * short for Aula reads plus a model call, and `caffeinate -s` is honoured only
 * on AC power. This cheap process therefore waits without a sleep assertion;
 * macOS suspends it with the machine and resumes it on the next wake. The
 * expensive child starts only on AC or in a full graphical wake, and only that
 * child is wrapped in caffeinate.
 */

import { join } from 'node:path';
import { loadState, todayIsComplete } from './brief/state.ts';
import { localIsoDate } from './integrations/types.ts';
import { cliInvocation, isCompiled } from './runtime.ts';
import { RETRY_EVERY_MINUTES, RETRY_FOR_MINUTES } from './schedule.ts';
import { errorMessage } from './validation.ts';

const REPO = join(import.meta.dir, '..');
const CAFFEINATE = '/usr/bin/caffeinate';
const PMSET = '/usr/bin/pmset';
const RUN_ARGS = ['new', '--text', '--catch-up'];

export const DEFER_POLL_MS = 60_000;
export const INCOMPLETE_RETRY_MS = RETRY_EVERY_MINUTES * 60_000;

/**
 * The declared retry window, as the duration it actually is.
 *
 * `schedule.ts` already says how long a morning may be retried — every
 * `RETRY_EVERY_MINUTES` for `RETRY_FOR_MINUTES` — and writes exactly that into
 * the launchd slots, the Windows `/RI` and `/DU` pair and the cron hour range.
 * This loop ignored it and retried until the local day ended, so the process
 * implementing the schedule outlived the schedule it was implementing, and
 * `aula schedule`'s own printed promise ("retrying every 15 min until 09:30")
 * was not what ran. An expired `claude` login held one morning at "incomplete"
 * for thirty-one attempts across nine hours — each a full Aula read, a spawned
 * model process and a macOS permission prompt — and the thirty-first was as
 * doomed as the first.
 *
 * This was briefly a count of attempts instead, which only holds while every
 * attempt is quick. Raising the extraction timeout to ten minutes broke that:
 * two timed-out calls plus the wait between them is a thirty-five minute
 * attempt, and thirteen of those is a seven-hour morning — the very shape the
 * count was introduced to prevent.
 *
 * The clock starts at the first attempt that actually *ran*, not at process
 * start, which is what lets it stay a duration without punishing the case this
 * coordinator exists for: a DarkWake defer polls without starting it, so a Mac
 * that wakes at noon still gets the full window from noon.
 */
export const RETRY_WINDOW_MS = RETRY_FOR_MINUTES * 60_000;

export type MacPowerState = {
  source: 'ac' | 'battery' | 'unknown';
  /** Graphics capability distinguishes a full wake from maintenance DarkWake. */
  fullWake: boolean | null;
};

function commandOutput(args: string[]): string | null {
  const result = Bun.spawnSync({ cmd: args, stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString('utf8') : null;
}

/** Read only documented pmset state; an unknown answer falls back to trying. */
export function readMacPowerState(): MacPowerState {
  const battery = commandOutput([PMSET, '-g', 'batt']);
  const system = commandOutput([PMSET, '-g', 'systemstate']);
  const source = battery?.includes("Now drawing from 'AC Power'")
    ? 'ac'
    : battery?.includes("Now drawing from 'Battery Power'")
      ? 'battery'
      : 'unknown';
  const fullWake = system === null ? null : /\bGraphics\b/.test(system);
  return { source, fullWake };
}

/** Defer only when both signals positively identify an unsafe battery DarkWake. */
export function shouldDeferForDarkWake(state: MacPowerState): boolean {
  return state.source === 'battery' && state.fullWake === false;
}

export type ScheduledBriefDependencies = {
  now: () => Date;
  isComplete: (now: Date) => boolean;
  powerState: () => MacPowerState;
  runBrief: () => Promise<number>;
  wait: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
};

const defaults: ScheduledBriefDependencies = {
  now: () => new Date(),
  isComplete: (now) => todayIsComplete(loadState(), now),
  powerState: readMacPowerState,
  runBrief: async () => {
    const child = Bun.spawn([CAFFEINATE, '-i', '-s', ...cliInvocation(), ...RUN_ARGS], {
      // A binary needs no working directory; from source, relative imports do.
      ...(isCompiled() ? {} : { cwd: REPO }),
      env: process.env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  },
  wait: async (milliseconds) => await Bun.sleep(milliseconds),
  log: (message) => console.log(message),
};

export type ScheduledBriefOutcome = {
  status: 'complete' | 'day-ended' | 'retries-exhausted';
  attempts: number;
};

/**
 * Wait through DarkWake, then retry incomplete runs until one succeeds, the
 * declared window's attempts run out, or the local day ends.
 */
export async function coordinateScheduledBrief(
  overrides: Partial<ScheduledBriefDependencies> = {},
): Promise<ScheduledBriefOutcome> {
  const deps = { ...defaults, ...overrides };
  const day = localIsoDate(deps.now());
  let attempts = 0;
  let wasDeferred = false;
  let windowOpenedAt: number | null = null;

  for (;;) {
    const now = deps.now();
    if (localIsoDate(now) !== day) return { status: 'day-ended', attempts };
    if (deps.isComplete(now)) return { status: 'complete', attempts };

    const power = deps.powerState();
    if (shouldDeferForDarkWake(power)) {
      if (!wasDeferred) {
        deps.log('Scheduled brief deferred: Mac is in battery DarkWake.');
        wasDeferred = true;
      }
      await deps.wait(DEFER_POLL_MS);
      continue;
    }

    if (wasDeferred) deps.log('Scheduled brief resumed after a full wake or AC connection.');
    wasDeferred = false;
    // The window opens on the first attempt that runs, so sleeping through the
    // scheduled hour costs nothing of it.
    windowOpenedAt ??= now.getTime();
    attempts += 1;
    deps.log(`Scheduled brief attempt ${attempts} started.`);
    try {
      const code = await deps.runBrief();
      if (code !== 0) deps.log(`Scheduled brief command exited ${code}.`);
    } catch (error) {
      deps.log(`Scheduled brief command failed: ${errorMessage(error)}`);
    }

    const after = deps.now();
    if (localIsoDate(after) !== day) return { status: 'day-ended', attempts };
    if (deps.isComplete(after)) return { status: 'complete', attempts };
    // Would the next attempt start after the window closes? Asked before the
    // wait rather than after it, so a spent budget ends the process now instead
    // of sleeping a quarter of an hour to discover the same thing.
    if (
      after.getTime() - (windowOpenedAt ?? after.getTime()) + INCOMPLETE_RETRY_MS >
      RETRY_WINDOW_MS
    ) {
      // The run's own notes are already in this log — stderr is inherited — so
      // this line says what the scheduler decided, not what went wrong.
      deps.log(
        `Scheduled brief gave up after ${attempts} attempts in ${RETRY_FOR_MINUTES} minutes; see the notes above. Tomorrow's schedule tries again.`,
      );
      return { status: 'retries-exhausted', attempts };
    }
    deps.log(
      `Scheduled brief is incomplete; retrying in ${RETRY_EVERY_MINUTES} minutes while awake.`,
    );
    await deps.wait(INCOMPLETE_RETRY_MS);
  }
}
