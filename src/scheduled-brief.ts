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
 * The declared retry window, counted in attempts.
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
 * Counted in attempts rather than against the clock on purpose: a DarkWake
 * defer polls without spending one, so a Mac that sleeps past the window still
 * gets the whole budget on the wake that follows. A deadline would take that
 * away, and it is the case this coordinator exists for.
 */
export const MAX_ATTEMPTS = 1 + RETRY_FOR_MINUTES / RETRY_EVERY_MINUTES;

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
    if (attempts >= MAX_ATTEMPTS) {
      // The run's own notes are already in this log — stderr is inherited — so
      // this line says what the scheduler decided, not what went wrong.
      deps.log(
        `Scheduled brief gave up after ${attempts} attempts; see the notes above. Tomorrow's schedule tries again.`,
      );
      return { status: 'retries-exhausted', attempts };
    }
    deps.log(
      `Scheduled brief is incomplete; retrying in ${RETRY_EVERY_MINUTES} minutes while awake.`,
    );
    await deps.wait(INCOMPLETE_RETRY_MS);
  }
}
