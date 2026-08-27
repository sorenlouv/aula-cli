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
import { errorMessage } from './validation.ts';

const REPO = join(import.meta.dir, '..');
const CAFFEINATE = '/usr/bin/caffeinate';
const PMSET = '/usr/bin/pmset';
const RUN_ARGS = ['new', '--text', '--catch-up'];

export const DEFER_POLL_MS = 60_000;
export const INCOMPLETE_RETRY_MS = 15 * 60_000;

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
  status: 'complete' | 'day-ended';
  attempts: number;
};

/** Wait through DarkWake and retry incomplete runs until today succeeds or ends. */
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
    deps.log('Scheduled brief is incomplete; retrying in 15 minutes while awake.');
    await deps.wait(INCOMPLETE_RETRY_MS);
  }
}

if (import.meta.main) {
  coordinateScheduledBrief().catch((error) => {
    console.error(`Scheduled brief coordinator failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
