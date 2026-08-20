import { createHash } from 'node:crypto';
import { type Auth, loginInstructions, resolveAuth } from './auth.ts';
import { type CacheSettings, ResponseCache, openCache } from './cache.ts';
import type {
  Album,
  AulaEnvelope,
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

const DEFAULT_API_VERSION = Number(process.env.AULA_API_VERSION ?? 24);
const BASE = 'https://www.aula.dk/api';

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

export class AulaApiError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(method: string, code: number, message: string) {
    super(message);
    this.name = 'AulaApiError';
    this.code = code;
    this.method = method;
  }
}

export class AulaAuthError extends Error {
  /** Always ends with the fix, because MitID is the only credential there is. */
  constructor(message: string, guidance: string = loginInstructions()) {
    super(`${message}\n\n${guidance}`);
    this.name = 'AulaAuthError';
  }
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
    if (!opts.auth && opts.cookie === undefined) {
      throw new Error('AulaClient needs credentials — use AulaClient.create().');
    }
    this.#auth = opts.auth ?? { kind: 'cookie', cookie: opts.cookie as string };
    this.#cookie = this.#auth.cookie;
    this.#csrf = this.#cookie ? readCookieValue(this.#cookie, 'Csrfp-Token') : undefined;
    this.#version = opts.apiVersion ?? DEFAULT_API_VERSION;
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

  #authGuidance(): string {
    return loginInstructions();
  }

  // ---------------------------------------------------------------- transport

  async #request<T>(
    method: string,
    opts: {
      query?: Record<string, QueryValue | undefined>;
      body?: unknown;
      allowAnyGetter?: boolean;
    } = {},
  ): Promise<T> {
    const httpMethod = opts.body !== undefined ? 'POST' : 'GET';
    assertReadOnly(method, httpMethod, { allowAnyGetter: opts.allowAnyGetter ?? false });

    // Checked before the version probe and the session bootstrap, so a run that
    // hits cache throughout costs nothing at all. Both of those go straight to
    // `#send`, so the first genuine miss still performs the handshake.
    const cacheable = !NEVER_CACHED.has(method);
    const cacheKey = { query: opts.query ?? null, body: opts.body ?? null };
    if (cacheable) {
      const hit = this.#cache.get<T>(method, cacheKey);
      if (hit !== undefined) return hit;
    }

    // Awaited in this order on every cache miss, and both are memoised, so a
    // fan-out of concurrent reads performs one handshake and all of them wait
    // for it rather than racing past it.
    await this.#ensureApiVersion();
    await this.#ensureSession(method);
    const data = await this.#send<T>(method, httpMethod, opts, this.#version);
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

  async #send<T>(
    method: string,
    httpMethod: 'GET' | 'POST',
    opts: { query?: Record<string, QueryValue | undefined>; body?: unknown },
    version: number,
  ): Promise<T> {
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
      'User-Agent': 'aula-cli/0.1 (+personal read-only client)',
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
      throw new AulaAuthError(
        'Aula redirected to login — the credentials have expired.',
        this.#authGuidance(),
      );
    }

    const raw = await res.text();
    let envelope: AulaEnvelope<T>;
    try {
      envelope = JSON.parse(raw) as AulaEnvelope<T>;
    } catch {
      if (/<html/i.test(raw)) {
        throw new AulaAuthError(
          'Aula returned an HTML page instead of JSON — the credentials have expired.',
          this.#authGuidance(),
        );
      }
      throw new AulaApiError(method, res.status, `Non-JSON response: ${raw.slice(0, 300)}`);
    }

    // Aula answers HTTP 403 for both "your session is dead" and "you may not
    // read that", and only the envelope code tells them apart. Trusting the
    // HTTP status alone makes every id mistake look like a login problem.
    const code = envelope.status?.code ?? -1;
    if (code === 0) return envelope.data as T;

    if (code === STATUS_NOT_AUTHENTICATED || code === 401) {
      throw new AulaAuthError(
        `Aula rejected the credentials (status code ${code}).`,
        this.#authGuidance(),
      );
    }
    if (code === STATUS_FORBIDDEN) {
      throw new AulaApiError(
        method,
        code,
        `Access denied by Aula (code 403). The session is still valid — this is ` +
          `almost always the wrong institution-profile id set. calendar and presence ` +
          `accept children ids only; posts needs guardian ids *and* children ids. ` +
          `See API.md "The three id spaces".`,
      );
    }
    if (code === STATUS_BAD_PARAMETERS) {
      throw new AulaApiError(method, code, `Aula rejected the parameters for ${method} (code 40).`);
    }
    throw new AulaApiError(
      method,
      code,
      `Aula rejected ${method} with status code ${code}${
        envelope.status?.message ? ` (${envelope.status.message})` : ''
      }.`,
    );
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

    for (let candidate = DEFAULT_API_VERSION + 12; candidate >= 15; candidate--) {
      if (candidate === this.#version) continue;
      try {
        await this.#send('profiles.getProfilesByLogin', 'GET', {}, candidate);
        process.emitWarning(
          `Aula API v${this.#version} is retired; using v${candidate}. ` +
            `Set AULA_API_VERSION=${candidate} (or update DEFAULT_API_VERSION) to skip this probe.`,
        );
        this.#version = candidate;
        return;
      } catch (err) {
        if (err instanceof AulaAuthError) throw err;
        continue;
      }
    }
    throw new AulaApiError(
      'profiles.getProfilesByLogin',
      STATUS_RETIRED_VERSION,
      'Could not find a live Aula API version.',
    );
  }

  // ---------------------------------------------------------------- endpoints

  async getProfiles(): Promise<Profile[]> {
    const data = await this.#request<{ profiles: Profile[] }>('profiles.getProfilesByLogin');
    return data.profiles ?? [];
  }

  async getProfileContext(portalRole = 'guardian'): Promise<ProfileContext> {
    return this.#request<ProfileContext>('profiles.getProfileContext', {
      query: { portalrole: portalRole },
    });
  }

  async getThreads(page = 0): Promise<ThreadList> {
    return this.#request<ThreadList>('messaging.getThreads', {
      query: { sortOn: 'date', orderDirection: 'desc', page },
    });
  }

  async getThread(threadId: number, page = 0): Promise<ThreadDetail> {
    return this.#request<ThreadDetail>('messaging.getMessagesForThread', {
      query: { threadId, page },
    });
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
    return this.#request<PostList>('posts.getAllPosts', {
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
    });
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
    const data = await this.#request<Album[]>('gallery.getAlbums', {
      query: {
        index: opts.index ?? 0,
        limit: opts.limit ?? 50,
        sortOn: 'mediaCreatedAt',
        orderDirection: 'desc',
        filterBy: 'all',
        filterInstProfileIds: opts.childInstitutionProfileIds,
      },
    });
    return data ?? [];
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
    const data = await this.#request<CalendarEvent[]>('calendar.getEventsByProfileIdsAndResourceIds', {
      body: {
        instProfileIds: opts.childInstitutionProfileIds,
        resourceIds: [],
        start: formatAulaDate(opts.start),
        end: formatAulaDate(opts.end),
      },
    });
    return data ?? [];
  }

  async getDailyPresence(childInstitutionProfileIds: number[]): Promise<PresenceEntry[]> {
    if (childInstitutionProfileIds.length === 0) return [];
    const data = await this.#request<PresenceEntry[]>('presence.getDailyOverview', {
      query: { childIds: childInstitutionProfileIds },
    });
    return data ?? [];
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
    const data = await this.#request<PresenceTemplates>('presence.getPresenceTemplates', {
      query: {
        filterInstitutionProfileIds: opts.childInstitutionProfileIds,
        fromDate: opts.fromDate,
        toDate: opts.toDate,
      },
    });
    return data ?? {};
  }

  /**
   * The groups each child belongs to — class, subject teams, year group.
   * Needed to get a group id for {@link getContactList}.
   */
  async getGroupsByContext(childInstitutionProfileIds: number[]): Promise<GroupContext[]> {
    if (childInstitutionProfileIds.length === 0) return [];
    const data = await this.#request<GroupContext[]>('groups.getGroupsByContext', {
      query: { childInstitutionProfileIds },
    });
    return data ?? [];
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
    const data = await this.#request<Contact[]>('profiles.getContactlist', {
      query: {
        groupId: opts.groupId,
        filter: opts.filter ?? 'child',
        field: 'name',
        order: 'asc',
        page: opts.page ?? 1,
      },
    });
    return data ?? [];
  }

  /**
   * A short-lived bearer token scoped to one third-party widget. This is the
   * hinge the whole ugeplan/lektier world hangs off: Aula issues the token,
   * the vendor's own API accepts it. See src/widgets.ts.
   */
  async getWidgetToken(widgetId: string): Promise<string> {
    const data = await this.#request<string>('aulaToken.getAulaToken', {
      query: { widgetId },
    });
    if (!data) throw new AulaApiError('aulaToken.getAulaToken', -1, `No token issued for widget ${widgetId}.`);
    return data;
  }

  async getNotifications(): Promise<Notification[]> {
    const data = await this.#request<Notification[]>('notifications.getNotificationsForActiveProfile');
    return data ?? [];
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
    const data = await this.#request<CommonFileList>('commonFiles.getCommonFiles', {
      query: {
        index: opts.index ?? 0,
        limit: opts.limit ?? COMMON_FILES_PAGE_SIZE,
        institutionCodes: opts.institutionCodes,
        orderField: opts.orderField ?? 'title',
        orderDirection: opts.orderDirection ?? 'desc',
      },
    });
    return data ?? { commonFiles: [], totalAmount: 0 };
  }

  /**
   * Escape hatch for read endpoints that have no typed wrapper here. Still
   * refuses anything that is not named like a getter, and still GET-only —
   * see {@link assertReadOnly}.
   */
  async getRaw<T = unknown>(
    method: string,
    query: Record<string, QueryValue | undefined> = {},
  ): Promise<T> {
    return this.#request<T>(method, { query, allowAnyGetter: true });
  }
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
