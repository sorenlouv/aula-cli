/**
 * The compiled client, driven in a real DOM against a scripted server.
 *
 * `login-client-guard.test.ts` is a source scan: it proves the browser half is
 * TSX compiled by the macro, and nothing more. It cannot see behaviour, and the
 * two behaviours this port rests on are invisible to every other kind of check
 * the repo has:
 *
 * - The QR pair is keyed by *position*. Key it by payload instead and Preact
 *   remounts both hosts on every rotation — a blink twice a second, and a phone
 *   that loses the lock it had just got. `react(jsx-key)` sees a key either way
 *   and is satisfied; typecheck is satisfied; every server test still passes.
 * - The username field must survive a poll. The whole reason the old code
 *   patched nodes by hand was that a naive re-render throws away focus, the
 *   caret and whatever the parent had typed.
 *
 * Both are one-character regressions that nothing else in the repo would catch,
 * which is exactly what a behaviour test is for.
 *
 * This runs the REAL bundle — `clientScript()` is the same function the macro
 * calls, so what is exercised here is what gets served, not a re-implementation.
 * happy-dom's `Window` cannot help: it needs node:vm to run an injected
 * <script>, which Bun does not provide, so the globals are registered instead
 * and torn down in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Document, HTMLInputElement } from 'happy-dom';
import { clientScript } from './browser/bundle.ts';
import { POLL_MS } from './login-protocol.ts';

/** Long enough for at least two polls to have been answered. */
const SETTLE_MS = POLL_MS * 3;

const ORIGIN = 'http://127.0.0.1:56725';
const TOKEN = '866882f9-3d0b-40d3-a72b-51b4ad3a1339';

/**
 * The scripted server. `reply` is what the next poll gets; a test sets it and
 * then waits. `polls` is the evidence that the loop is actually running — an
 * assertion about focus surviving polling is worthless if no poll happened.
 */
let reply: unknown = { rev: 0, unchanged: true };
let polls = 0;

let doc: Document;

beforeAll(async () => {
  GlobalRegistrator.register({ url: `${ORIGIN}/${TOKEN}` });
  // The root project has no "dom" lib — deliberately, so server code cannot
  // reach for `document`. happy-dom's own types stand in for it here.
  doc = (globalThis as unknown as { document: Document }).document;

  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _url: string,
    init?: { method?: string; body?: string },
  ) => {
    // Answered, but not inspected: nothing here submits. The branch exists so a
    // stray submit fails as a rejected answer rather than as a torn-off stub.
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
    polls += 1;
    return { ok: true, json: async () => reply };
  };

  // The shell the server serves, reduced to what the client mounts into.
  doc.body.innerHTML = '<main id="root"></main>';

  reply = { kind: 'ask-username', rev: 1 };

  // Indirect eval so the bundle's bare `document` and `fetch` resolve to the
  // globals registered above — the same scope a <script> tag would give it.
  // oxlint-disable-next-line no-eval
  (0, eval)(clientScript());
  await settle();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function settle(ms = SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const usernameField = (): HTMLInputElement | null =>
  doc.querySelector('input[name="username"]') as HTMLInputElement | null;

describe('login client, in a DOM', () => {
  test('mounts the username form and puts the caret in it', () => {
    const field = usernameField();
    if (!field) throw new Error('the username field never mounted');
    expect(doc.activeElement).toBe(field);
  });

  test('a poll does not cost the parent what they had typed', async () => {
    const field = usernameField();
    if (!field) throw new Error('the username field never mounted');

    field.value = 'anna-eksempelsen';
    field.setSelectionRange(4, 4);

    // "Nothing new" is the steady state while someone is typing.
    reply = { rev: 1, unchanged: true };
    const before = polls;
    await settle();

    expect(polls).toBeGreaterThan(before);
    expect(usernameField()).toBe(field);
    expect(field.value).toBe('anna-eksempelsen');
    expect(field.selectionStart).toBe(4);
    expect(doc.activeElement).toBe(field);
  });

  test('a QR rotation swaps the payload without remounting the hosts', async () => {
    const code = (seed: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37"><rect width="${seed}"/></svg>`;

    reply = { kind: 'qr', svg1: code('a'), svg2: code('b'), updateCount: 1, rev: 2 };
    await settle();

    const hosts = [...doc.querySelectorAll('.code')];
    expect(hosts).toHaveLength(2);

    // Mark the live nodes. A remount throws these elements away, so the marks
    // going missing IS the blink — and it reports as ['0','1'] vs [null,null]
    // instead of dumping two DOM nodes into the failure.
    hosts.forEach((host, index) => host.setAttribute('data-probe', String(index)));

    // A rotation: same shape, new payload, new rev. This is what the server
    // sends every couple of seconds for the whole of a TQR login.
    reply = { kind: 'qr', svg1: code('c'), svg2: code('d'), updateCount: 2, rev: 3 };
    await settle();

    const after = [...doc.querySelectorAll('.code')];
    expect(after.map((host) => host.getAttribute('data-probe'))).toEqual(['0', '1']);
    expect(after[0]?.innerHTML).toContain('width="c"');
    expect(after[1]?.innerHTML).toContain('width="d"');
  });

  test('an unchanged poll writes nothing to the DOM at all', async () => {
    const svg = doc.querySelector('.code svg');
    expect(svg).not.toBeNull();

    reply = { rev: 3, unchanged: true };
    await settle();

    expect(doc.querySelector('.code svg')).toBe(svg);
  });

  test('the live region is mounted once and never replaced', async () => {
    const announcer = doc.querySelector('output[aria-live="polite"]');
    expect(announcer).not.toBeNull();

    reply = { kind: 'verified', rev: 4 };
    await settle();

    expect(doc.querySelector('output[aria-live="polite"]')).toBe(announcer);
  });

  test('the outcome stops the poll loop, and leaves no empty card behind', async () => {
    reply = {
      kind: 'done',
      ok: true,
      message: 'Du kan lukke vinduet.',
      rev: 5,
    };
    await settle();

    expect(doc.getElementById('root')?.textContent).toContain('Du kan lukke vinduet.');
    expect(doc.querySelector('.card')).toBeNull();

    // The latch: a page that keeps polling a dead port is how the old code
    // ended a finished login on a connection error.
    const after = polls;
    await settle();
    expect(polls).toBe(after);
  });
});
