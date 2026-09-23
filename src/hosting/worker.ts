/**
 * The hosted copy of the brief: a Cloudflare Worker, and the one Durable Object
 * behind it that holds the page and what the family has ticked off.
 *
 * Deployed once by hand (`HOSTING.md`); never imported by the CLI, so none of
 * it is in the compiled binary. It lives in `src/` so Bun typechecks and tests
 * it like everything else, which is also why the slice of the Workers runtime
 * it touches is declared below instead of taken from
 * `@cloudflare/workers-types`: those replace Bun's globals for the whole
 * program they are loaded into.
 *
 * **Who may read is decided before this code runs.** Cloudflare Access sits in
 * front of the Worker's hostname — two parents' email addresses, and the
 * service token the CLI uploads with — and `ctx.access` exists only on a
 * request Access has already authenticated. So there is no login code here,
 * and the page, which carries the children's names and their health notes,
 * is never sent to anyone the policy does not name. The check below is the
 * backstop for a Worker that ends up reachable without Access, on a route
 * nobody meant to add: it refuses rather than serves.
 *
 * **One Durable Object, not D1.** A D1 binding needs the account's database id
 * in the config, and this repository is public; a SQLite-backed Durable Object
 * is declared by class name, so `wrangler deploy` is the whole of provisioning.
 * It is also strongly consistent and serial, which is the property the ticks
 * need: two phones ticking at once are two requests to one object, and each
 * tick is its own row, so neither can overwrite the other's.
 */

import { BRIEF_PATH, DONE_PATH, KEEP_DAYS, MAX_PAGE_BYTES } from './protocol.ts';

// A Worker's entry module may export its handler and its Durable Object classes
// and nothing else — workerd refuses to start on an exported constant, which a
// dry-run bundle does not catch. Shared values live in protocol.ts.

// ------------------------------------------------------------ runtime slice

type SqlCursor<Row> = { toArray(): Row[] };

export type SqlStorage = {
  exec<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<Row>;
};

export type DurableObjectState = {
  storage: { sql: SqlStorage; transactionSync<T>(closure: () => T): T };
};

type DurableObjectNamespace = {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
};

export type Env = { BRIEF_STORE: DurableObjectNamespace };

/** Present only when Cloudflare Access authenticated this request. */
export type ExecutionContext = { readonly access?: { readonly aud: string } };

// ------------------------------------------------------------------ limits

/**
 * Bounds on one tick. A card carries one key per source it gathers, rarely
 * more than a handful; the keys are built in `collect.ts` from numeric ids,
 * ISO weeks and snake_case names, joined to a date with `|`, so none contains
 * whitespace — the page splits `data-done-keys` on spaces.
 */
const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 200;
const KEY_PATTERN = /^\S+$/;

/**
 * The page is generated from other people's text. `render.ts` escapes it, and
 * this is the second line: whatever got through can run inline, which the
 * page's own two scripts need, but can reach no host other than this one.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// --------------------------------------------------------------- responses

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ------------------------------------------------------------ the store

type DoneBody = { keys: string[]; done: boolean };

function parseDoneBody(value: unknown): DoneBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const { keys, done } = value as Record<string, unknown>;
  if (typeof done !== 'boolean' || !Array.isArray(keys)) return null;
  if (keys.length === 0 || keys.length > MAX_KEYS) return null;
  const valid = keys.every(
    (key): key is string =>
      typeof key === 'string' && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key),
  );
  return valid ? { keys, done } : null;
}

/**
 * The page and the ticks, for the one household this deployment serves.
 *
 * A fetch-style Durable Object rather than an RPC one: the Worker in front has
 * nothing to add once Access has let a request through, so it forwards the
 * request whole and the routes live here, beside the tables they read.
 */
export class BriefStore {
  readonly #storage: DurableObjectState['storage'];

  constructor(state: DurableObjectState) {
    this.#storage = state.storage;
    // Idempotent, and cheap enough to run each time the object wakes, which
    // leaves no migration step for whoever deploys this.
    this.#sql(
      'CREATE TABLE IF NOT EXISTS page (id INTEGER PRIMARY KEY CHECK (id = 1), html TEXT NOT NULL, stored_at TEXT NOT NULL)',
    );
    this.#sql('CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY, at TEXT NOT NULL)');
  }

  #sql<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): Row[] {
    return this.#storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (`${request.method} ${pathname}`) {
      case 'GET /':
        return this.#page();
      case `PUT ${BRIEF_PATH}`:
        return this.#putPage(request);
      case `GET ${DONE_PATH}`:
        return json(200, { done: this.#done() });
      case `POST ${DONE_PATH}`:
        return this.#setDone(request);
      default:
        return text(404, 'Ikke fundet.');
    }
  }

  #page(): Response {
    const [row] = this.#sql<{ html: string }>('SELECT html FROM page WHERE id = 1');
    if (!row) return text(404, 'Der er ikke lagt noget overblik op endnu.');
    return new Response(row.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Yesterday's brief served from a phone's cache reads as today's.
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  async #putPage(request: Request): Promise<Response> {
    const html = await request.text();
    const bytes = new TextEncoder().encode(html).byteLength;
    if (html.trim() === '') return text(400, 'Tom side.');
    if (bytes > MAX_PAGE_BYTES) {
      return text(413, `Siden er ${bytes} bytes; grænsen er ${MAX_PAGE_BYTES}.`);
    }
    const storedAt = new Date().toISOString();
    this.#sql(
      'INSERT INTO page (id, html, stored_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET html = excluded.html, stored_at = excluded.stored_at',
      html,
      storedAt,
    );
    return json(200, { storedAt, bytes });
  }

  /** Key → when it was ticked, for every tick still inside the window. */
  #done(): Record<string, string> {
    const rows = this.#sql<{ key: string; at: string }>(
      'SELECT key, at FROM done WHERE at >= ?',
      cutoff(),
    );
    return Object.fromEntries(rows.map((row) => [row.key, row.at]));
  }

  /**
   * One tick or untick, applied to every key the card carries, and answered
   * with the whole set — so the page that sent it also learns what the other
   * phone ticked since it last asked.
   *
   * JSON only: a cross-site form can post `text/plain` without a preflight,
   * and this makes such a request fail here even if a cookie came with it.
   */
  async #setDone(request: Request): Promise<Response> {
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return text(415, 'Forventer JSON.');
    }
    let body: DoneBody | null = null;
    try {
      body = parseDoneBody(await request.json());
    } catch {
      // Unparseable is the same answer as malformed.
    }
    if (!body) return text(400, 'Forventer {"keys": [...], "done": true|false}.');

    const { keys, done } = body;
    const at = new Date().toISOString();
    this.#storage.transactionSync(() => {
      for (const key of keys) {
        if (done) {
          this.#sql(
            'INSERT INTO done (key, at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at',
            key,
            at,
          );
        } else {
          this.#sql('DELETE FROM done WHERE key = ?', key);
        }
      }
      // The same window the page used to prune its own copy with: long enough
      // that no tick outlives the items it hides, short enough to stay small.
      this.#sql('DELETE FROM done WHERE at < ?', cutoff());
    });
    return json(200, { done: this.#done() });
  }
}

function cutoff(): string {
  return new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
}

// -------------------------------------------------------------- the Worker

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    if (!ctx.access) {
      return text(403, 'Denne side kræver Cloudflare Access foran sig.');
    }
    // One household per deployment, so one object, addressed by a fixed name.
    return env.BRIEF_STORE.getByName('brief').fetch(request);
  },
};
