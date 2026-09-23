import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CODE_ATTEMPTS, SENDS_PER_HOUR, SESSION_COOKIE } from './auth.ts';
import { KEEP_DAYS, MAX_PAGE_BYTES } from './protocol.ts';
import * as entry from './worker.ts';
import worker, {
  BriefStore,
  type DurableObjectState,
  type EmailBinding,
  type Env,
} from './worker.ts';

const ORIGIN = 'https://aula.eksempel.dk';
const PARENT = 'valdemar@eksempel.dk';
const OTHER_PARENT = 'vibeke@eksempel.dk';
const UPLOAD_TOKEN = 'eksempel-upload-token';
const PAGE = '<!doctype html><title>Aula AI oversigt</title><p>Husk madpakke</p>';

type Sent = Parameters<EmailBinding['send']>[0];

/**
 * A Durable Object's storage, backed by SQLite in memory. The object's own SQL
 * is SQLite too, so the statements under test are the ones that will run.
 */
function memoryState(): { state: DurableObjectState; db: Database } {
  const db = new Database(':memory:');
  const state: DurableObjectState = {
    storage: {
      sql: {
        exec: <Row>(query: string, ...bindings: unknown[]) => ({
          toArray: () => db.query(query).all(...(bindings as SQLQueryBindings[])) as Row[],
        }),
      },
      transactionSync: (closure) => db.transaction(closure)(),
    },
  };
  return { state, db };
}

/** One household's Worker, with a mailbox that keeps what it was asked to send. */
function household(overrides: Partial<Env> & { mailFails?: boolean } = {}) {
  const { state, db } = memoryState();
  const mail: Sent[] = [];
  const env: Env = {
    BRIEF_STORE: { getByName: () => ({ fetch: (request) => store.fetch(request) }) },
    EMAIL: {
      send: async (message) => {
        if (overrides.mailFails) {
          throw Object.assign(new Error('not allowed'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
        }
        mail.push(message);
        return { messageId: String(mail.length) };
      },
    },
    ALLOWED_EMAILS: `${PARENT}, ${OTHER_PARENT.toUpperCase()}`,
    MAIL_FROM: 'login@eksempel.dk',
    UPLOAD_TOKEN,
    ...overrides,
  };
  const store = new BriefStore(state, env);

  const send = (request: Request) => store.fetch(request);
  const form = (path: string, fields: Record<string, string>, cookie?: string) =>
    send(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams(fields),
      }),
    );
  /** The code in the newest mail, read off its subject as a phone would show it. */
  const lastCode = () => /^(\d{6}) /.exec(mail.at(-1)?.subject ?? '')?.[1] ?? '';

  /** Signs `email` in and returns the cookie header a browser would send back. */
  const signIn = async (email = PARENT): Promise<string> => {
    await form('/login', { email });
    const response = await form('/login/code', { email, code: lastCode() });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(response.status).toBe(303);
    return cookie.split(';')[0] ?? '';
  };

  const get = (path: string, cookie?: string) =>
    send(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
  const upload = (body: string, token = UPLOAD_TOKEN) =>
    send(
      new Request(`${ORIGIN}/api/brief`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
    );
  const tick = (cookie: string, keys: unknown, done: unknown, contentType = 'application/json') =>
    send(
      new Request(`${ORIGIN}/api/done`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': contentType },
        body: JSON.stringify({ keys, done }),
      }),
    );

  return { db, env, mail, store, form, lastCode, signIn, get, upload, tick };
}

async function doneOf(response: Response): Promise<Record<string, string>> {
  return ((await response.json()) as { done: Record<string, string> }).done;
}

describe('signing in', () => {
  test('a visitor without a session gets the login page, and nothing else', async () => {
    const home = household();
    await home.upload(PAGE);
    const response = await home.get('/');
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('<h1>Log ind</h1>');
    expect(body).not.toContain('Husk madpakke');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('script-src');
  });

  test('an allowed address gets a code by mail, from the configured sender', async () => {
    const home = household();
    const response = await home.form('/login', { email: ` ${PARENT.toUpperCase()} ` });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="code"');
    expect(home.mail).toHaveLength(1);
    expect(home.mail[0]?.to).toBe(PARENT);
    expect(home.mail[0]?.from.email).toBe('login@eksempel.dk');
    expect(home.lastCode()).toMatch(/^\d{6}$/);
    expect(home.mail[0]?.text).toContain(home.lastCode());
  });

  test('an address not on the list sees the same form, and no mail is sent', async () => {
    const home = household();
    const allowed = await (await home.form('/login', { email: PARENT })).text();
    const stranger = await (await home.form('/login', { email: 'fremmed@eksempel.dk' })).text();
    expect(home.mail).toHaveLength(1);
    expect(stranger.replaceAll('fremmed@eksempel.dk', PARENT)).toBe(allowed);
  });

  test('the right code signs in for a year, with a cookie scripts cannot read', async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    const response = await home.form('/login/code', { email: PARENT, code: home.lastCode() });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toStartWith(`${SESSION_COOKIE}=`);
    for (const attribute of ['Max-Age=31536000', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']) {
      expect(cookie).toContain(attribute);
    }
  });

  test('a signed-in visitor gets the brief', async () => {
    const home = household();
    const cookie = await home.signIn();
    expect(await (await home.get('/', cookie)).text()).toContain('<h1>Snart</h1>');
    await home.upload(PAGE);
    const response = await home.get('/', cookie);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  test('a code is spent once it has signed someone in', async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    const code = home.lastCode();
    await home.form('/login/code', { email: PARENT, code });
    const again = await home.form('/login/code', { email: PARENT, code });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('Koden er udløbet');
  });

  test('a code is one address’s, not the other parent’s', async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    const response = await home.form('/login/code', { email: OTHER_PARENT, code: home.lastCode() });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test(`${CODE_ATTEMPTS} wrong guesses spend the code`, async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    const code = home.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i < CODE_ATTEMPTS; i++) {
      const response = await home.form('/login/code', { email: PARENT, code: wrong });
      expect(await response.text()).toContain('Koden passer ikke');
    }
    const last = await home.form('/login/code', { email: PARENT, code: wrong });
    expect(await last.text()).toContain('Få en ny');
    const right = await home.form('/login/code', { email: PARENT, code });
    expect(right.status).toBe(400);
  });

  test('an expired code does not sign in', async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    home.db
      .query('UPDATE login_codes SET expires_at = ?')
      .run(new Date(Date.now() - 1).toISOString());
    const response = await home.form('/login/code', { email: PARENT, code: home.lastCode() });
    expect(await response.text()).toContain('Koden er udløbet');
  });

  test('pressing "Send kode" twice sends one mail', async () => {
    const home = household();
    await home.form('/login', { email: PARENT });
    await home.form('/login', { email: PARENT });
    expect(home.mail).toHaveLength(1);
  });

  test(`at most ${SENDS_PER_HOUR} codes an hour to one address`, async () => {
    const home = household();
    for (let i = 0; i < SENDS_PER_HOUR; i++) {
      await home.form('/login', { email: PARENT });
      // Past the one-minute guard, as if a minute had gone by.
      home.db
        .query('UPDATE login_codes SET sent_at = ?')
        .run(new Date(Date.now() - 61_000).toISOString());
    }
    const response = await home.form('/login', { email: PARENT });
    expect(response.status).toBe(429);
    expect(home.mail).toHaveLength(SENDS_PER_HOUR);
  });

  test('a mail that could not be sent says so, and leaves no code behind', async () => {
    const home = household({ mailFails: true });
    const response = await home.form('/login', { email: PARENT });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('kunne ikke sendes');
    expect(home.db.query('SELECT * FROM login_codes').all()).toEqual([]);
  });

  test('a Worker without its sender refuses to pretend it sent anything', async () => {
    const home = household({ MAIL_FROM: undefined });
    expect((await home.form('/login', { email: PARENT })).status).toBe(503);
  });

  test('a form posted from another site is refused before it is read', async () => {
    const home = household();
    const response = await home.store.fetch(
      new Request(`${ORIGIN}/login`, {
        method: 'POST',
        headers: { origin: 'https://ondsindet.eksempel.dk' },
        body: new URLSearchParams({ email: PARENT }),
      }),
    );
    expect(response.status).toBe(403);
    expect(home.mail).toEqual([]);
  });

  test('the pages let the browser say where their own forms came from', async () => {
    // Under `no-referrer` a browser sends `Origin: null` with every POST, so
    // the same-site check refused the login form itself — found in `wrangler
    // dev`, invisible here, where the tests set the header by hand.
    const response = await household().get('/');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  test('an address is escaped where the page repeats it', async () => {
    const home = household();
    const body = await (await home.form('/login', { email: 'a"<b>@eksempel.dk' })).text();
    expect(body).toContain('a&quot;&lt;b&gt;@eksempel.dk');
    expect(body).not.toContain('<b>@');
  });
});

describe('the session', () => {
  test('renews itself at most once a day', async () => {
    const home = household();
    const cookie = await home.signIn();
    expect((await home.get('/', cookie)).headers.get('set-cookie')).toBeNull();

    const aWhileAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    home.db
      .query('UPDATE sessions SET renewed_at = ?, expires_at = ?')
      .run(aWhileAgo, new Date(Date.now() + 86_400_000).toISOString());
    const renewed = await home.get('/', cookie);
    expect(renewed.headers.get('set-cookie')).toContain('Max-Age=31536000');
    const [row] = home.db.query('SELECT expires_at FROM sessions').all() as {
      expires_at: string;
    }[];
    expect(Date.parse(row?.expires_at ?? '')).toBeGreaterThan(Date.now() + 360 * 86_400_000);
  });

  test('an expired session is back at the login', async () => {
    const home = household();
    const cookie = await home.signIn();
    home.db.query('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
    expect(await (await home.get('/', cookie)).text()).toContain('<h1>Log ind</h1>');
  });

  test('taking an address off the list signs it out everywhere', async () => {
    const home = household();
    const cookie = await home.signIn(OTHER_PARENT);
    home.env.ALLOWED_EMAILS = PARENT;
    expect(await (await home.get('/', cookie)).text()).toContain('<h1>Log ind</h1>');
  });

  test('logging out forgets the session on the server, not just in the browser', async () => {
    const home = household();
    const cookie = await home.signIn();
    const out = await home.form('/logout', {}, cookie);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await home.get('/', cookie)).text()).toContain('<h1>Log ind</h1>');
  });

  test('a made-up cookie is no session', async () => {
    const home = household();
    const response = await home.get('/', `${SESSION_COOKIE}=gaet`);
    expect(await response.text()).toContain('<h1>Log ind</h1>');
  });
});

describe('the upload', () => {
  test('needs the upload token, and a Worker without one takes none', async () => {
    expect((await household().upload(PAGE, 'forkert')).status).toBe(401);
    expect((await household().upload(PAGE, '')).status).toBe(401);
    expect((await household({ UPLOAD_TOKEN: undefined }).upload(PAGE, '')).status).toBe(401);
    expect((await household().upload(PAGE)).status).toBe(200);
  });

  test('each upload replaces the one before', async () => {
    const home = household();
    const cookie = await home.signIn();
    await home.upload(PAGE);
    await home.upload('<p>i morgen</p>');
    expect(await (await home.get('/', cookie)).text()).toBe('<p>i morgen</p>');
  });

  test('refuses an empty page and one too large for a row', async () => {
    const home = household();
    expect((await home.upload('  \n')).status).toBe(400);
    expect((await home.upload('x'.repeat(MAX_PAGE_BYTES + 1))).status).toBe(413);
    expect(home.db.query('SELECT * FROM page').all()).toEqual([]);
  });
});

describe('the ticks', () => {
  test('are for signed-in visitors only', async () => {
    const home = household();
    expect((await home.get('/api/done')).status).toBe(401);
    expect((await home.tick('', ['post:1|-'], true)).status).toBe(401);
  });

  test('a tick covers every key the card carries, and an untick removes them', async () => {
    const home = household();
    const cookie = await home.signIn();
    const keys = ['post:1|2026-08-17', 'thread:88|2026-08-17'];
    const ticked = await doneOf(await home.tick(cookie, keys, true));
    expect(Object.keys(ticked).sort()).toEqual(keys);
    expect(await doneOf(await home.get('/api/done', cookie))).toEqual(ticked);
    expect(await doneOf(await home.tick(cookie, keys, false))).toEqual({});
  });

  test("one parent's tick is the other parent's too", async () => {
    // The reason for a row per key: two phones that each sent their whole map
    // would leave only the last one standing.
    const home = household();
    const mine = await home.signIn(PARENT);
    const theirs = await home.signIn(OTHER_PARENT);
    await home.tick(mine, ['post:1|2026-08-17'], true);
    const both = await doneOf(await home.tick(theirs, ['post:2|-'], true));
    expect(Object.keys(both).sort()).toEqual(['post:1|2026-08-17', 'post:2|-']);
  });

  test('a tick older than the window is neither listed nor kept', async () => {
    const home = household();
    const cookie = await home.signIn();
    const old = new Date(Date.now() - (KEEP_DAYS + 1) * 86_400_000).toISOString();
    home.db.query('INSERT INTO done (key, at) VALUES (?, ?)').run('post:9|2026-01-01', old);
    expect(await doneOf(await home.get('/api/done', cookie))).toEqual({});
    await home.tick(cookie, ['post:1|-'], true);
    expect(home.db.query('SELECT key FROM done').all()).toEqual([{ key: 'post:1|-' }]);
  });

  test('a malformed tick is refused and changes nothing', async () => {
    const home = household();
    const cookie = await home.signIn();
    const bad: [unknown, unknown][] = [
      ['post:1|-', true],
      [[], true],
      [['post:1|-'], 'yes'],
      [['two words'], true],
      [['x'.repeat(201)], true],
      [Array.from({ length: 51 }, (_, i) => `post:${i}|-`), true],
    ];
    for (const [keys, done] of bad) {
      expect((await home.tick(cookie, keys, done)).status).toBe(400);
    }
    expect(await doneOf(await home.get('/api/done', cookie))).toEqual({});
  });

  test('only JSON, so a cross-site form cannot tick without a preflight', async () => {
    const home = household();
    const cookie = await home.signIn();
    expect((await home.tick(cookie, ['post:1|-'], true, 'text/plain')).status).toBe(415);
  });
});

describe('the Worker in front', () => {
  test('exports its handler and its Durable Object class, and nothing else', () => {
    // workerd refuses to start on any other export, and `wrangler deploy
    // --dry-run` bundles one without complaint — an exported constant got as
    // far as the first `wrangler dev` before anything noticed.
    const others = Object.entries(entry).filter(
      ([name, value]) => name !== 'default' && typeof value !== 'function',
    );
    expect(others).toEqual([]);
  });

  test('sends every request to the one household object', async () => {
    const names: string[] = [];
    const home = household();
    const env: Env = {
      ...home.env,
      BRIEF_STORE: {
        getByName: (name) => {
          names.push(name);
          return { fetch: (request) => home.store.fetch(request) };
        },
      },
    };
    const response = await worker.fetch(new Request(`${ORIGIN}/`), env);
    expect(await response.text()).toContain('<h1>Log ind</h1>');
    expect(names).toEqual(['brief']);
  });

  test('anything else is not found', async () => {
    const home = household();
    const cookie = await home.signIn();
    expect((await home.get('/favicon.ico', cookie)).status).toBe(404);
  });
});
