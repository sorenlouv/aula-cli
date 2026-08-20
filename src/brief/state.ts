/**
 * What the previous runs already showed.
 *
 * The brief is read a couple of times a week, not daily, so "what is new since
 * I last looked" is more useful than "what happened in the last 14 days". That
 * needs memory between runs, which is all this is.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from '../auth.ts';

/**
 * Under $AULA_DIR when that is set, like every other stored path — so a
 * sandboxed run cannot read the real install's state or, worse, its deploy
 * target and start publishing test pages to the family's hosted brief.
 */
export const BRIEF_DIR = join(AULA_DIR, 'brief');
const STATE_PATH = join(BRIEF_DIR, 'state.json');

export type BriefState = {
  /** Source keys already shown, mapped to when they were first seen. */
  seen: Record<string, string>;
};

export function loadState(path = STATE_PATH): BriefState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BriefState>;
    return { seen: parsed.seen ?? {} };
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

export function whichAreNew(state: BriefState, keys: string[]): Set<string> {
  return new Set(keys.filter((key) => !state.seen[key]));
}

/** Drops entries older than `days` so the file cannot grow without bound. */
export function pruneState(state: BriefState, days = 120, now = new Date()): void {
  const cutoff = now.getTime() - days * 86_400_000;
  for (const [key, at] of Object.entries(state.seen)) {
    const stamp = Date.parse(at);
    if (Number.isFinite(stamp) && stamp < cutoff) delete state.seen[key];
  }
}
