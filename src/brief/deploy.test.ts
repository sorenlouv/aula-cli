import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HostingConfig, hostingOrigin, readConfig, writeConfig } from '../config.ts';
import { MAX_PAGE_BYTES } from '../hosting/protocol.ts';
import { deployBrief, readHosting, setHosting } from './deploy.ts';

const HOSTING: HostingConfig = {
  url: 'https://aula.eksempel.dk',
  clientId: 'eksempel-id.access',
  clientSecret: 'eksempel-secret',
};
const PAGE = '<!doctype html><title>Aula AI oversigt</title>';

const dirs: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

/** A config path that belongs to the test, never to ~/.aula. */
function configPath(hosting?: HostingConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-deploy-test-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  if (hosting) writeConfig({ hosting }, path);
  return path;
}

type Sent = { url: string; method: string; headers: Headers; body: string; redirect: string };

/** Stands in for the Worker behind Access, answering every upload with `answer`. */
function worker(answer: () => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: String(init?.body),
      redirect: init?.redirect ?? 'follow',
    });
    return answer();
  }) as typeof fetch;
  return sent;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readHosting / setHosting', () => {
  test('nothing configured means the brief stays local', () => {
    expect(readHosting(configPath())).toBeNull();
  });

  test('reads what setHosting wrote, and null turns hosting off', () => {
    const path = configPath();
    setHosting(HOSTING, path);
    expect(readHosting(path)).toEqual(HOSTING);
    setHosting(null, path);
    expect(readHosting(path)).toBeNull();
  });

  test('keeps the calendars beside it', () => {
    const path = configPath();
    writeConfig({ calendars: [{ id: 'familien@eksempel.dk', name: 'Familien' }] }, path);
    setHosting(HOSTING, path);
    expect(readConfig(path).calendars).toEqual([{ id: 'familien@eksempel.dk', name: 'Familien' }]);
  });

  test('a hand-edited config without its token is refused rather than half-read', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ hosting: { url: HOSTING.url, clientId: 'x' } }));
    expect(() => readHosting(path)).toThrow(/clientSecret/);
  });
});

describe('hostingOrigin', () => {
  test('an https origin, with or without its slash', () => {
    expect(hostingOrigin('https://aula.eksempel.dk')).toBe('https://aula.eksempel.dk');
    expect(hostingOrigin(' https://aula.eksempel.dk/ ')).toBe('https://aula.eksempel.dk');
  });

  test('http only for `wrangler dev` on loopback', () => {
    expect(hostingOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(hostingOrigin('http://aula.eksempel.dk')).toBeNull();
  });

  test('nothing the Worker would silently drop', () => {
    for (const url of [
      'https://aula.eksempel.dk/brief',
      'https://aula.eksempel.dk/?x=1',
      'https://user:pw@aula.eksempel.dk',
      'aula.eksempel.dk',
    ]) {
      expect(hostingOrigin(url)).toBeNull();
    }
  });
});

describe('deployBrief', () => {
  test('with nothing configured, says so and sends nothing', async () => {
    // A lost target used to be indistinguishable from `--no-deploy`, so an
    // installation whose config went missing published nothing and said so
    // nowhere.
    const sent = worker(() => new Response(null, { status: 200 }));
    const result = await deployBrief(PAGE, { configPath: configPath() });
    expect(result.status).toBe('unconfigured');
    expect(sent).toEqual([]);
  });

  test('puts the page with the service token, and does not follow a redirect', async () => {
    const sent = worker(() => Response.json({ bytes: PAGE.length }));
    const result = await deployBrief(PAGE, { configPath: configPath(HOSTING) });

    expect(result).toEqual({ status: 'ok', url: HOSTING.url });
    expect(sent).toHaveLength(1);
    const [put] = sent;
    expect(put?.url).toBe('https://aula.eksempel.dk/api/brief');
    expect(put?.method).toBe('PUT');
    expect(put?.body).toBe(PAGE);
    expect(put?.headers.get('cf-access-client-id')).toBe(HOSTING.clientId);
    expect(put?.headers.get('cf-access-client-secret')).toBe(HOSTING.clientSecret);
    expect(put?.redirect).toBe('manual');
  });

  test('an explicit target is used without reading the config', async () => {
    worker(() => Response.json({}));
    const result = await deployBrief(PAGE, { hosting: HOSTING, configPath: configPath() });
    expect(result).toEqual({ status: 'ok', url: HOSTING.url });
  });

  test('Access redirecting to its login is a refused token, and no retry helps', async () => {
    worker(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://eksempel.cloudflareaccess.com/cdn-cgi/access/login' },
        }),
    );
    const result = await deployBrief(PAGE, { hosting: HOSTING });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.status === 'failed' && result.reason).toContain('service-tokenet');
  });

  test('a 403 is not worth retrying, and its first line is kept', async () => {
    worker(() => new Response('Denne side kræver Cloudflare Access foran sig.\n', { status: 403 }));
    const result = await deployBrief(PAGE, { hosting: HOSTING });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.status === 'failed' && result.reason).toContain('kræver Cloudflare Access');
  });

  test('the server having trouble is worth retrying', async () => {
    worker(() => new Response('upstream', { status: 503 }));
    expect(await deployBrief(PAGE, { hosting: HOSTING })).toMatchObject({
      status: 'failed',
      retryable: true,
    });
  });

  test('no network is a failure worth retrying, not a throw', async () => {
    worker(() => {
      throw new TypeError('fetch failed');
    });
    const result = await deployBrief(PAGE, { hosting: HOSTING });
    expect(result).toMatchObject({ status: 'failed', retryable: true });
    expect(result.status === 'failed' && result.reason).toContain('fetch failed');
  });

  test('a page the Worker could not store is refused before it is sent', async () => {
    const sent = worker(() => Response.json({}));
    const result = await deployBrief('x'.repeat(MAX_PAGE_BYTES + 1), { hosting: HOSTING });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(sent).toEqual([]);
  });

  test('a config that cannot be read is a failure, not a throw', async () => {
    const path = configPath();
    writeFileSync(path, '{');
    expect(await deployBrief(PAGE, { configPath: path })).toMatchObject({ status: 'failed' });
  });
});
