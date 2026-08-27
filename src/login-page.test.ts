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

/** One submit, the way the page makes it — overrides are how a test misbehaves. */
async function postInput(
  url: string,
  value: string,
  overrides: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const init: RequestInit = {
    method: overrides.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...overrides.headers },
  };
  if (init.method !== 'GET') init.body = overrides.body ?? JSON.stringify({ value });
  return fetch(`${url}/input`, init);
}

describe('login page', () => {
  test('serves the shell on the token path and nothing anywhere else', async () => {
    const page = startLoginPage();
    try {
      const origin = new URL(page.url).origin;

      const shell = await fetch(page.url);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('<title>MitID-login — aula</title>');

      // The token is the access control, so every other spelling is a 404 —
      // including the one an unlucky guess would land on, and including the
      // input endpoint, which is a 404 before it is anything else.
      for (const path of [
        '/',
        '/state',
        '/input',
        '/../etc/passwd',
        `/${crypto.randomUUID()}`,
        `/${crypto.randomUUID()}/input`,
      ]) {
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

  test('opens on the username form, before any MitID session exists', async () => {
    const page = startLoginPage();
    try {
      // The whole point of the change: the page is up and asking while nothing
      // MitID-side has started ticking.
      expect((await fetchState(page.url)).kind).toBe('ask-username');
    } finally {
      page.close();
    }
  });

  test('ships its whole client inline, and never a password field', async () => {
    const page = startLoginPage();
    try {
      const html = await (await fetch(page.url)).text();

      // A hard rule from AGENTS.md: this tool never performs a MitID approval
      // and never handles a secret. Everything secret happens on the user's own
      // phone, so a password input on this page would always be a phishing
      // surface — there is no legitimate reason for one to appear.
      //
      // Asserted on the attribute's *value*, not on `type="password"`. This
      // page no longer serves markup: JSX compiles an attribute to an object
      // property, so the HTML spelling cannot appear in these bytes even when
      // the field does — the old assertion could not fail any more. A minifier
      // renames identifiers and preserves string literals, so the value is the
      // one thing a password field must leave behind.
      expect(html).not.toMatch(/password|adgangskode/i);

      // Anchored on copy only the compiled client carries, because the
      // assertion above is equally true of a page that inlined nothing — which
      // is exactly what a silently failed macro would serve.
      expect(html).toContain('MitID-brugernavn');

      // The client is inline under `script-src 'unsafe-inline'`, so it is
      // parsed as part of this document: one `</script>` inside it ends the
      // script early and the rest of the client becomes text on the page. The
      // macro refuses such a bundle at transpile time; this is the same fact
      // checked on the bytes that actually reach a browser.
      expect(html.match(/<\/script/gi)).toHaveLength(1);

      // `default-src 'none'` is worth only what the markup asks for: nothing on
      // this page may be fetched from anywhere.
      expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
      expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    } finally {
      page.close();
    }
  });

  test('answers a client that is already current with a short body', async () => {
    const page = startLoginPage({ kind: 'starting' });
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

describe('login page input', () => {
  test('a submitted username resolves the ask and moves the page on', async () => {
    const page = startLoginPage();
    try {
      const asked = page.askUsername();
      const armed = await fetchState(page.url);
      expect(armed.kind).toBe('ask-username');

      const response = await postInput(page.url, '  eksempelforaelder  ');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      // Trimmed, because a copied username brings a space with it often enough.
      expect(await asked).toBe('eksempelforaelder');

      // The page must not be left on a form whose submit is now a 409.
      const after = await fetchState(page.url, armed.rev as number);
      expect(after.kind).toBe('starting');
      expect(after.rev).toBe((armed.rev as number) + 1);
    } finally {
      page.close();
    }
  });

  test('re-asking carries the error onto the form', async () => {
    const page = startLoginPage({ kind: 'starting' });
    try {
      void page.askUsername({ error: 'MitID kender ikke det brugernavn.' });
      const state = await fetchState(page.url);
      expect(state).toMatchObject({
        kind: 'ask-username',
        error: 'MitID kender ikke det brugernavn.',
      });
    } finally {
      page.close();
    }
  });

  test('an unusable value is answered inline and leaves the ask armed', async () => {
    const page = startLoginPage();
    try {
      const asked = page.askUsername();

      const rejected = await postInput(page.url, '   ');
      // 200 with ok:false, not a 4xx: the page shows the message beside the
      // field, and the CLI never hears about a value it cannot use.
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ ok: false });

      // Still armed, so the typo can simply be corrected.
      const second = await postInput(page.url, 'eksempelforaelder');
      expect(await second.json()).toEqual({ ok: true });
      expect(await asked).toBe('eksempelforaelder');
    } finally {
      page.close();
    }
  });

  test('a second submit with nothing armed is a 409, not a race', async () => {
    const page = startLoginPage();
    try {
      const asked = page.askUsername();
      expect((await postInput(page.url, 'eksempelforaelder')).status).toBe(200);
      await asked;

      const again = await postInput(page.url, 'en-anden-bruger');
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ ok: false });
    } finally {
      page.close();
    }
  });

  test('a submit that lands after the outcome cannot overwrite it', async () => {
    const page = startLoginPage();
    await fetchState(page.url); // a browser is watching, so finish() waits for one

    // The deadline expiring while the parent is mid-click: the ask is still
    // armed when the login gives up and publishes why it did.
    void page.askIdentity(['Alma Eksempelsen', 'Viggo Eksempelsen']);
    const finished = page.finish({ ok: false, message: 'Der gik for lang tid.' });

    expect((await postInput(page.url, '1')).status).toBe(409);

    // The Danish explanation is the only account of the failure the parent
    // gets, so it has to survive the late submit rather than being replaced by
    // the spinner that accepting one would show.
    const state = await fetchState(page.url);
    expect(state).toMatchObject({ kind: 'done', ok: false, message: 'Der gik for lang tid.' });
    await finished;
  });

  test('rejects anything but a same-host JSON POST', async () => {
    const page = startLoginPage();
    try {
      void page.askUsername();

      // A GET would put the username in browser history and every log on the
      // way; the page only ever POSTs.
      expect((await postInput(page.url, 'x', { method: 'GET' })).status).toBe(405);

      // Not a CORS-safelisted content type, so a cross-origin page cannot send
      // it without a preflight this server never answers — and a plain
      // cross-origin <form> cannot send it at all.
      expect(
        (
          await postInput(page.url, 'x', {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          })
        ).status,
      ).toBe(415);

      // DNS rebinding: an attacker's domain pointed at 127.0.0.1 is
      // same-origin to the browser, but it cannot forge the Host header.
      expect((await postInput(page.url, 'x', { headers: { host: 'aula.example' } })).status).toBe(
        403,
      );

      // The body is read into a string before anything is decided about it.
      expect((await postInput(page.url, 'x', { body: 'x'.repeat(4096) })).status).toBe(413);
    } finally {
      page.close();
    }
  });

  test('the identity picker round-trips a 1-based index', async () => {
    const page = startLoginPage({ kind: 'starting' });
    try {
      const options = ['Alma Eksempelsen — forælder', 'Viggo Eksempelsen — forælder'];
      const asked = page.askIdentity(options);
      expect(await fetchState(page.url)).toMatchObject({ kind: 'ask-identity', options });

      // 1-based, because that is what `IdentityOption.index` and the vendored
      // `selectIdentity` callback are matched on — an off-by-one here logs in
      // as the wrong person rather than failing.
      expect((await postInput(page.url, '2')).status).toBe(200);
      expect(await asked).toBe(2);
    } finally {
      page.close();
    }
  });

  test('an out-of-range identity is answered inline and leaves the ask armed', async () => {
    const page = startLoginPage({ kind: 'starting' });
    try {
      const asked = page.askIdentity(['Alma Eksempelsen — forælder']);

      for (const value of ['0', '2', '1.5', 'first', '']) {
        const rejected = await postInput(page.url, value);
        expect(rejected.status).toBe(200);
        expect(await rejected.json()).toMatchObject({ ok: false });
      }

      expect((await postInput(page.url, '1')).status).toBe(200);
      expect(await asked).toBe(1);
    } finally {
      page.close();
    }
  });
});
