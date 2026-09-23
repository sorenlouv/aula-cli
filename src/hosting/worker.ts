/**
 * The hosted copy of the brief: a Cloudflare Worker, and the one Durable Object
 * behind it that holds the page, the family's sessions and what they have
 * ticked off.
 *
 * Deployed once by hand (`HOSTING.md`); never imported by the CLI, so none of
 * it is in the compiled binary. It lives in `src/` so Bun typechecks and tests
 * it like everything else, which is also why the slice of the Workers runtime
 * it touches is declared below instead of taken from
 * `@cloudflare/workers-types`: those replace Bun's globals for the whole
 * program they are loaded into.
 *
 * **Who may read is the Worker's own decision.** It signs a family member in
 * with a code sent to their address — `auth.ts` says why that is not
 * Cloudflare Access any more — and every route but the login answers only to
 * a session. Nothing about who may read is in this repository: the addresses
 * (`ALLOWED_EMAILS`), the sender (`MAIL_FROM`) and the CLI's upload token
 * (`UPLOAD_TOKEN`) are Worker secrets, and a Worker missing one refuses
 * rather than guesses.
 *
 * **One Durable Object, not D1.** A D1 binding needs the account's database id
 * in the config, and this repository is public; a SQLite-backed Durable Object
 * is declared by class name, so `wrangler deploy` is the whole of provisioning.
 * It is also strongly consistent, which the ticks, the code attempts and the
 * send limit all lean on: two phones are two requests to one object, and each
 * tick is its own row, so neither can overwrite the other's.
 */

import {
  allowedEmails,
  clearedSessionCookie,
  CODE_ATTEMPTS,
  CODE_MINUTES,
  codeDigest,
  isUploadToken,
  newCode,
  newToken,
  normaliseEmail,
  readCookie,
  RENEW_AFTER_MS,
  RESEND_AFTER_MS,
  sameText,
  SENDS_PER_HOUR,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  sha256,
} from './auth.ts';
import { codeMail, emptyPage, type LoginState, loginPage, PAGE_CSP } from './pages.ts';
import { BRIEF_PATH, DONE_PATH, KEEP_DAYS, MAX_PAGE_BYTES } from './protocol.ts';

// A Worker's entry module may export its handler and its Durable Object classes
// and nothing else — workerd refuses to start on an exported constant, which a
// dry-run bundle does not catch. Shared values live in the modules above.

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

/** The Email Service binding: `send` throws an Error with a `code` when it cannot. */
export type EmailBinding = {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
};

export type Env = {
  BRIEF_STORE: DurableObjectNamespace;
  EMAIL: EmailBinding;
  /** Who may sign in: addresses separated by commas or whitespace. */
  ALLOWED_EMAILS?: string | undefined;
  /** The address codes are sent from, on a domain with Email Routing. */
  MAIL_FROM?: string | undefined;
  /** What `aula publish` sends as its bearer token. */
  UPLOAD_TOKEN?: string | undefined;
};

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
 * The brief is generated from other people's text. `render.ts` escapes it, and
 * this is the second line: whatever got through can run inline, which the
 * page's own two scripts need, but can reach no host other than this one.
 */
const BRIEF_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// --------------------------------------------------------------- responses

const NO_STORE = { 'cache-control': 'no-store' };

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE },
  });
}

/**
 * A page of ours or the brief. `no-store` because yesterday's brief served
 * from a phone's cache reads as today's, and a login page must never be the
 * answer a cache gives for `/` once someone has signed in.
 */
function html(status: number, body: string, csp = PAGE_CSP): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      // Not `no-referrer`: under it a browser sends `Origin: null` with every
      // POST, its own forms and the tick script's included, and `fromThisSite`
      // refuses them all. `same-origin` still tells aula.dk nothing.
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      ...NO_STORE,
    },
  });
}

function login(state: LoginState, status = 200): Response {
  return html(status, loginPage(state));
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie } });
}

function withCookie(response: Response, cookie: string | null): Response {
  if (cookie) response.headers.append('set-cookie', cookie);
  return response;
}

// ------------------------------------------------------------------ input

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

async function formOf(request: Request): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  try {
    for (const [key, value] of await request.formData()) {
      if (typeof value === 'string') fields.set(key, value);
    }
  } catch {
    // Not a form: every field is missing, which each route answers for itself.
  }
  return fields;
}

/**
 * A browser states where a POST came from, and a request from another site is
 * refused before it is read. SameSite=Lax already keeps the session cookie off
 * a cross-site POST; this also covers the login forms, which need no cookie.
 * The CLI sends no Origin, and its one route has a token of its own.
 */
function fromThisSite(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return origin === null || origin === url.origin;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------ the store

type Session = { renewal: string | null };

/**
 * The page, the sessions and the ticks, for the one household this deployment
 * serves.
 *
 * A fetch-style Durable Object rather than an RPC one: the Worker in front has
 * nothing to add, so it forwards every request whole and the routes live here,
 * beside the tables they read.
 */
export class BriefStore {
  readonly #storage: DurableObjectState['storage'];
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#storage = state.storage;
    this.#env = env;
    // Idempotent, and cheap enough to run each time the object wakes, which
    // leaves no migration step for whoever deploys this.
    for (const table of [
      'page (id INTEGER PRIMARY KEY CHECK (id = 1), html TEXT NOT NULL, stored_at TEXT NOT NULL)',
      'done (key TEXT PRIMARY KEY, at TEXT NOT NULL)',
      'login_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, sent_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL)',
      'login_sends (email TEXT NOT NULL, at TEXT NOT NULL)',
      'sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, renewed_at TEXT NOT NULL)',
    ]) {
      this.#sql(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  }

  #sql<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): Row[] {
    return this.#storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  async fetch(request: Request): Promise<Response> {
    const response = await this.#route(request);
    // A route that answered without reading the body — a refused upload, a
    // cross-site form — leaves the Worker still forwarding it after the answer,
    // which workerd reports as an uncaught error and resets the object over,
    // failing whatever request came next. Cancelling the stream is not enough;
    // reading it to the end is. The largest body is one brief.
    if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => undefined);
    return response;
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (request.method === 'POST' && !fromThisSite(request, url)) {
      return text(403, 'Forkert afsender.');
    }

    switch (route) {
      case `PUT ${BRIEF_PATH}`:
        return this.#putPage(request);
      case 'POST /login':
        return this.#sendCode(request);
      case 'POST /login/code':
        return this.#checkCode(request);
      case 'POST /logout':
        return this.#logout(request);
    }

    const session = await this.#session(request);
    switch (route) {
      case 'GET /':
        if (!session) return login({ step: 'email' });
        return withCookie(this.#page(), session.renewal);
      case `GET ${DONE_PATH}`:
        if (!session) return json(401, { error: 'Log ind igen.' });
        return withCookie(json(200, { done: this.#done() }), session.renewal);
      case `POST ${DONE_PATH}`:
        if (!session) return json(401, { error: 'Log ind igen.' });
        return withCookie(await this.#setDone(request), session.renewal);
      default:
        return text(404, 'Ikke fundet.');
    }
  }

  // ---------------------------------------------------------------- login

  #allowed(): Set<string> {
    return allowedEmails(this.#env.ALLOWED_EMAILS);
  }

  /**
   * Step one: an address in, a code out by mail.
   *
   * The answer is the code form whether or not the address may sign in, so the
   * page does not say who is on the list. The one exception is a send that
   * failed, which says so: a parent waiting for mail that will never come is
   * worse than the list being guessable from an outage.
   */
  async #sendCode(request: Request): Promise<Response> {
    const form = await formOf(request);
    const typed = form.get('email') ?? '';
    const email = normaliseEmail(typed);
    if (!email)
      return login({ step: 'email', email: typed, error: 'Skriv en gyldig e-mail.' }, 400);
    if (!this.#allowed().has(email)) return login({ step: 'code', email });

    // The code and its digest first: from here to the stored row nothing
    // awaits, so a second request cannot slip between the check and the write.
    const code = newCode();
    const digest = await codeDigest(email, code);
    const now = Date.now();
    const [recent] = this.#sql<{ sent_at: string; expires_at: string }>(
      'SELECT sent_at, expires_at FROM login_codes WHERE email = ?',
      email,
    );
    // A second press, or a reload that resent the form: the code on its way
    // is still the one to type.
    if (
      recent &&
      now - Date.parse(recent.sent_at) < RESEND_AFTER_MS &&
      Date.parse(recent.expires_at) > now
    ) {
      return login({ step: 'code', email });
    }
    const [sends] = this.#sql<{ n: number }>(
      'SELECT count(*) AS n FROM login_sends WHERE email = ? AND at >= ?',
      email,
      iso(now - 3_600_000),
    );
    if ((sends?.n ?? 0) >= SENDS_PER_HOUR) {
      return login(
        {
          step: 'email',
          email,
          error: 'Der er sendt mange koder den seneste time. Prøv igen lidt senere.',
        },
        429,
      );
    }

    const from = this.#env.MAIL_FROM;
    if (!from) {
      console.error('login: MAIL_FROM is not set');
      return login({ step: 'email', email, error: 'Siden kan ikke sende mail endnu.' }, 503);
    }

    // Stored before the send, so a second request arriving while this one
    // waits on the mail finds it and does not send another.
    this.#storage.transactionSync(() => {
      this.#sql(
        'INSERT INTO login_codes (email, code_hash, sent_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ' +
          'ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, sent_at = excluded.sent_at, expires_at = excluded.expires_at, attempts = 0',
        email,
        digest,
        iso(now),
        iso(now + CODE_MINUTES * 60_000),
      );
      this.#sql('INSERT INTO login_sends (email, at) VALUES (?, ?)', email, iso(now));
      this.#sql('DELETE FROM login_sends WHERE at < ?', iso(now - 3_600_000));
    });

    try {
      await this.#env.EMAIL.send({
        to: email,
        from: { email: from, name: 'Aula AI oversigt' },
        ...codeMail(code),
      });
    } catch (error) {
      // The code, the address and the message stay out of the log; the code
      // is what the Email Service reports its reason by.
      console.error('login: code not sent', (error as { code?: unknown }).code ?? 'unknown');
      this.#sql('DELETE FROM login_codes WHERE email = ?', email);
      return login(
        { step: 'email', email, error: 'Koden kunne ikke sendes. Prøv igen om lidt.' },
        502,
      );
    }
    return login({ step: 'code', email });
  }

  /** Step two: the code in, a session out. */
  async #checkCode(request: Request): Promise<Response> {
    const form = await formOf(request);
    const email = normaliseEmail(form.get('email'));
    if (!email) return login({ step: 'email', error: 'Skriv din e-mail igen.' }, 400);
    const code = (form.get('code') ?? '').replace(/\s/g, '');
    // Hashed before the row is read, so nothing awaits between reading the
    // attempt count and writing it back.
    const digest = /^\d{6}$/.test(code) ? await codeDigest(email, code) : '';

    const now = Date.now();
    const [row] = this.#sql<{ code_hash: string; expires_at: string; attempts: number }>(
      'SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?',
      email,
    );
    if (!row || Date.parse(row.expires_at) <= now || row.attempts >= CODE_ATTEMPTS) {
      this.#sql('DELETE FROM login_codes WHERE email = ?', email);
      return login({ step: 'email', email, error: 'Koden er udløbet. Få en ny.' }, 400);
    }
    if (!digest || !sameText(digest, row.code_hash)) {
      this.#sql('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?', email);
      const left = CODE_ATTEMPTS - row.attempts - 1;
      if (left <= 0) {
        this.#sql('DELETE FROM login_codes WHERE email = ?', email);
        return login({ step: 'email', email, error: 'Koden passede ikke. Få en ny.' }, 400);
      }
      return login({ step: 'code', email, error: 'Koden passer ikke. Prøv igen.' }, 400);
    }

    const token = newToken();
    const tokenHash = await sha256(token);
    this.#storage.transactionSync(() => {
      this.#sql('DELETE FROM login_codes WHERE email = ?', email);
      this.#sql('DELETE FROM sessions WHERE expires_at < ?', iso(now));
      this.#sql(
        'INSERT INTO sessions (token_hash, email, expires_at, renewed_at) VALUES (?, ?, ?, ?)',
        tokenHash,
        email,
        iso(now + SESSION_DAYS * 86_400_000),
        iso(now),
      );
    });
    return redirect('/', sessionCookie(token));
  }

  async #logout(request: Request): Promise<Response> {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) this.#sql('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
    return redirect('/', clearedSessionCookie());
  }

  /**
   * The session this request carries, renewing it at most once a day.
   *
   * An address taken off `ALLOWED_EMAILS` loses its sessions with it — that is
   * how someone is signed out for good, without touching the store.
   */
  async #session(request: Request): Promise<Session | null> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = await sha256(token);
    const [row] = this.#sql<{ email: string; expires_at: string; renewed_at: string }>(
      'SELECT email, expires_at, renewed_at FROM sessions WHERE token_hash = ?',
      tokenHash,
    );
    const now = Date.now();
    if (!row || Date.parse(row.expires_at) <= now || !this.#allowed().has(row.email)) return null;
    if (now - Date.parse(row.renewed_at) < RENEW_AFTER_MS) return { renewal: null };
    this.#sql(
      'UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE token_hash = ?',
      iso(now + SESSION_DAYS * 86_400_000),
      iso(now),
      tokenHash,
    );
    return { renewal: sessionCookie(token) };
  }

  // ----------------------------------------------------------------- page

  #page(): Response {
    const [row] = this.#sql<{ html: string }>('SELECT html FROM page WHERE id = 1');
    return row ? html(200, row.html, BRIEF_CSP) : html(200, emptyPage());
  }

  async #putPage(request: Request): Promise<Response> {
    const header = request.headers.get('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!(await isUploadToken(given, this.#env.UPLOAD_TOKEN))) {
      return text(401, 'Forkert upload-nøgle.');
    }
    const body = await request.text();
    const bytes = new TextEncoder().encode(body).byteLength;
    if (body.trim() === '') return text(400, 'Tom side.');
    if (bytes > MAX_PAGE_BYTES) {
      return text(413, `Siden er ${bytes} bytes; grænsen er ${MAX_PAGE_BYTES}.`);
    }
    const storedAt = new Date().toISOString();
    this.#sql(
      'INSERT INTO page (id, html, stored_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET html = excluded.html, stored_at = excluded.stored_at',
      body,
      storedAt,
    );
    return json(200, { storedAt, bytes });
  }

  // ---------------------------------------------------------------- ticks

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
      // The same window the page prunes its own copy with: long enough that
      // no tick outlives the items it hides, short enough to stay small.
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
  fetch(request: Request, env: Env): Promise<Response> {
    // One household per deployment, so one object, addressed by a fixed name.
    return env.BRIEF_STORE.getByName('brief').fetch(request);
  },
};
