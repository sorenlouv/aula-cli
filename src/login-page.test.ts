import { describe, expect, test } from 'bun:test';
import { startLoginPage } from './login-page.ts';
import { buildQrPayloads } from './vendor/aula-auth/mitid-poll-machine.ts';

const QR = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 7);

/** One poll, the way the page makes it. */
async function fetchState(url: string, since = 0): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/state?since=${since}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('login page', () => {
  test('serves the shell on the token path and nothing anywhere else', async () => {
    const page = startLoginPage();
    try {
      const origin = new URL(page.url).origin;

      const shell = await fetch(page.url);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('<title>MitID login — aula</title>');

      // The token is the access control, so every other spelling is a 404 —
      // including the one an unlucky guess would land on.
      for (const path of ['/', '/state', '/../etc/passwd', `/${crypto.randomUUID()}`]) {
        expect((await fetch(origin + path)).status).toBe(404);
      }
    } finally {
      page.close();
    }
  });

  test('binds loopback only', () => {
    const page = startLoginPage();
    try {
      expect(new URL(page.url).hostname).toBe('127.0.0.1');
    } finally {
      page.close();
    }
  });

  test('answers a client that is already current with a short body', async () => {
    const page = startLoginPage();
    try {
      const first = await fetchState(page.url);
      expect(first.kind).toBe('starting');

      const unchanged = await fetchState(page.url, first.rev as number);
      expect(unchanged).toEqual({ rev: first.rev, unchanged: true });

      page.update({ kind: 'otp', otp: '123456' });
      const next = await fetchState(page.url, first.rev as number);
      expect(next.kind).toBe('otp');
      expect(next.otp).toBe('123456');
      expect(next.rev).toBe((first.rev as number) + 1);
    } finally {
      page.close();
    }
  });

  test('renders the QR pair server-side, so the page needs no encoder', async () => {
    const page = startLoginPage();
    try {
      page.update({ kind: 'qr', qr1: QR.qr1Json, qr2: QR.qr2Json, updateCount: 7 });
      const state = await fetchState(page.url);

      expect(state.kind).toBe('qr');
      expect(state.updateCount).toBe(7);
      expect(state.svg1).toContain('<svg');
      // Both halves carry different data; one payload rendered twice would be a
      // symbol the app scans happily and MitID then rejects.
      expect(state.svg1).not.toBe(state.svg2);
      // The payload is drawn as geometry, never handed to the browser as text.
      expect(JSON.stringify(state)).not.toContain('a3f19c8e');
    } finally {
      page.close();
    }
  });

  test('carries the headers a page holding a channel binding should', async () => {
    const page = startLoginPage();
    try {
      const shell = await fetch(page.url);
      expect(shell.headers.get('cache-control')).toBe('no-store');
      expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
      expect(shell.headers.get('content-security-policy')).toContain("default-src 'none'");
    } finally {
      page.close();
    }
  });

  test('waits for the browser to collect the outcome, then stops serving', async () => {
    const page = startLoginPage();
    await fetchState(page.url); // a browser is now watching

    // The wait ends on the poll that collects the outcome, not on a timer, so
    // this resolves as soon as the page has seen it.
    const finished = page.finish({ ok: true, message: 'Tokens saved.' });
    const state = await fetchState(page.url);
    expect(state).toMatchObject({ kind: 'done', ok: true, message: 'Tokens saved.' });
    await finished;

    await expect(fetch(page.url)).rejects.toThrow();
  });

  test('does not wait when no browser ever connected', async () => {
    const page = startLoginPage();
    const started = Bun.nanoseconds();
    await page.finish({ ok: false, message: 'MitID user does not exist' });

    // A headless login should not pay for a page nobody opened.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(100);
    await expect(fetch(page.url)).rejects.toThrow();
  });
});
