import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { KEEP_DAYS, MAX_PAGE_BYTES } from './protocol.ts';
import * as entry from './worker.ts';
import worker, { BriefStore, type DurableObjectState } from './worker.ts';

const ORIGIN = 'https://aula-brief.eksempel.workers.dev';
const PAGE = '<!doctype html><title>Aula AI oversigt</title><p>Husk madpakke</p>';

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

function storeWithDb() {
  const { state, db } = memoryState();
  return { store: new BriefStore(state), db };
}

function request(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method, ...init });
}

function tick(keys: unknown, done: unknown, contentType = 'application/json'): Request {
  return request('POST', '/api/done', {
    headers: { 'content-type': contentType },
    body: JSON.stringify({ keys, done }),
  });
}

async function doneOf(response: Response): Promise<Record<string, string>> {
  const body = (await response.json()) as { done: Record<string, string> };
  return body.done;
}

describe('the page', () => {
  test('says plainly that nothing has been uploaded yet', async () => {
    const { store } = storeWithDb();
    const response = await store.fetch(request('GET', '/'));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('ikke lagt noget overblik op');
  });

  test('serves exactly what was uploaded, never from a cache', async () => {
    const { store } = storeWithDb();
    const put = await store.fetch(request('PUT', '/api/brief', { body: PAGE }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ bytes: PAGE.length });

    const page = await store.fetch(request('GET', '/'));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
  });

  test('lets its own inline scripts run and talk to this origin only', async () => {
    const { store } = storeWithDb();
    await store.fetch(request('PUT', '/api/brief', { body: PAGE }));
    const csp = (await store.fetch(request('GET', '/'))).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
  });

  test('each upload replaces the one before', async () => {
    const { store } = storeWithDb();
    await store.fetch(request('PUT', '/api/brief', { body: PAGE }));
    await store.fetch(request('PUT', '/api/brief', { body: '<p>i morgen</p>' }));
    expect(await (await store.fetch(request('GET', '/'))).text()).toBe('<p>i morgen</p>');
  });

  test('refuses an empty page and one too large for a row', async () => {
    const { store } = storeWithDb();
    expect((await store.fetch(request('PUT', '/api/brief', { body: '  \n' }))).status).toBe(400);
    const huge = 'x'.repeat(MAX_PAGE_BYTES + 1);
    expect((await store.fetch(request('PUT', '/api/brief', { body: huge }))).status).toBe(413);
    // And neither replaced what was there.
    expect((await store.fetch(request('GET', '/'))).status).toBe(404);
  });
});

describe('the ticks', () => {
  test('a tick covers every key the card carries, and an untick removes them', async () => {
    const { store } = storeWithDb();
    const keys = ['post:1|2026-08-17', 'thread:88|2026-08-17'];
    const ticked = await doneOf(await store.fetch(tick(keys, true)));
    expect(Object.keys(ticked).sort()).toEqual(keys);

    const listed = await doneOf(await store.fetch(request('GET', '/api/done')));
    expect(listed).toEqual(ticked);

    const unticked = await doneOf(await store.fetch(tick(keys, false)));
    expect(unticked).toEqual({});
  });

  test("one parent's tick does not overwrite the other's", async () => {
    // The reason for a row per key: two phones that each sent their whole
    // map would leave only the last one standing.
    const { store } = storeWithDb();
    await store.fetch(tick(['post:1|2026-08-17'], true));
    const both = await doneOf(await store.fetch(tick(['post:2|-'], true)));
    expect(Object.keys(both).sort()).toEqual(['post:1|2026-08-17', 'post:2|-']);
  });

  test('a tick older than the window is neither listed nor kept', async () => {
    const { store, db } = storeWithDb();
    const old = new Date(Date.now() - (KEEP_DAYS + 1) * 86_400_000).toISOString();
    db.query('INSERT INTO done (key, at) VALUES (?, ?)').run('post:9|2026-01-01', old);

    expect(await doneOf(await store.fetch(request('GET', '/api/done')))).toEqual({});
    await store.fetch(tick(['post:1|-'], true));
    expect(db.query('SELECT key FROM done').all()).toEqual([{ key: 'post:1|-' }]);
  });

  test('a malformed tick is refused and changes nothing', async () => {
    const { store } = storeWithDb();
    const bad = [
      tick('post:1|-', true),
      tick([], true),
      tick(['post:1|-'], 'yes'),
      tick(['two words'], true),
      tick(['x'.repeat(201)], true),
      tick(
        Array.from({ length: 51 }, (_, i) => `post:${i}|-`),
        true,
      ),
      request('POST', '/api/done', { headers: { 'content-type': 'application/json' }, body: '{' }),
    ];
    for (const req of bad) expect((await store.fetch(req)).status).toBe(400);
    expect(await doneOf(await store.fetch(request('GET', '/api/done')))).toEqual({});
  });

  test('only JSON, so a cross-site form cannot tick without a preflight', async () => {
    const { store } = storeWithDb();
    const response = await store.fetch(tick(['post:1|-'], true, 'text/plain'));
    expect(response.status).toBe(415);
    expect(await doneOf(await store.fetch(request('GET', '/api/done')))).toEqual({});
  });

  test('anything else is not found', async () => {
    const { store } = storeWithDb();
    expect((await store.fetch(request('DELETE', '/api/done'))).status).toBe(404);
    expect((await store.fetch(request('GET', '/favicon.ico'))).status).toBe(404);
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

  function env() {
    const { state } = memoryState();
    const store = new BriefStore(state);
    const names: string[] = [];
    return {
      names,
      env: {
        BRIEF_STORE: {
          getByName: (name: string) => {
            names.push(name);
            return { fetch: (req: Request) => store.fetch(req) };
          },
        },
      },
    };
  }

  test('refuses a request Cloudflare Access did not authenticate, before the store', async () => {
    const { env: bindings, names } = env();
    const response = await worker.fetch(request('GET', '/'), bindings, {});
    expect(response.status).toBe(403);
    expect(names).toEqual([]);
  });

  test('forwards an authenticated request to the one household object', async () => {
    const { env: bindings, names } = env();
    const access = { access: { aud: 'eksempel-aud' } };
    await worker.fetch(request('PUT', '/api/brief', { body: PAGE }), bindings, access);
    const page = await worker.fetch(request('GET', '/'), bindings, access);
    expect(await page.text()).toBe(PAGE);
    expect(names).toEqual(['brief', 'brief']);
  });
});
