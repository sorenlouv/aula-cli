import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefResponse } from './preview.ts';

const dirs: string[] = [];

function briefDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-preview-test-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('briefResponse', () => {
  test('the root serves the newest page, uncached', async () => {
    const dir = briefDir({ 'latest.html': '<h1>dagens overblik</h1>' });
    const res = briefResponse('/', dir);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dagens overblik');
    expect(res.headers.get('content-type')).toContain('text/html');
    // The same URL serves a new page every morning; a cached copy would
    // quietly show yesterday.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a missing newest page is a self-refreshing empty state, not an error', async () => {
    const res = briefResponse('/', briefDir());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('aula new');
    expect(body).toContain('http-equiv="refresh"');
  });

  test('a dated page is served by its filename, and 404s when absent', async () => {
    const dir = briefDir({ 'brief-2026-08-19.html': '<h1>i går</h1>' });
    expect(briefResponse('/brief-2026-08-19.html', dir).status).toBe(200);
    expect(briefResponse('/brief-2026-08-18.html', dir).status).toBe(404);
  });

  test('everything else is refused — the server shows briefs and nothing more', () => {
    const dir = briefDir({ 'latest.html': 'x' });
    for (const path of [
      '/../../../etc/passwd',
      '/etc/passwd',
      '/latest.html/..',
      '/brief-2026-08-19.pdf',
      '/state.json',
      '/artifact-url',
      '/favicon.ico',
    ]) {
      expect(briefResponse(path, dir).status).toBe(404);
    }
  });
});
