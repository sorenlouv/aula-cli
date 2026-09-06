/**
 * What the previous runs already showed, and how the last one went.
 *
 * The brief is read a couple of times a week, not daily, so "what is new since
 * I last looked" is more useful than "what happened in the last 14 days". That
 * needs memory between runs, which is the first half of this.
 *
 * The second half is the run ledger: whether the brief came out complete, and
 * when the hosted copy was last refreshed. The scheduler retries through the
 * slot — a laptop that was asleep at 06:00 is the normal case, not the
 * exception — and the retries have to know whether there is anything left to
 * do without regenerating the page to find out.
 *
 * The ledger is read against a *slot*, not against a calendar day. It used to
 * be `todayIsComplete`, which was the same question while there was one run a
 * day; with a morning and an evening it would have told the 18:00 run that the
 * 06:00 one had already covered it. See `../slots.ts`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from '../auth.ts';
import { localIsoDate } from '../integrations/types.ts';
import { isRecord, parseIsoDateParts } from '../validation.ts';

/**
 * Under $AULA_DIR when that is set, like every other stored path — so a
 * sandboxed run cannot read the real install's state or, worse, its deploy
 * target and start publishing test pages to the family's hosted brief.
 */
export const BRIEF_DIR = join(AULA_DIR, 'brief');
const STATE_PATH = join(BRIEF_DIR, 'state.json');

export type LastRun = {
  /** Local calendar day the run produced a page for. */
  day: string;
  at: string;
  /**
   * Every retryable stage did its job: source reads completed, the model ran
   * where asked, page invariants passed, and the hosted copy was refreshed
   * where configured. Otherwise the scheduler's next retry does it over.
   */
  complete: boolean;
};

export type LastDeploy = {
  url: string;
  at: string;
  day: string;
};

export type BriefState = {
  /** Source keys already shown, mapped to when they were first seen. */
  seen: Record<string, string>;
  lastRun?: LastRun;
  lastDeploy?: LastDeploy;
  /**
   * The start of a slot whose retry window the scheduler spent without ever
   * producing a complete brief, as an ISO timestamp.
   *
   * This is what stops the wake-up heartbeat turning a permanent failure into
   * an all-day one. The coordinator gives up after three hours, but the
   * heartbeat that exists to catch a laptop opened at noon would otherwise
   * start a fresh three-hour window a quarter of an hour later, and again
   * after that, until the next slot — the nine-hour morning that window was
   * introduced to prevent.
   *
   * Anchored to the slot rather than stored on `lastRun`, so a later run
   * writing its own outcome cannot quietly clear it, and so it expires by
   * itself: the next slot has a different start and never matches.
   */
  exhaustedSlot?: string;
};

export function loadState(path = STATE_PATH): BriefState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return { seen: {} };

    const seen = isRecord(parsed.seen)
      ? Object.fromEntries(
          Object.entries(parsed.seen).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && Number.isFinite(Date.parse(entry[1])),
          ),
        )
      : {};
    const lastRun = parseLastRun(parsed.lastRun);
    const lastDeploy = parseLastDeploy(parsed.lastDeploy);
    const exhaustedSlot =
      typeof parsed.exhaustedSlot === 'string' && Number.isFinite(Date.parse(parsed.exhaustedSlot))
        ? parsed.exhaustedSlot
        : undefined;
    return {
      seen,
      ...(lastRun ? { lastRun } : {}),
      ...(lastDeploy ? { lastDeploy } : {}),
      ...(exhaustedSlot ? { exhaustedSlot } : {}),
    };
  } catch {
    // A missing or corrupt state file must never stop a brief being produced —
    // the worst case is that everything is marked new for one run.
    return { seen: {} };
  }
}

function parseLastRun(value: unknown): LastRun | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.day !== 'string' ||
    !parseIsoDateParts(value.day) ||
    typeof value.at !== 'string' ||
    !Number.isFinite(Date.parse(value.at)) ||
    typeof value.complete !== 'boolean'
  ) {
    return undefined;
  }
  return { day: value.day, at: value.at, complete: value.complete };
}

function parseLastDeploy(value: unknown): LastDeploy | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.url !== 'string' ||
    !value.url ||
    typeof value.at !== 'string' ||
    !Number.isFinite(Date.parse(value.at)) ||
    typeof value.day !== 'string' ||
    !parseIsoDateParts(value.day)
  ) {
    return undefined;
  }
  return { url: value.url, at: value.at, day: value.day };
}

export function saveState(state: BriefState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Marks every key seen.
 *
 * Deliberately called only once the page has been written: a run that crashes
 * later re-flags everything as new next time, which is harmless, while the
 * opposite — marking seen and then failing to show them — would hide items
 * permanently.
 */
export function markSeen(state: BriefState, keys: string[], now = new Date()): void {
  const stamp = now.toISOString();
  for (const key of keys) {
    if (!state.seen[key]) state.seen[key] = stamp;
  }
}

/**
 * "New" means first seen *today*, not first seen by this run. The scheduler
 * may build the page more than once in a morning — a degraded 06:30 run and
 * the retry that completes it — and a `Ny` chip that vanished between the two
 * would tell the reader the item was old when it arrived hours ago.
 */
export function whichAreNew(state: BriefState, keys: string[], now = new Date()): Set<string> {
  const today = localIsoDate(now);
  return new Set(
    keys.filter((key) => {
      const seenAt = state.seen[key];
      if (!seenAt) return true;
      const stamp = Date.parse(seenAt);
      return Number.isFinite(stamp) && localIsoDate(new Date(stamp)) === today;
    }),
  );
}

/** Drops entries older than `days` so the file cannot grow without bound. */
export function pruneState(state: BriefState, days = 120, now = new Date()): void {
  const cutoff = now.getTime() - days * 86_400_000;
  for (const [key, at] of Object.entries(state.seen)) {
    const stamp = Date.parse(at);
    if (Number.isFinite(stamp) && stamp < cutoff) delete state.seen[key];
  }
}

/**
 * Whether a complete brief already exists for the slot that began at
 * `slotStart`.
 *
 * The test is on the run's timestamp, not on a slot recorded alongside it: a
 * complete run at any moment inside the slot satisfies it, which is what lets
 * a brief the user generated by hand at 14:00 stand in for the 06:00 one the
 * scheduler owed them, exactly as the day-granular version used to.
 */
export function slotIsComplete(state: BriefState, slotStart: Date): boolean {
  const run = state.lastRun;
  if (!run?.complete) return false;
  const at = Date.parse(run.at);
  return Number.isFinite(at) && at >= slotStart.getTime();
}

/** Whether the scheduler already spent this slot's retry window on failures. */
export function slotIsExhausted(state: BriefState, slotStart: Date): boolean {
  return state.exhaustedSlot === slotStart.toISOString();
}

/**
 * Whether there is anything left for the scheduler to attempt in this slot —
 * either because it succeeded, or because it ran out of the retries it was
 * promised. Only the scheduler asks this; a person running `aula new` by hand
 * is never refused for having exhausted a window.
 */
export function slotIsSettled(state: BriefState, slotStart: Date): boolean {
  return slotIsComplete(state, slotStart) || slotIsExhausted(state, slotStart);
}

export function recordExhausted(state: BriefState, slotStart: Date): void {
  state.exhaustedSlot = slotStart.toISOString();
}

export function recordRun(
  state: BriefState,
  run: { day: string; complete: boolean },
  now = new Date(),
): void {
  state.lastRun = { day: run.day, at: now.toISOString(), complete: run.complete };
}

export function recordDeploy(state: BriefState, url: string, now = new Date()): void {
  state.lastDeploy = { url, at: now.toISOString(), day: localIsoDate(now) };
}
