import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefResponse, generation, type Generation } from './preview.ts';

const dirs: string[] = [];

function briefDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-preview-test-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A generation whose state the test scripts, and whose calls it can count. */
function fakeGen(state: { running?: boolean; failed?: string | null } = {}) {
  const calls = { start: 0, reset: 0 };
  const gen: Generation = {
    get running() {
      return state.running ?? false;
    },
    get failed() {
      return state.failed ?? null;
    },
    start() {
      calls.start++;
    },
    reset() {
      calls.reset++;
    },
  };
  return { gen, calls };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('briefResponse', () => {
  test('the root serves the newest page, uncached, without generating anything', async () => {
    const { gen, calls } = fakeGen();
    const res = briefResponse('/', briefDir({ 'latest.html': '<h1>dagens overblik</h1>' }), gen);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dagens overblik');
    expect(res.headers.get('content-type')).toContain('text/html');
    // The same URL serves a new page every morning; a cached copy would
    // quietly show yesterday.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls.start).toBe(0);
  });

  test('a missing newest page starts a generation and says so', async () => {
    const { gen, calls } = fakeGen();
    const res = briefResponse('/', briefDir(), gen);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Generating');
    expect(body).toContain('http-equiv="refresh"');
    expect(calls.start).toBe(1);
  });

  test('refreshes while a run is under way keep showing progress', async () => {
    const { gen } = fakeGen({ running: true });
    const body = await briefResponse('/', briefDir(), gen).text();
    expect(body).toContain('Generating');
    expect(body).toContain('http-equiv="refresh"');
  });

  test('a failed run is shown honestly, does not auto-retry, and escapes its message', async () => {
    const { gen, calls } = fakeGen({ failed: 'Not logged in <script>alert(1)</script>' });
    const res = briefResponse('/', briefDir(), gen);
    const body = await res.text();
    expect(body).toContain('could not be generated');
    expect(body).toContain('Not logged in');
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('<script>alert');
    // No meta refresh: an auto-retry loop would run the model every couple of
    // minutes against a failure that needs a human (log in, say).
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).toContain('href="/retry"');
    expect(calls.start).toBe(0);
  });

  test('the retry link forgets the failure and redirects to the front', () => {
    const { gen, calls } = fakeGen({ failed: 'x' });
    const res = briefResponse('/retry', briefDir(), gen);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(calls.reset).toBe(1);
  });

  test('a dated page is served by its filename, and 404s when absent', () => {
    const dir = briefDir({ 'brief-2026-08-19.html': '<h1>i går</h1>' });
    const { gen } = fakeGen();
    expect(briefResponse('/brief-2026-08-19.html', dir, gen).status).toBe(200);
    expect(briefResponse('/brief-2026-08-18.html', dir, gen).status).toBe(404);
  });

  test('everything else is refused, and never triggers a generation', () => {
    const dir = briefDir({ 'latest.html': 'x' });
    const { gen, calls } = fakeGen();
    for (const path of [
      '/../../../etc/passwd',
      '/etc/passwd',
      '/latest.html/..',
      '/brief-2026-08-19.pdf',
      '/state.json',
      '/artifact-url',
      '/favicon.ico',
    ]) {
      expect(briefResponse(path, dir, gen).status).toBe(404);
    }
    expect(calls.start).toBe(0);
  });
});

describe('generation', () => {
  test('a run that cannot work ends as a remembered failure, not a loop', async () => {
    // A sandbox with no login: the child exits 2 almost immediately, and the
    // message a user needs (run login) must survive into the failure state.
    const sandbox = briefDir();
    const gen = generation(sandbox, { AULA_DIR: sandbox });
    gen.start();
    expect(gen.running).toBe(true);

    const deadline = Date.now() + 15_000;
    while (gen.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(gen.running).toBe(false);
    expect(gen.failed ?? '').toContain('Not logged in');

    gen.reset();
    expect(gen.failed).toBeNull();
  }, 20_000);
});
