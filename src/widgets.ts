/**
 * Aula's third-party widget layer.
 *
 * Aula itself carries messages, posts, calendar and presence. Everything a
 * school actually teaches with — weekly plans, homework, reminders — lives in
 * a product the municipality bought separately, embedded into the Aula page as
 * a "widget". So the interesting half of "what is happening at school" is not
 * in the Aula API at all.
 *
 * The bridge is `aulaToken.getAulaToken?widgetId=NNNN`: Aula mints a
 * short-lived JWT scoped to one widget, and the vendor's own API accepts it as
 * a bearer token. This module owns that token, and owns the policy for talking
 * to vendors at all.
 */

import type { AulaClient } from './client.ts';
import type { ProfileContext } from './types.ts';

// --------------------------------------------------------------- the registry

/** What a widget provides. Drives which command can serve a request. */
export type Capability = 'ugeplan' | 'ugebrev' | 'opgaver' | 'huskelisten' | 'lektier';

/** Which vendor integration handles a widget. */
export type Provider =
  | 'easyiq'
  | 'easyiq_skoleportal'
  | 'easyiq_lektier'
  | 'meebook'
  | 'minuddannelse'
  | 'systematic';

export type WidgetInfo = {
  /** Aula's own label, for output that a human has to recognise. */
  name: string;
  provider: Provider;
  capability: Capability;
  /**
   * This vendor keys its session on the MitID username rather than the Aula
   * guardian id. The dispatcher warns when only the fallback id is available —
   * see `integrations/index.ts` — so the flag lives here, on the registry,
   * where an adapter cannot forget it.
   */
  needsMitidUsername?: true;
};

/**
 * Widget id → provider. Ids are zero-padded four-digit strings and are stable
 * across institutions: `0004` is Meebook everywhere in Denmark.
 *
 * Sourced from scaarup/aula (`client.py`) and Casperjuel/aula-mcp
 * (`discover.ts`), which between them cover every provider either project
 * has seen in the wild.
 */
export const WIDGETS: Readonly<Record<string, WidgetInfo>> = Object.freeze({
  '0001': { name: 'EasyIQ Ugeplan', provider: 'easyiq', capability: 'ugeplan' },
  '0004': {
    name: 'Meebook Ugeplan',
    provider: 'meebook',
    capability: 'ugeplan',
    needsMitidUsername: true,
  },
  '0023': { name: 'MinUddannelse Opgaveliste', provider: 'minuddannelse', capability: 'opgaver' },
  '0029': { name: 'MinUddannelse Ugebrev', provider: 'minuddannelse', capability: 'ugebrev' },
  '0030': { name: 'MinUddannelse Opgaveliste', provider: 'minuddannelse', capability: 'opgaver' },
  '0062': {
    name: 'Huskelisten',
    provider: 'systematic',
    capability: 'huskelisten',
    needsMitidUsername: true,
  },
  '0128': {
    name: 'EasyIQ SkolePortal Ugeplan',
    provider: 'easyiq_skoleportal',
    capability: 'ugeplan',
    needsMitidUsername: true,
  },
  // Lektier deliberately lacks the flag: its `x-login` is the Aula guardian
  // id, not the MitID username — see getLektier in easyiq-skoleportal.ts.
  '0142': { name: 'EasyIQ Lektier', provider: 'easyiq_lektier', capability: 'lektier' },
});

export type DetectedWidget = { widgetId: string; name: string } & Partial<WidgetInfo>;

/**
 * Which widgets this family's institutions actually expose.
 *
 * Aula nests the id under `widget.widgetId`; some institutions still answer
 * with the older flat `widgetId`. Both are accepted, because a family with one
 * child at each shape gets a half-empty list otherwise.
 *
 * Unknown ids are returned too — a widget we have no integration for is still
 * worth showing, since it is the evidence for what to write next.
 */
export function detectWidgets(context: ProfileContext): DetectedWidget[] {
  const seen = new Map<string, DetectedWidget>();
  for (const config of context.pageConfiguration?.widgetConfigurations ?? []) {
    const widgetId = config.widget?.widgetId ?? config.widgetId;
    if (!widgetId) continue;
    if (seen.has(widgetId)) continue;
    const known = WIDGETS[widgetId];
    seen.set(widgetId, {
      widgetId,
      name: config.widget?.name ?? known?.name ?? `widget ${widgetId}`,
      ...(known ?? {}),
    });
  }
  return [...seen.values()].sort((a, b) => a.widgetId.localeCompare(b.widgetId));
}

// ------------------------------------------------------------- the guard

/**
 * Every vendor endpoint this project may touch, and the single HTTP method it
 * may be touched with. Same principle as `READ_ONLY_METHODS` in client.ts: the
 * transport refuses anything not listed, so a new call site cannot quietly
 * reach a write endpoint.
 *
 * Two entries are POST. Both are reads: EasyIQ's `weekplaninfo` takes its
 * child/institution filter as a JSON body, and SkolePortal's
 * `AuthenticateAulaUser` exchanges the Aula widget token for a vendor-side
 * login id. Neither changes anything the school can see.
 */
export const WIDGET_ENDPOINTS: Readonly<Record<string, 'GET' | 'POST'>> = Object.freeze({
  'https://api.minuddannelse.net/aula/opgaveliste': 'GET',
  'https://api.minuddannelse.net/aula/ugebrev': 'GET',
  'https://app.meebook.com/aulaapi/relatedweekplan/all': 'GET',
  'https://api.easyiqcloud.dk/api/aula/weekplaninfo': 'POST',
  'https://skoleportal.easyiqcloud.dk/Aula/AuthenticateAulaUser': 'POST',
  'https://skoleportal.easyiqcloud.dk/Aula/GetChildren': 'GET',
  'https://skoleportal.easyiqcloud.dk/Calendar/CalendarGetWeekplanEvents': 'GET',
  'https://skoleportal.easyiqcloud.dk/AulaHuskeliste/GetWeekplanEvents': 'GET',
  'https://systematic-momo.dk/api/aula/reminders/v1': 'GET',
});

export class WidgetError extends Error {
  readonly widgetId: string;
  readonly status: number | undefined;
  constructor(widgetId: string, message: string, status?: number) {
    super(message);
    this.name = 'WidgetError';
    this.widgetId = widgetId;
    if (status !== undefined) this.status = status;
  }
}

/** Throws unless `url`'s origin+path is an allowlisted vendor read. */
export function assertWidgetEndpoint(url: string, httpMethod: 'GET' | 'POST'): void {
  const parsed = new URL(url);
  const key = `${parsed.origin}${parsed.pathname}`;
  const allowed = WIDGET_ENDPOINTS[key];
  if (!allowed) {
    throw new WidgetError('-', `Refusing to call "${key}": not an allowlisted widget endpoint.`);
  }
  if (allowed !== httpMethod) {
    throw new WidgetError('-', `Refusing ${httpMethod} to "${key}" — it is allowlisted for ${allowed} only.`);
  }
}

// ------------------------------------------------------------------ the tokens

/**
 * Widget tokens are short-lived and the vendors do not agree on how they say
 * so — some answer 401, some answer HTTP 200 with `{"message":"JWT-Token
 * expired, please renew."}`. Treating only the status code as authoritative
 * leaves the caller staring at an empty week plan.
 */
const EXPIRY_SIGNALS: readonly RegExp[] = [
  /JWT[- ]Token expired/i,
  /token (has )?expired/i,
  /unauthorized/i,
];

export function looksExpired(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  if (!body) return false;
  return EXPIRY_SIGNALS.some((re) => re.test(body));
}

/** Refreshed well inside the real TTL; a token is cheap, a stale one is not. */
const TOKEN_TTL_MS = 60_000;

export class WidgetTokens {
  #client: AulaClient;
  #ttlMs: number;
  #cache = new Map<string, { token: string; expiresAt: number }>();
  #inFlight = new Map<string, Promise<string>>();

  constructor(client: AulaClient, opts: { ttlMs?: number } = {}) {
    this.#client = client;
    this.#ttlMs = opts.ttlMs ?? TOKEN_TTL_MS;
  }

  async get(widgetId: string): Promise<string> {
    const cached = this.#cache.get(widgetId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return this.refresh(widgetId);
  }

  /** Coalesced, so N children fetched in parallel cost one token request. */
  async refresh(widgetId: string): Promise<string> {
    const existing = this.#inFlight.get(widgetId);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const token = await this.#client.getWidgetToken(widgetId);
        this.#cache.set(widgetId, { token, expiresAt: Date.now() + this.#ttlMs });
        return token;
      } finally {
        this.#inFlight.delete(widgetId);
      }
    })();
    this.#inFlight.set(widgetId, pending);
    return pending;
  }

  invalidate(widgetId: string): void {
    this.#cache.delete(widgetId);
  }

  /**
   * Run a vendor call with the widget's token, retrying once with a fresh
   * token if the vendor says the old one expired. `fn` returns
   * {@link EXPIRED} rather than throwing, so an expiry stays distinguishable
   * from a genuine failure.
   */
  async withToken<T>(widgetId: string, fn: (token: string) => Promise<T | typeof EXPIRED>): Promise<T> {
    const first = await fn(await this.get(widgetId));
    if (first !== EXPIRED) return first;

    this.invalidate(widgetId);
    const second = await fn(await this.refresh(widgetId));
    if (second === EXPIRED) {
      throw new WidgetError(
        widgetId,
        `Widget ${widgetId} (${WIDGETS[widgetId]?.name ?? 'unknown'}) rejected a freshly ` +
          `issued token. The Aula session may not be stepped up, or the school may have ` +
          `revoked the widget.`,
      );
    }
    return second;
  }
}

/** Sentinel returned by a vendor call whose token was rejected as expired. */
export const EXPIRED = Symbol('widget-token-expired');

// ------------------------------------------------------------------ transport

export type WidgetRequest = {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON-serialisable; sets `content-type: application/json`. */
  body?: unknown;
  widgetId: string;
};

/**
 * The one way this project talks to a vendor. Checks the allowlist, then
 * returns either the parsed JSON or {@link EXPIRED} — never a raw Response, so
 * no call site can forget the expiry check.
 */
export async function widgetFetch<T>(req: WidgetRequest): Promise<T | typeof EXPIRED> {
  const method = req.method ?? 'GET';
  assertWidgetEndpoint(req.url, method);

  const headers = { ...req.headers };
  if (req.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(req.url, {
    method,
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();

  // SkolePortal answers a bad token with a 302 to its login page rather than
  // a 401, so a redirect has to count as an expiry signal too.
  if (res.status >= 300 && res.status < 400) return EXPIRED;
  if (looksExpired(res.status, text)) return EXPIRED;

  if (res.status !== 200) {
    throw new WidgetError(req.widgetId, `${new URL(req.url).host} answered HTTP ${res.status}${
      summariseBody(text) ? ` — ${summariseBody(text)}` : ''
    }`, res.status);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WidgetError(
      req.widgetId,
      `${new URL(req.url).host} returned non-JSON${
        summariseBody(text) ? ` — ${summariseBody(text)}` : ''
      }`,
      res.status,
    );
  }
}

/**
 * One readable line out of a vendor's error body.
 *
 * These messages are not debug output: they end up verbatim in `ugeplan`, in
 * the digest JSON the skill reads, and in the brief's datastatus panel. Slicing
 * the first 200 raw characters — which is what this used to do — put a doctype,
 * three meta tags and half a stylesheet in front of a parent trying to find out
 * why the weekly plan is missing. The vendors' error pages carry a `<title>`
 * that is usually the only informative part; failing that, the first line of
 * text is better than markup.
 */
function summariseBody(body: string): string {
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim();
  if (title) return title.replace(/\s+/g, ' ');
  const flat = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, 120);
}
