/**
 * What the previous runs already showed, and how the last one went.
 *
 * The brief is read a couple of times a week, not daily, so "what is new since
 * I last looked" is more useful than "what happened in the last 14 days". That
 * needs memory between runs, which is the first half of this.
 *
 * The second half is the run ledger: whether today's brief came out complete,
 * and when the hosted copy was last refreshed. The scheduler retries through
 * the morning — a laptop that was asleep at 06:30 is the normal case, not the
 * exception — and the retries have to know whether there is anything left to
 * do without regenerating the page to find out.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from '../auth.ts';
import { localIsoDate } from '../integrations/types.ts';

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
   * Every stage did its job: the model ran where asked, and the hosted copy
   * was refreshed where one is configured. A run that degraded — rules only,
   * fallback layout, deploy that did not land — is not complete, and the
   * scheduler's next retry does it over.
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
};

export function loadState(path = STATE_PATH): BriefState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BriefState>;
    return {
      seen: parsed.seen ?? {},
      ...(parsed.lastRun ? { lastRun: parsed.lastRun } : {}),
      ...(parsed.lastDeploy ? { lastDeploy: parsed.lastDeploy } : {}),
    };
  } catch {
    // A missing or corrupt state file must never stop a brief being produced —
    // the worst case is that everything is marked new for one run.
    return { seen: {} };
  }
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

/** Whether a run already produced a complete brief for the local day of `now`. */
export function todayIsComplete(state: BriefState, now = new Date()): boolean {
  return state.lastRun?.complete === true && state.lastRun.day === localIsoDate(now);
}

export function recordRun(state: BriefState, run: { day: string; complete: boolean }, now = new Date()): void {
  state.lastRun = { day: run.day, at: now.toISOString(), complete: run.complete };
}

export function recordDeploy(state: BriefState, url: string, now = new Date()): void {
  state.lastDeploy = { url, at: now.toISOString(), day: localIsoDate(now) };
}
