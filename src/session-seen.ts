/**
 * What Aula said about the stored login the last time a command reached it.
 *
 * `status` exists to answer "is there a usable session?", and it used to answer
 * something else: how many minutes the *access token* had left. That number
 * refreshes itself and says nothing about whether the login still works — and
 * reading it went through the same load-and-refresh path every read uses, so
 * asking could itself spend the refresh token and retire the access token of
 * an `aula` run beside it.
 *
 * Whether Aula accepts a login is only knowable by asking Aula. So the answer
 * is written down whenever a command *does* ask — the session bootstrap every
 * uncached read performs, which also says whether the session is stepped up —
 * and `status` reads it back from disk with no request and no refresh. It is
 * an observation with a time on it, not a promise: `checkedAt` is how old.
 *
 * Aula publishes no lifetime for the refresh token or for step-up, so neither
 * has an expiry to report; the last observation is the honest substitute.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AULA_DIR, ensureAulaDir } from './auth.ts';
import { isRecord } from './validation.ts';

const SESSION_SEEN_PATH = join(AULA_DIR, 'session-seen.json');

export type SessionSeen = {
  /** `accepted`: a read got through. `rejected`: Aula refused the login outright. */
  state: 'accepted' | 'rejected';
  /** When that was observed, ISO 8601. */
  checkedAt: string;
  /**
   * Whether the session could read sensitive threads then. Null when the
   * observation could not tell — a rejection, or a login nothing has read with
   * yet.
   */
  steppedUp: boolean | null;
};

export function recordSessionSeen(seen: Omit<SessionSeen, 'checkedAt'>, now = new Date()): void {
  try {
    ensureAulaDir();
    const record: SessionSeen = { ...seen, checkedAt: now.toISOString() };
    writeFileSync(SESSION_SEEN_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // A note for `status` is never worth failing the read that produced it.
  }
}

/** The last observation, or null when there is none worth trusting. */
export function readSessionSeen(): SessionSeen | null {
  if (!existsSync(SESSION_SEEN_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(SESSION_SEEN_PATH, 'utf8'));
    if (
      !isRecord(parsed) ||
      (parsed.state !== 'accepted' && parsed.state !== 'rejected') ||
      typeof parsed.checkedAt !== 'string' ||
      !(typeof parsed.steppedUp === 'boolean' || parsed.steppedUp === null)
    ) {
      return null;
    }
    return { state: parsed.state, checkedAt: parsed.checkedAt, steppedUp: parsed.steppedUp };
  } catch {
    return null;
  }
}

/** A different login, or none: whatever was observed no longer describes it. */
export function forgetSessionSeen(): void {
  rmSync(SESSION_SEEN_PATH, { force: true });
}
