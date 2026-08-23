/**
 * Where the client's credentials come from: a stored MitID login, and nothing
 * else.
 *
 * `login` runs the real MitID flow and ends with OAuth tokens written to
 * `~/.aula/tokens.json`, AES-256-GCM encrypted, on every platform. The access
 * token refreshes itself from the refresh token, so day-to-day use never
 * prompts. The login's cookie jar rides along because the calendar POST needs
 * the CSRF token that lives in it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AulaSessionError } from './errors.ts';
import {
  AulaCookieJar,
  AulaHttpClient,
  EncryptedFileTokenStore,
} from './vendor/aula-auth/index.ts';
import type { StoredTokenRecord } from './vendor/aula-auth/index.ts';
import {
  DEFAULT_OAUTH_CONFIG,
  TokenStoreError,
  refreshAccessToken,
  withFreshTokens,
} from './vendor/aula-auth/index.ts';

export const AULA_DIR = process.env.AULA_DIR ?? join(homedir(), '.aula');
export const COOKIE_JAR_PATH = join(AULA_DIR, 'cookies.json');
export const TOKEN_PATH = join(AULA_DIR, 'tokens.json');

/**
 * The AES key file sits next to the ciphertext it opens, so on its own the
 * encryption is only "not readable by grep" — the real protection is the 0700
 * directory. Setting `$AULA_TOKEN_KEY` (64 hex characters, or any passphrase)
 * moves the key out of the filesystem entirely and makes the file useless
 * without it.
 */
const KEY_PATH = join(AULA_DIR, '.token-key');
export const KEY_ENV = 'AULA_TOKEN_KEY';

/**
 * The `cookie` kind never comes out of {@link resolveAuth} — the CLI is
 * MitID-only. It exists as a test seam: the transport tests construct a client
 * from a bare cookie to model an already-bootstrapped session without a token
 * store on disk.
 */
export type Auth =
  | { kind: 'token'; accessToken: string; username: string; cookie?: string }
  | { kind: 'cookie'; cookie: string };

/**
 * `~/.aula` holds the long-lived refresh token, the key that decrypts it, the
 * cookie jar and the response cache. 0700 so no other account on the machine
 * can read any of it — and re-applied on every call, because a directory that
 * predates this code may well be 0755.
 */
export function ensureAulaDir(): string {
  mkdirSync(AULA_DIR, { recursive: true, mode: 0o700 });
  chmodSync(AULA_DIR, 0o700);
  return AULA_DIR;
}

/**
 * One token store, on every platform.
 *
 * This used to be the macOS keychain, which meant `login` simply refused to run
 * anywhere else — no devbox, no Linux, no Pi. `EncryptedFileTokenStore` came
 * across in the same vendored package, is AES-256-GCM, and is already covered
 * by its own tests, so there is no reason to carry two implementations.
 */
export function tokenStore(): EncryptedFileTokenStore {
  ensureAulaDir();
  return new EncryptedFileTokenStore({
    filePath: TOKEN_PATH,
    keyFilePath: KEY_PATH,
    envVarName: KEY_ENV,
  });
}

const HOW_TO_LOGIN = `
Run a MitID login:
  bun run login
`.trim();

export function loginInstructions(): string {
  return HOW_TO_LOGIN;
}

/** The stored MitID login, refreshed if need be — or a clear "not logged in". */
export async function resolveAuth(): Promise<Auth> {
  const record = await loadFreshTokens();
  if (!record) {
    throw new AulaSessionError(
      `Not logged in — no MitID tokens in ${TOKEN_PATH}.\n\n${HOW_TO_LOGIN}`,
    );
  }
  const cookie = await loadCookieHeader();
  return {
    kind: 'token',
    accessToken: record.tokens.access_token,
    username: record.username,
    ...(cookie ? { cookie } : {}),
  };
}

/**
 * The stored login, with the access token refreshed if it is close to expiry.
 * Returns undefined when there is no stored login at all.
 *
 * A refresh writes the new tokens straight back to the store, so the next
 * command starts from the fresh pair rather than repeating the round-trip.
 */
export async function loadFreshTokens(): Promise<StoredTokenRecord | undefined> {
  const store = tokenStore();
  let existing: StoredTokenRecord | null;
  try {
    existing = await store.load();
  } catch (err) {
    // A token file that will not decrypt is emphatically *not* "no login" —
    // reporting it as such sends you off to redo MitID for what is a key
    // problem, and the fresh login then fails to write for the same reason.
    if (err instanceof TokenStoreError) {
      throw new AulaSessionError(
        `${TOKEN_PATH} exists but could not be read: ${err.message}\n\n` +
          `If $${KEY_ENV} is set it must be the same value the tokens were written with. ` +
          `Otherwise delete the file and run \`bun run login\` again.`,
      );
    }
    throw err;
  }
  if (!existing) return undefined;
  return withFreshTokens({ store, http: new AulaHttpClient() });
}

/**
 * Finds a usable access token after Aula has reported the current one
 * superseded (status code 20).
 *
 * Aula retires an access token the instant a refresh grant issues a newer one,
 * however far off its `exp` is. So two `aula` runs that overlap — a manual
 * command during the scheduled brief's retry window, say — will kill each
 * other's token: both start from the same stored pair, whichever refreshes
 * first wins, and the other's next request fails.
 *
 * `withFreshTokens` is no help, because it refreshes on *clock* expiry and a
 * superseded token still looks perfectly fresh.
 *
 * The order below is the whole point. Re-reading the store first means the run
 * that lost the race simply adopts the winner's token and the two converge. If
 * both forced a refresh instead they would rotate each other's tokens
 * indefinitely, each one's grant invalidating the token the other had just
 * fetched — the failure this is supposed to end, in a faster loop. Only when
 * the store still holds the dead token has nobody else refreshed, and buying a
 * new one is then both safe and the only option.
 *
 * @param spent the access token that came back as superseded
 * @returns a different, usable access token, or undefined if there is no login
 *   on disk. Throws {@link OAuthError} when the refresh token itself is dead,
 *   because that genuinely does need MitID again.
 */
export async function refreshSupersededToken(spent: string): Promise<string | undefined> {
  const store = tokenStore();
  const record = await store.load();
  if (!record) return undefined;
  if (record.tokens.access_token !== spent) return record.tokens.access_token;

  const refreshed = await refreshAccessToken(
    new AulaHttpClient(),
    DEFAULT_OAUTH_CONFIG,
    record.tokens.refresh_token,
  );
  // Published to the store as well as returned, so the *next* run starts from
  // the live token rather than repeating this recovery.
  await store.save({ ...record, tokens: refreshed, saved_at: Math.floor(Date.now() / 1000) });
  return refreshed.access_token;
}

// ------------------------------------------------------------------- cookies

/**
 * Aula still wants cookies alongside the token: the calendar read is a POST and
 * needs `Csrfp-Token`. Login therefore keeps its jar, and the data client
 * replays it.
 */
async function loadCookieHeader(): Promise<string | undefined> {
  if (!existsSync(COOKIE_JAR_PATH)) return undefined;
  try {
    const jar = await AulaCookieJar.deserialize(readFileSync(COOKIE_JAR_PATH, 'utf8'));
    const header = await jar.cookieHeader('https://www.aula.dk/');
    return header || undefined;
  } catch {
    // A corrupt jar is not worth failing a read over — the token still authenticates.
    return undefined;
  }
}

export async function saveCookieJar(jar: AulaCookieJar): Promise<string> {
  ensureAulaDir();
  mkdirSync(dirname(COOKIE_JAR_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(COOKIE_JAR_PATH, await jar.serialize(), { mode: 0o600 });
  return COOKIE_JAR_PATH;
}

export function clearCookieJar(): void {
  if (existsSync(COOKIE_JAR_PATH)) writeFileSync(COOKIE_JAR_PATH, '', { mode: 0o600 });
}
