import { createHash } from 'node:crypto';
import { type Auth, loginInstructions, resolveAuth } from './auth.ts';
import { type CacheSettings, ResponseCache, openCache } from './cache.ts';
import { type Remedy, formatRemedy } from './errors.ts';
import type {
  Album,
  CalendarEvent,
  CommonFileList,
  Contact,
  GroupContext,
  Notification,
  PostList,
  PresenceEntry,
  PresenceTemplates,
  Profile,
  ProfileContext,
  ThreadDetail,
  ThreadList,
} from './types.ts';
import { isRecord, parseInteger } from './validation.ts';

const FALLBACK_API_VERSION = 24;
const MAX_API_VERSION_TO_PROBE = FALLBACK_API_VERSION + 12;
const BASE = 'https://www.aula.dk/api';
const USER_AGENT = 'aula-cli/0.1 (+personal read-only client)';
/** The health probe runs on a path that has already failed — it may not hang. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Hard read-only guard.
 *
 * This project is explicitly not allowed to write anything to Aula — no
 * messages, no posts, no calendar answers, no marking things as read. Rather
 * than trusting each call site, every request funnels through `request()` and
 * is checked against this allowlist. Anything not listed here is refused
 * locally, before a socket is opened.
 */
export const READ_ONLY_METHODS = new Set<string>([
  'profiles.getProfilesByLogin',
  'profiles.getProfileContext',
  'profiles.getContactlist',
  'messaging.getThreads',
  'messaging.getMessagesForThread',
  'posts.getAllPosts',
  'gallery.getAlbums',
  'calendar.getEventsByProfileIdsAndResourceIds',
  'presence.getDailyOverview',
  'presence.getPresenceTemplates',
  'groups.getGroupsByContext',
  'notifications.getNotificationsForActiveProfile',
  'commonFiles.getCommonFiles',
  'aulaToken.getAulaToken',
]);

/**
 * The only endpoint we may call with POST. Aula models this particular *read*
 * as a POST because the filter payload is too big for a query string; it does
 * not mutate anything.
 */
const POST_ALLOWED = new Set<string>(['calendar.getEventsByProfileIdsAndResourceIds']);

/**
 * Aula method names are `module.verbNoun`, and the read verbs are exactly
 * `get`/`is`/`has`. Anything else — `send`, `create`, `update`, `delete`,
 * `mark`, `register` — mutates.
 *
 * The named allowlist above is the primary guard; this pattern is what lets
 * `raw` (the escape hatch for endpoints without a typed wrapper) exist at all
 * without turning the read-only promise into an honour system.
 *
 * Anchored at both ends on purpose. A prefix match would accept
 * `profiles.getContactlist; something-else` — the leading getter is not
 * evidence about the rest of the string.
 */
export const READ_METHOD_PATTERN = /^[a-zA-Z]+\.(get|is|has)[A-Z][a-zA-Z0-9]*$/;

/**
 * The guard itself, exported so it can be tested directly rather than inferred
 * from the behaviour of the wrappers. Throws before any socket is opened.
 *
 * `allowAnyGetter` widens the check from the named allowlist to "any method
 * whose name is a getter" — used only by the `raw` command, which exists so an
 * un-wrapped read endpoint doesn't require a code change to reach.
 */
export function assertReadOnly(
  method: string,
  httpMethod: 'GET' | 'POST',
  opts: { allowAnyGetter?: boolean } = {},
): void {
  const known = READ_ONLY_METHODS.has(method);
  if (!known && !(opts.allowAnyGetter && READ_METHOD_PATTERN.test(method))) {
    throw new AulaApiError(
      method,
      -1,
      opts.allowAnyGetter
        ? `Refusing to call "${method}": this client is read-only, and only ` +
          `methods named "module.get*", "module.is*" or "module.has*" can be ` +
          `called without a typed wrapper.`
        : `Refusing to call "${method}": this client is read-only and only allows ` +
          `[${[...READ_ONLY_METHODS].join(', ')}].`,
    );
  }
  if (httpMethod === 'POST' && !POST_ALLOWED.has(method)) {
    throw new AulaApiError(method, -1, `Refusing to POST to "${method}" — read-only client.`);
  }
}

/**
 * Aula's own status codes, which travel in the JSON envelope and do not line up
 * with the HTTP status. Observed against the live API:
 *   0   ok
 *   10  retired API version, or unknown method
 *   40  bad/missing parameters
 *   403 authenticated, but not allowed to read this
 *   448 not authenticated — session expired or bogus
 */
const STATUS_RETIRED_VERSION = 10;
const STATUS_BAD_PARAMETERS = 40;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_AUTHENTICATED = 448;

/** Longest calendar window Aula will answer. Measured: 50 passes, 51 gives 403. */
export const CALENDAR_MAX_SPAN_DAYS = 50;

/** Aula's own Fælles Filer page uses 10; larger works, but 100 fails with 40. */
const COMMON_FILES_PAGE_SIZE = 50;

/**
 * Reads that must always go to Aula.
 *
 * A widget token lives about a minute, and `WidgetTokens.withToken` recovers
 * from an expired one by asking for a *fresh* token and retrying. Answering
 * that second request from cache would return the same dead token and convert
 * a routine expiry into a hard WidgetError. See src/cache.ts.
 */
const NEVER_CACHED = new Set<string>(['aulaToken.getAulaToken']);

/**
 * Both error types take either a bare string or a {@link Remedy}. The string
 * form is for failures the user cannot act on — the read-only guard refusing a
 * method is a programming mistake, not something to go and fix — and every
 * failure that *does* have a fix is expected to spell it out.
 */
export class AulaApiError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(method: string, code: number, problem: string | Remedy) {
    super(typeof problem === 'string' ? problem : formatRemedy(problem));
    this.name = 'AulaApiError';
    this.code = code;
    this.method = method;
  }
}

export class AulaAuthError extends Error {
  /** Always ends with the fix, because MitID is the only credential there is. */
  constructor(problem: string | Remedy, guidance: string = loginInstructions()) {
    super(typeof problem === 'string' ? `${problem}\n\n${guidance}` : formatRemedy(withLogin(problem)));
    this.name = 'AulaAuthError';
  }
}

/**
 * Every credential failure has the same fix, so it is filled in rather than
 * repeated at each throw site — but only when the caller has not named a more
 * specific one, since a Remedy that already carries commands has thought about
 * it harder than this default can.
 */
function withLogin(problem: Remedy): Remedy {
  if (problem.commands?.length) return problem;
  return { ...problem, action: problem.action ?? 'Log in again with MitID:', commands: ['bun run login'] };
}

export type QueryValue = string | number | boolean | Array<string | number>;

export class AulaClient {
  #auth: Auth;
  #cookie: string | undefined;
  #csrf: string | undefined;
  #version: number;
  /** Cookies Aula has set on us — the session lives here, not in `#cookie`. */
  #jar = new Map<string, string>();
  /**
   * The handshake, as promises rather than "have we started" booleans.
   *
   * These used to be `#versionVerified` / `#sessionReady`, set *before* their
   * awaits — so they meant "started", not "finished". Every read after the
   * first one in the same tick saw a true flag and went straight to the wire
   * against a session with no activated profile, which Aula answers with 403 +
   * status code 10 (and, for the calendar POST, `Invalid CSRF Token`, because
   * the jar had no `Csrfp-Token` yet). `buildDigest` fans out six reads at
   * once, so the flagship command failed whenever the profile calls came from
   * cache and the handshake therefore had not already happened. Memoising the
   * promise makes every concurrent caller await the *same* handshake.
   *
   * They are cleared on failure: a bootstrap that threw must not be sticky for
   * the life of the process.
   */
  #versionProbe: Promise<void> | undefined;
  #sessionBootstrap: Promise<void> | undefined;
  /** Memoised answer to "is Aula up?" — see `#serviceReachable`. */
  #healthProbe: Promise<boolean | undefined> | undefined;
  #cache: ResponseCache;

  /**
   * `cookie` is a test seam: the transport tests construct a client from a
   * bare cookie to model an already-bootstrapped session. The CLI itself only
   * ever arrives here through `AulaClient.create()`, with MitID tokens.
   *
   * Caching is opt-in rather than opt-out: a bare `new AulaClient(...)` never
   * touches the disk, so a test cannot accidentally assert against a response
   * an earlier test left lying around.
   */
  constructor(opts: { cookie?: string; auth?: Auth; apiVersion?: number; cache?: ResponseCache } = {}) {
    const auth: Auth | undefined = opts.auth ??
      (opts.cookie !== undefined ? { kind: 'cookie', cookie: opts.cookie } : undefined);
    if (!auth) {
      throw new Error('AulaClient needs credentials — use AulaClient.create().');
    }
    this.#auth = auth;
    this.#cookie = this.#auth.cookie;
    this.#csrf = this.#cookie ? readCookieValue(this.#cookie, 'Csrfp-Token') : undefined;
    const version = opts.apiVersion ?? defaultApiVersion();
    if (!Number.isInteger(version) || version < 1 || version > 99) {
      throw new Error(`apiVersion must be an integer from 1 to 99 (got "${version}").`);
    }
    this.#version = version;
    this.#cache = opts.cache ?? ResponseCache.disabled();
  }

  /** Builds a client from the stored MitID login — the only credential there is. */
  static async create(opts: { apiVersion?: number; cache?: CacheSettings } = {}): Promise<AulaClient> {
    const auth = await resolveAuth();
    return new AulaClient({
      ...opts,
      auth,
      cache: openCache({ ...opts.cache, scope: cacheScope(auth) }),
    });
  }

  get apiVersion(): number {
    return this.#version;
  }

  /**
   * Shared with the vendor integrations, so a weekly plan and an Aula response
   * expire together and belong to the same login.
   */
  get cache(): ResponseCache {
    return this.#cache;
  }

  /**
   * The MitID username, off the stored login record.
   *
   * Meebook and Systematic key their session on this rather than on any id Aula
   * exposes. The login records it, so nothing needs configuring by hand.
   */
  get mitidUsername(): string | undefined {
    return this.#auth.kind === 'token' ? this.#auth.username : undefined;
  }

  // ---------------------------------------------------------------- transport

  async #request(
    method: string,
    opts: {
      query?: Record<string, QueryValue | undefined>;
      body?: unknown;
      allowAnyGetter?: boolean;
    } = {},
  ): Promise<unknown> {
    const httpMethod = opts.body !== undefined ? 'POST' : 'GET';
    assertReadOnly(method, httpMethod, { allowAnyGetter: opts.allowAnyGetter ?? false });

    // Checked before the version probe and the session bootstrap, so a run that
    // hits cache throughout costs nothing at all. Both of those go straight to
    // `#send`, so the first genuine miss still performs the handshake.
    const cacheable = !NEVER_CACHED.has(method);
    const cacheKey = { query: opts.query ?? null, body: opts.body ?? null };
    if (cacheable) {
      const hit = this.#cache.get<unknown>(method, cacheKey);
      if (hit !== undefined) return hit;
    }

    // Awaited in this order on every cache miss, and both are memoised, so a
    // fan-out of concurrent reads performs one handshake and all of them wait
    // for it rather than racing past it.
    await this.#ensureApiVersion();
    await this.#ensureSession(method);
    const data = await this.#send(method, httpMethod, opts, this.#version);
    // Only successful responses reach this line — `#send` throws otherwise — so
    // a transient 403 is never pinned for the length of the TTL.
    if (cacheable) this.#cache.set(method, cacheKey, data);
    return data;
  }

  /**
   * Trade the OAuth token for a usable Aula session.
   *
   * The token on its own only gets you the two profile endpoints. Everything
   * else — messages, posts, presence, groups — answers `403` with status code
   * `10` until `getProfileContext` has run and *activated* a profile inside the
   * PHP session that `getProfilesByLogin` minted. The endpoints are not gated
   * on the token at all; they are gated on that session.
   *
   * Cookie auth arrives with an already-activated session, so this is skipped.
   */
  #ensureSession(method: string): Promise<void> {
    if (this.#auth.kind !== 'token') return Promise.resolve();
    // Both bootstrap methods work without an active profile, so exempting them
    // avoids recursing and avoids issuing the same call twice.
    if (method === 'profiles.getProfileContext' || method === 'profiles.getProfilesByLogin') {
      return Promise.resolve();
    }

    this.#sessionBootstrap ??= this
      // The version probe already called getProfilesByLogin, which seeded the
      // jar with PHPSESSID; this is the step that makes the session usable.
      .#send('profiles.getProfileContext', 'GET', {
        query: { portalrole: 'guardian' },
      }, this.#version)
      .then(() => undefined)
      .catch((err: unknown) => {
        this.#sessionBootstrap = undefined;
        throw err;
      });
    return this.#sessionBootstrap;
  }

  /** Merges a response's Set-Cookie into the jar; newest value wins. */
  #storeCookies(res: Response): void {
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const pair = entry.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.#jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    // Aula rotates the CSRF token with the session, and the calendar POST is
    // rejected outright if we send a stale one.
    const csrf = this.#jar.get('Csrfp-Token');
    if (csrf) this.#csrf = csrf;
  }

  /** The pasted cookie (if any) plus anything the server has since set. */
  #cookieHeader(): string | undefined {
    const merged = new Map<string, string>();
    for (const part of this.#cookie?.split(';') ?? []) {
      const eq = part.indexOf('=');
      if (eq > 0) merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    for (const [name, value] of this.#jar) merged.set(name, value);
    if (merged.size === 0) return undefined;
    return [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async #send(
    method: string,
    httpMethod: 'GET' | 'POST',
    opts: { query?: Record<string, QueryValue | undefined>; body?: unknown },
    version: number,
  ): Promise<unknown> {
    const url = new URL(`${BASE}/v${version}/`);
    url.searchParams.set('method', method);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // Aula expects PHP-style repeated keys: `childIds[]=1&childIds[]=2`.
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    // Aula does not accept a Bearer header — the OAuth access token rides along
    // as a query parameter instead.
    if (this.#auth.kind === 'token') {
      url.searchParams.set('access_token', this.#auth.accessToken);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    // Sent in both modes: on token auth this carries the session the token was
    // exchanged for, which is what actually authorises the module endpoints.
    const cookie = this.#cookieHeader();
    if (cookie) headers['Cookie'] = cookie;
    if (httpMethod === 'POST') {
      headers['Content-Type'] = 'application/json';
      if (this.#csrf) headers['Csrfp-Token'] = this.#csrf;
    }

    const res = await fetch(url, {
      method: httpMethod,
      headers,
      body: httpMethod === 'POST' ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
    });
    this.#storeCookies(res);

    // An expired session redirects to the MitID login flow instead of answering.
    if (res.status >= 300 && res.status < 400) {
      throw new AulaAuthError({
        headline: 'Your Aula login has expired.',
        detail: `Aula answered ${method} with a redirect to the MitID login page instead of data.`,
      });
    }

    const raw = await res.text();

    // Checked before the envelope, because on a 5xx the envelope lies: Aula
    // reports an access token it will not accept as HTTP 500 carrying a
    // *status code 0* — "success" — envelope. Reading the envelope first
    // therefore turns a dead login into a shape error three layers downstream,
    // which is exactly the confusion this branch exists to prevent.
    if (res.status >= 500) throw await this.#serverError(method, res.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (/<html/i.test(raw)) {
        throw new AulaAuthError({
          headline: 'Your Aula login has expired.',
          detail: `Aula returned its login page instead of data for ${method}.`,
        });
      }
      throw new AulaApiError(method, res.status, {
        headline: 'Aula sent a response aula-cli could not read.',
        detail:
          `${method} answered with HTTP ${res.status} and a body that is not JSON. ` +
          `It starts: ${raw.slice(0, 200)}`,
        fallback: 'If this keeps happening, Aula has changed something and aula-cli needs updating.',
      });
    }
    const envelope = parseEnvelope(method, parsed);

    // Aula answers HTTP 403 for both "your session is dead" and "you may not
    // read that", and only the envelope code tells them apart. Trusting the
    // HTTP status alone makes every id mistake look like a login problem.
    const code = envelope.status?.code ?? -1;
    if (code === 0) return envelope.data;

    if (code === STATUS_NOT_AUTHENTICATED || code === 401) {
      throw new AulaAuthError({
        headline: 'Aula rejected the credentials.',
        detail:
          `${method} came back with status code ${code} — not authenticated. ` +
          `The stored MitID login is no longer valid.`,
      });
    }
    if (code === STATUS_FORBIDDEN) {
      throw new AulaApiError(method, code, {
        headline: `Aula would not let you read ${method} (code 403).`,
        detail:
          `The session itself is fine, so this is almost always the wrong ` +
          `institution-profile id set. calendar and presence accept children ids ` +
          `only; posts needs guardian ids *and* children ids.`,
        action: 'Check which ids this login actually has:',
        commands: ['bun run aula whoami'],
        fallback: 'API.md, "The three id spaces", explains which id belongs where.',
      });
    }
    if (code === STATUS_BAD_PARAMETERS) {
      throw new AulaApiError(method, code, {
        headline: `Aula rejected the parameters for ${method} (code 40).`,
        detail:
          'Aula does not say which parameter was at fault. A date range that is too ' +
          'wide, or an id that belongs to a different id space, are the usual causes.',
      });
    }
    throw new AulaApiError(method, code, {
      headline: `Aula rejected ${method} with status code ${code}.`,
      ...(envelope.status?.message ? { detail: `Aula said: ${envelope.status.message}` } : {}),
      action: 'See which endpoints are working:',
      commands: ['bun run aula doctor --text'],
    });
  }

  /**
   * Turns a 5xx into something the reader can act on.
   *
   * Aula reports an access token it will not accept as HTTP 500 with the body
   * `{"status":{"code":0,"message":"intern fejl"},"data":"intern fejl"}` — the
   * same response it gives when the service itself is broken. Nothing in that
   * body separates "your login is dead" from "Aula is down", and the two need
   * opposite reactions: one is a two-minute MitID login, the other is waiting.
   *
   * They are still separable, just not by reading. While Aula is healthy an
   * *unauthenticated* request is answered cleanly (403, status code 448); while
   * it is not, that request 5xxes like everything else. So one credential-free
   * request settles it, and the message can name the cause instead of listing
   * both and leaving the reader to guess.
   */
  async #serverError(method: string, status: number): Promise<Error> {
    switch (await this.#serviceReachable()) {
      case true:
        return new AulaAuthError({
          headline: 'Aula rejected your login.',
          detail:
            `Aula answered ${method} with HTTP ${status}, but answered a ` +
            `credential-free request quite normally — so Aula is up, and it is the ` +
            `stored MitID login it will not accept. (Aula reports a token it rejects ` +
            `as a server error rather than as an authentication failure, which is why ` +
            `this does not read like a login problem.)`,
        });
      case false:
        return new AulaApiError(method, status, {
          headline: 'Aula is having trouble at the moment.',
          detail:
            `Aula answered ${method} with HTTP ${status}, and answered a request ` +
            `carrying no credentials the same way — so this is Aula's problem, not ` +
            `your login. Nothing here will fix it.`,
          fallback: 'Wait a few minutes and try again; aula.dk in a browser will show the same.',
        });
      default:
        return new AulaApiError(method, status, {
          headline: `Aula answered ${method} with HTTP ${status}.`,
          detail:
            'Aula could not be reached a second time to tell whether the service is ' +
            'down or your login has been rejected, so this may be either — or simply ' +
            'no network. Aula reports both as a server error.',
          action: 'Try, in order:',
          commands: ['bun run aula doctor --text', 'bun run login'],
        });
    }
  }

  /**
   * Is Aula answering at all, credentials aside? Memoised: a fan-out of six
   * reads that all fail should ask once, not six times, and the answer cannot
   * meaningfully change inside one command.
   *
   * `undefined` means the probe itself could not complete — no network, or a
   * timeout — which is a third answer, not a failure to get one.
   */
  #serviceReachable(): Promise<boolean | undefined> {
    this.#healthProbe ??= probeServiceReachable(this.#version);
    return this.#healthProbe;
  }

  /**
   * Aula retires API versions without warning; a retired version answers every
   * call with status code 10. When that happens we scan for the live version so
   * the tool keeps working instead of failing on a hardcoded constant.
   */
  #ensureApiVersion(): Promise<void> {
    this.#versionProbe ??= this.#probeApiVersion().catch((err: unknown) => {
      this.#versionProbe = undefined;
      throw err;
    });
    return this.#versionProbe;
  }

  /**
   * The probe itself. Separate from the memo so the memo stays readable, and so
   * this reads as the one place that decides `#version`.
   *
   * It doubles as the first half of the session handshake: the
   * `getProfilesByLogin` below is what mints `PHPSESSID` and `Csrfp-Token`, and
   * `#ensureSession` activates a profile inside the session it seeded. That
   * ordering is why `#request` awaits this one first.
   */
  async #probeApiVersion(): Promise<void> {
    try {
      await this.#send('profiles.getProfilesByLogin', 'GET', {}, this.#version);
      return;
    } catch (err) {
      if (err instanceof AulaAuthError) throw err;
      if (!(err instanceof AulaApiError) || err.code !== STATUS_RETIRED_VERSION) throw err;
    }

    for (let candidate = MAX_API_VERSION_TO_PROBE; candidate >= 15; candidate--) {
      if (candidate === this.#version) continue;
      try {
        await this.#send('profiles.getProfilesByLogin', 'GET', {}, candidate);
        process.emitWarning(
          `Aula API v${this.#version} is retired; using v${candidate}. ` +
            `Set AULA_API_VERSION=${candidate} to skip this probe.`,
        );
        this.#version = candidate;
        return;
      } catch (err) {
        if (err instanceof AulaAuthError) throw err;
        continue;
      }
    }
    throw new AulaApiError('profiles.getProfilesByLogin', STATUS_RETIRED_VERSION, {
      headline: 'Aula has retired every API version aula-cli knows about.',
      detail:
        `Versions ${MAX_API_VERSION_TO_PROBE} down to 15 all answered "retired". ` +
        `Aula has moved further than this client expects, so aula-cli needs updating.`,
      action: 'If you know the live version, point this run at it:',
      commands: ['AULA_API_VERSION=<version> bun run aula whoami'],
    });
  }

  // ---------------------------------------------------------------- endpoints

  async getProfiles(): Promise<Profile[]> {
    const method = 'profiles.getProfilesByLogin';
    const data = expectObject<{ profiles?: unknown }>(method, await this.#request(method));
    return expectArray<Profile>(method, data.profiles);
  }

  async getProfileContext(portalRole = 'guardian'): Promise<ProfileContext> {
    const method = 'profiles.getProfileContext';
    return expectObject<ProfileContext>(method, await this.#request(method, {
      query: { portalrole: portalRole },
    }));
  }

  async getThreads(page = 0): Promise<ThreadList> {
    const method = 'messaging.getThreads';
    return expectObject<ThreadList>(method, await this.#request(method, {
      query: { sortOn: 'date', orderDirection: 'desc', page },
    }));
  }

  async getThread(threadId: number, page = 0): Promise<ThreadDetail> {
    const method = 'messaging.getMessagesForThread';
    return expectObject<ThreadDetail>(method, await this.#request(method, {
      query: { threadId, page },
    }));
  }

  /**
   * @param institutionProfileIds guardian institution-profile ids **plus** each
   *   child's institution-profile id. Omitting the children silently returns an
   *   empty list rather than an error.
   */
  async getPosts(opts: {
    institutionProfileIds: number[];
    index?: number;
    limit?: number;
    isImportant?: boolean;
    isUnread?: boolean;
    isBookmarked?: boolean;
  }): Promise<PostList> {
    const method = 'posts.getAllPosts';
    return expectObject<PostList>(method, await this.#request(method, {
      query: {
        parent: 'profile',
        index: opts.index ?? 0,
        limit: opts.limit ?? 10,
        isImportant: opts.isImportant ?? false,
        isUnread: opts.isUnread ?? false,
        ownPost: false,
        isBookmarked: opts.isBookmarked ?? false,
        institutionProfileIds: opts.institutionProfileIds,
      },
    }));
  }

  /**
   * Photo albums, newest media first.
   *
   * @param childInstitutionProfileIds children only. The guardian's own ids are
   *   accepted but change nothing, and *omitting the filter entirely* is the
   *   trap: rather than erroring, Aula falls back to some other scope and
   *   returns a short list of albums from institutions the family has since
   *   left — 29 stale ones here versus 95 real ones. A successful-looking,
   *   quietly wrong answer, so the filter is required rather than optional.
   *
   * `sortOn` has exactly one useful value, `mediaCreatedAt`, and it names a
   * field the response does not contain — so the order cannot be verified or
   * reproduced from the payload. Callers that care about dates should sort on
   * `creationDate` themselves.
   */
  async getAlbums(opts: {
    childInstitutionProfileIds: number[];
    index?: number;
    limit?: number;
  }): Promise<Album[]> {
    if (opts.childInstitutionProfileIds.length === 0) return [];
    const method = 'gallery.getAlbums';
    const data = await this.#request(method, {
      query: {
        index: opts.index ?? 0,
        limit: opts.limit ?? 50,
        sortOn: 'mediaCreatedAt',
        orderDirection: 'desc',
        filterBy: 'all',
        filterInstProfileIds: opts.childInstitutionProfileIds,
      },
    });
    return expectArray<Album>(method, data);
  }

  /**
   * @param childInstitutionProfileIds children only. Including the guardian's
   *   own institution-profile ids makes Aula answer 403.
   */
  async getCalendarEvents(opts: {
    childInstitutionProfileIds: number[];
    start: Date;
    end: Date;
  }): Promise<CalendarEvent[]> {
    // Aula caps the window server-side and rejects anything longer with a bare
    // 403 — the same status it uses for a wrong id set, and with no hint which
    // it meant. Measured against the live API: 50 days passes, 51 does not.
    // Catching it here turns a misleading "wrong ids" message into the truth.
    const spanDays = (opts.end.getTime() - opts.start.getTime()) / 86_400_000;
    if (spanDays > CALENDAR_MAX_SPAN_DAYS) {
      throw new AulaApiError(
        'calendar.getEventsByProfileIdsAndResourceIds',
        STATUS_FORBIDDEN,
        `Aula refuses calendar windows longer than ${CALENDAR_MAX_SPAN_DAYS} days ` +
          `(asked for ${Math.round(spanDays)}). Narrow --days, or make several calls.`,
      );
    }
    const method = 'calendar.getEventsByProfileIdsAndResourceIds';
    const data = await this.#request(method, {
      body: {
        instProfileIds: opts.childInstitutionProfileIds,
        resourceIds: [],
        start: formatAulaDate(opts.start),
        end: formatAulaDate(opts.end),
      },
    });
    return expectArray<CalendarEvent>(method, data);
  }

  async getDailyPresence(childInstitutionProfileIds: number[]): Promise<PresenceEntry[]> {
    if (childInstitutionProfileIds.length === 0) return [];
    const method = 'presence.getDailyOverview';
    const data = await this.#request(method, {
      query: { childIds: childInstitutionProfileIds },
    });
    return expectArray<PresenceEntry>(method, data);
  }

  /**
   * The recurring komme/gå schedule, as opposed to `getDailyPresence`, which
   * is today's actual check-in/check-out.
   *
   * Note the parameter name: this endpoint calls the child ids
   * `filterInstitutionProfileIds[]`, not `childIds[]`. Same ids, different
   * spelling — it wants children only, like the rest of the presence module.
   */
  async getPresenceTemplates(opts: {
    childInstitutionProfileIds: number[];
    /** `YYYY-MM-DD`. */
    fromDate: string;
    /** `YYYY-MM-DD`, inclusive. */
    toDate: string;
  }): Promise<PresenceTemplates> {
    if (opts.childInstitutionProfileIds.length === 0) return {};
    const method = 'presence.getPresenceTemplates';
    const data = await this.#request(method, {
      query: {
        filterInstitutionProfileIds: opts.childInstitutionProfileIds,
        fromDate: opts.fromDate,
        toDate: opts.toDate,
      },
    });
    return expectObject<PresenceTemplates>(method, data);
  }

  /**
   * The groups each child belongs to — class, subject teams, year group.
   * Needed to get a group id for {@link getContactList}.
   */
  async getGroupsByContext(childInstitutionProfileIds: number[]): Promise<GroupContext[]> {
    if (childInstitutionProfileIds.length === 0) return [];
    const method = 'groups.getGroupsByContext';
    const data = await this.#request(method, {
      query: { childInstitutionProfileIds },
    });
    return expectArray<GroupContext>(method, data);
  }

  /**
   * The contact list for one group ("kontaktliste") — classmates and their
   * guardians, with whatever contact details each family chose to share.
   * Birthdays live here and nowhere else.
   *
   * Paginated, and 1-based rather than 0-based like the rest of the API.
   */
  async getContactList(opts: {
    groupId: number;
    /** `child` (the default) restricts to pupils; `guardian` / `employee` also work. */
    filter?: string;
    page?: number;
  }): Promise<Contact[]> {
    const method = 'profiles.getContactlist';
    const data = await this.#request(method, {
      query: {
        groupId: opts.groupId,
        filter: opts.filter ?? 'child',
        field: 'name',
        order: 'asc',
        page: opts.page ?? 1,
      },
    });
    return expectArray<Contact>(method, data);
  }

  /**
   * A short-lived bearer token scoped to one third-party widget. This is the
   * hinge the whole ugeplan/lektier world hangs off: Aula issues the token,
   * the vendor's own API accepts it. See src/widgets.ts.
   */
  async getWidgetToken(widgetId: string): Promise<string> {
    const method = 'aulaToken.getAulaToken';
    const data = await this.#request(method, {
      query: { widgetId },
    });
    if (typeof data !== 'string' || !data) {
      throw new AulaApiError(method, -1, `No token issued for widget ${widgetId}.`);
    }
    return data;
  }

  async getNotifications(): Promise<Notification[]> {
    const method = 'notifications.getNotificationsForActiveProfile';
    return expectArray<Notification>(method, await this.#request(method));
  }

  /**
   * "Fælles Filer" — the shared-file shelf, filtered by institution *code*
   * rather than by any of the profile ids.
   *
   * `orderField` is mandatory and the accepted set is narrow: `title` works,
   * and the obvious guesses (`created`, `name`, `fileName`) are all rejected
   * with status 40. Omitting it, or `orderDirection`, fails the same way — with
   * no indication of which parameter was at fault.
   */
  async getCommonFiles(opts: {
    institutionCodes: string[];
    index?: number;
    limit?: number;
    orderField?: 'title';
    orderDirection?: 'asc' | 'desc';
  }): Promise<CommonFileList> {
    const method = 'commonFiles.getCommonFiles';
    const data = await this.#request(method, {
      query: {
        index: opts.index ?? 0,
        limit: opts.limit ?? COMMON_FILES_PAGE_SIZE,
        institutionCodes: opts.institutionCodes,
        orderField: opts.orderField ?? 'title',
        orderDirection: opts.orderDirection ?? 'desc',
      },
    });
    return expectObject<CommonFileList>(method, data);
  }

  /**
   * Escape hatch for read endpoints that have no typed wrapper here. Still
   * refuses anything that is not named like a getter, and still GET-only —
   * see {@link assertReadOnly}.
   */
  async getRaw(
    method: string,
    query: Record<string, QueryValue | undefined> = {},
  ): Promise<unknown> {
    return this.#request(method, { query, allowAnyGetter: true });
  }
}

type ParsedEnvelope = {
  status: { code: number; message?: string };
  data: unknown;
};

function parseEnvelope(method: string, value: unknown): ParsedEnvelope {
  if (!isRecord(value) || !isRecord(value.status) || typeof value.status.code !== 'number') {
    throw new AulaApiError(method, -1, {
      headline: 'Aula sent a response aula-cli could not read.',
      detail:
        `${method} answered with JSON, but not with the {"status": {"code": …}, ` +
        `"data": …} envelope every Aula endpoint normally replies with.`,
      ...unexpectedPayloadAdvice(method),
    });
  }
  const message = typeof value.status.message === 'string' ? value.status.message : undefined;
  return {
    status: { code: value.status.code, ...(message ? { message } : {}) },
    data: value.data,
  };
}

/**
 * The wire payload is outside TypeScript's trust boundary. These two helpers
 * keep the unavoidable assertions in one place and at least prove the top-level
 * collection shape before endpoint code can use it.
 *
 * Reaching one of these means Aula called the request a success and then sent
 * something else, so the message says what arrived instead — "a string
 * (\"intern fejl\")" is a diagnosis, where "malformed payload" is a shrug.
 */
function expectObject<T extends object>(method: string, value: unknown): T {
  if (!isRecord(value)) throw payloadError(method, 'an object', value);
  return value as T;
}

function expectArray<T>(method: string, value: unknown): T[] {
  if (!Array.isArray(value)) throw payloadError(method, 'a list', value);
  return value as T[];
}

function payloadError(method: string, expected: string, value: unknown): AulaApiError {
  return new AulaApiError(method, -1, {
    headline: 'Aula returned data that aula-cli does not understand.',
    detail:
      `${method} should answer with ${expected}, but Aula sent ${describeValue(value)}. ` +
      `Aula reported the call as successful, so this is a change in what Aula sends ` +
      `rather than something wrong with the request.`,
    ...unexpectedPayloadAdvice(method),
  });
}

/** The same two lines wherever Aula's shape is the problem rather than the call. */
function unexpectedPayloadAdvice(method: string): Pick<Remedy, 'action' | 'commands' | 'fallback'> {
  return {
    action: 'See exactly what Aula sent:',
    commands: [`bun run aula raw ${method} --no-cache`],
    fallback:
      'If what that prints looks nothing like it used to, Aula has changed their ' +
      'API and aula-cli needs updating.',
  };
}

/** Enough of an unexpected value to recognise it, and never more than a line. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing at all';
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === 'string') {
    const preview = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return `a string ("${preview}")`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} (${value})`;
  return `a ${typeof value}`;
}

/**
 * Ask Aula whether it is answering, deliberately without credentials.
 *
 * Sends no cookie and no access token, which is the whole point: a healthy
 * Aula turns that into a clean "not authenticated" (HTTP 403), and an unwell
 * one 5xxes regardless. Anything below 500 therefore means the service is up.
 */
async function probeServiceReachable(version: number): Promise<boolean | undefined> {
  const url = new URL(`${BASE}/v${version}/`);
  url.searchParams.set('method', 'profiles.getProfilesByLogin');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return undefined;
  }
}

function defaultApiVersion(): number {
  const raw = process.env.AULA_API_VERSION;
  if (raw === undefined) return FALLBACK_API_VERSION;
  const version = parseInteger(raw, { min: 1, max: 99 });
  if (version === undefined) {
    throw new Error(`AULA_API_VERSION must be an integer from 1 to 99 (got "${raw}").`);
  }
  return version;
}

/**
 * Which login a cached response belongs to.
 *
 * The cookie is hashed rather than stored: it is a live credential, and a cache
 * key ends up in a filename-ish position where it would be far too easy to
 * print. The MitID username is not a secret and reads better in `cache status`.
 */
function cacheScope(auth: Auth): string {
  if (auth.kind === 'token') return `token:${auth.username}`;
  return `cookie:${createHash('sha256').update(auth.cookie).digest('hex').slice(0, 16)}`;
}

/** Pulls one value out of a `k=v; k=v` cookie string (the CSRF token, in practice). */
function readCookieValue(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Aula's calendar filter wants `YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ`, not ISO-8601. */
export function formatAulaDate(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.0000` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}
