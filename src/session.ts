import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const SESSION_PATH = process.env.AULA_SESSION_FILE ?? join(homedir(), '.aula', 'session.json');

export type StoredSession = {
  cookie: string;
  savedAt: string;
  /**
   * The MitID username. Not needed for the Aula API itself — the cookie is the
   * whole auth story there — but Meebook and Systematic identify the session by
   * it and reject the Aula guardian id. See src/integrations/types.ts.
   */
  mitidUsername?: string;
};

export class AulaSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AulaSessionError';
  }
}

const HOW_TO_REFRESH = `
How to get a fresh session cookie:
  1. Log in to https://www.aula.dk with MitID in your browser.
  2. Open DevTools -> Application -> Cookies -> https://www.aula.dk
     (or Network tab -> any /api/ request -> Request Headers -> Cookie).
  3. Copy the whole Cookie value. It must include PHPSESSID and Csrfp-Token.
  4. Run:  bun src/cli.ts session set '<paste cookie here>'

MitID cannot be automated, so this is a manual step whenever the session expires
(typically after a few hours of inactivity, and always after an explicit logout).
`.trim();

export function refreshInstructions(): string {
  return HOW_TO_REFRESH;
}

/** Cookie string, from $AULA_COOKIE if set, otherwise from the session file. */
export function loadCookie(): string {
  const fromEnv = process.env.AULA_COOKIE?.trim();
  if (fromEnv) return normaliseCookie(fromEnv);

  if (!existsSync(SESSION_PATH)) {
    throw new AulaSessionError(
      `No Aula session found (looked at $AULA_COOKIE and ${SESSION_PATH}).\n\n${HOW_TO_REFRESH}`,
    );
  }

  let stored: StoredSession;
  try {
    stored = JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as StoredSession;
  } catch (err) {
    throw new AulaSessionError(`Could not read ${SESSION_PATH}: ${(err as Error).message}`);
  }

  if (!stored.cookie) {
    throw new AulaSessionError(`${SESSION_PATH} has no "cookie" field.\n\n${HOW_TO_REFRESH}`);
  }
  return normaliseCookie(stored.cookie);
}

/** The stored session, or undefined when there is no file. */
function readStored(): StoredSession | undefined {
  if (!existsSync(SESSION_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf8')) as StoredSession;
  } catch {
    return undefined;
  }
}

export function saveCookie(raw: string): string {
  const cookie = normaliseCookie(raw);
  if (!/PHPSESSID=/i.test(cookie)) {
    throw new AulaSessionError('Cookie is missing PHPSESSID — that is the actual session token.');
  }
  // The username outlives the cookie — it is not a credential and does not
  // expire — so re-pasting a cookie must not silently drop it.
  const existing = readStored();
  return writeSession({
    cookie,
    savedAt: new Date().toISOString(),
    ...(existing?.mitidUsername ? { mitidUsername: existing.mitidUsername } : {}),
  });
}

export function saveMitidUsername(username: string): string {
  const existing = readStored();
  if (!existing?.cookie) {
    throw new AulaSessionError(
      `No session to attach a username to. Run \`session set '<cookie>'\` first.`,
    );
  }
  return writeSession({ ...existing, mitidUsername: username.trim() });
}

function writeSession(payload: StoredSession): string {
  mkdirSync(dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_PATH, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  chmodSync(SESSION_PATH, 0o600);
  return SESSION_PATH;
}

/** MitID username, from `$AULA_MITID_USERNAME` or the session file. */
export function loadMitidUsername(): string | undefined {
  const fromEnv = process.env.AULA_MITID_USERNAME?.trim();
  if (fromEnv) return fromEnv;
  return readStored()?.mitidUsername?.trim() || undefined;
}

/**
 * Accepts either a raw `Cookie:` header value or a full curl-style line pasted
 * from DevTools, and trims it down to the bare `k=v; k=v` form.
 */
function normaliseCookie(raw: string): string {
  return raw
    .trim()
    .replace(/^-H\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/^cookie:\s*/i, '')
    .trim();
}

/** Pulls a single cookie value out of the cookie string (used for the CSRF header). */
export function readCookieValue(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}
