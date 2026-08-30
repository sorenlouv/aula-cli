/**
 * A local page that carries the parts of a MitID login a terminal cannot.
 *
 * Two of them, and they bracket the login. At the front, the MitID username:
 * asking for it in a chat transcript splits the login across two surfaces and,
 * worse, means the MitID session is already ticking while the user goes looking
 * for the link — an aged, abandoned session is what trips the CAP008
 * parallel-session detector. At the back, the approval itself: MitID picks the
 * channel-binding mode per account, and in TQR mode it is *two* QR codes that
 * rotate every few seconds, which cannot be relayed through a chat — by the
 * time it is pasted it is stale, and it is a picture either way.
 *
 * So the whole human half happens here: a page on 127.0.0.1, opened in the
 * user's own browser, that types back what it collects and polls this process
 * for whatever MitID last said. The agent renders nothing and holds nothing —
 * it hands over a URL, and the user scans with the phone that was always going
 * to have to approve.
 *
 * This file is only half of that page. It owns the socket, the path token, the
 * one-question-at-a-time state machine and the lifetime; everything that runs
 * in the browser lives in `src/browser`, written in Preact and TSX and turned
 * into a finished script by the macro in `src/browser/bundle.ts` — at transpile
 * time, because a `--compile` binary has no source tree left to bundle from.
 * The shell served below is a skeleton the client mounts into.
 *
 * The two halves meet at `src/login-protocol.ts` and nowhere else. It is the
 * only module both programs compile, which is what makes the wire a type each
 * side is checked against rather than a comment on this one and a run of string
 * comparisons on the other.
 *
 * Three deliberate constraints:
 *
 * - **Loopback only.** The state carries a live channel binding, and a bare
 *   port is reachable by the whole LAN.
 * - **Behind an unguessable path.** Every other process on this machine can
 *   reach loopback too.
 * - **As long as the login, and no longer.** The server is started per attempt
 *   and stopped by `finish()`.
 *
 * Polling rather than SSE or a socket: a rotation is worth at most half a
 * second of latency, and a poll has no reconnect story to get wrong when the
 * laptop sleeps mid-login — which, on the machine this tool runs on, it does.
 */

import { randomUUID } from 'node:crypto';
// Runs during transpile and returns a string literal, so what is imported here
// costs the running program nothing: by the time the page is served there is no
// bundler left, only the finished blobs. `login.ts` reaches this module through
// a dynamic import, which is what keeps that work off every other command.
import { clientScript, clientStyles } from './browser/bundle.ts' with { type: 'macro' };
import { POLL_MS, type InputReply, type PollResponse, type WireState } from './login-protocol.ts';
import { qrSvg } from './qr-svg.ts';

/** What the page draws: either a question for the user, or what MitID last said. */
export type LoginPageState =
  | { kind: 'ask-username'; error?: string }
  | { kind: 'ask-identity'; options: string[]; error?: string }
  | { kind: 'starting' }
  | { kind: 'otp'; otp: string }
  | { kind: 'qr'; qr1: string; qr2: string; updateCount: number }
  | { kind: 'verified' };

/** How the attempt ended. Terminal: the page stops polling once it has this. */
export type LoginPageOutcome = { ok: boolean; message: string };

export type LoginPage = {
  /** Hand this to the user — it already carries the path token. */
  url: string;
  update(state: LoginPageState): void;
  /**
   * Shows the username form and resolves with what the user typed, trimmed.
   *
   * `error` re-asks with the message shown on the form — that is how a MitID
   * `identity_not_found` becomes a corrected typo rather than a dead login.
   */
  askUsername(opts?: { error?: string }): Promise<string>;
  /**
   * Shows the identity picker and resolves with a **1-based** index into
   * `options` — the numbering `IdentityOption.index` uses, which is what the
   * vendored `selectIdentity` callback is matched against.
   */
  askIdentity(options: string[], opts?: { error?: string }): Promise<number>;
  /**
   * Shows the outcome, waits for the browser to actually pick it up, then stops
   * serving. Resolves immediately when no browser ever connected.
   */
  finish(outcome: LoginPageOutcome): Promise<void>;
  /** Stops serving without waiting. `finish()` is the normal ending. */
  close(): void;
};

/**
 * How long `finish()` will wait for the browser to collect the outcome.
 *
 * Only ever reached when the tab was closed between the last poll and the end
 * of the login, so it is a ceiling on a case nobody is watching, not a delay
 * anybody pays in the normal flow.
 *
 * Derived from the client's own cadence rather than restated: four polls is a
 * ceiling only as long as both halves agree on how long a poll is, and the
 * shared constant is what stops one of them drifting alone.
 */
const SETTLE_CEILING_MS = POLL_MS * 4;

/**
 * Grace between the poll that collects the outcome and the socket closing.
 *
 * Returning a `Response` from the handler is not the same as the browser having
 * received it, and the stop below is a *force* close. Without this the last
 * poll of a successful login can be cut off mid-body, and the page ends on
 * "session ended" — the exact failure the wait exists to prevent.
 */
const OUTCOME_FLUSH_MS = 50;

/**
 * Ceiling on a submitted body.
 *
 * A MitID username is a couple of dozen characters and an identity choice is a
 * single digit, so anything approaching a kilobyte is not this page's form. The
 * point is not the memory, it is that the handler reads the body into a string
 * before it has decided anything about the request.
 */
const MAX_INPUT_BYTES = 1024;

/**
 * `default-src 'none'` and nothing whitelisted but this page's own inline
 * script and style. There is no reason for a page holding a live channel
 * binding to be able to reach the network, and one line here is worth more than
 * trusting that the markup never grows a tag that can.
 *
 * `form-action 'none'` is why the username form submits with `fetch()` rather
 * than as a form — see the comment on that call in `src/browser/session.ts`.
 * `connect-src 'self'` is what lets it.
 *
 * Both inline allowances are spent on build output and nothing else: one script
 * and one stylesheet, produced by the macro and checked there for a sequence
 * that could end its own tag. Neither carries a byte of runtime data, so there
 * is no interpolation on this page for `'unsafe-inline'` to make dangerous.
 */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src data:', // the favicon, and nothing else
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const HTML_HEADERS = {
  ...COMMON_HEADERS,
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
};

const JSON_HEADERS = { ...COMMON_HEADERS, 'content-type': 'application/json' };

/** The question the page is currently showing, and where its answer goes. */
type PendingAsk =
  | { kind: 'username'; resolve: (value: string) => void }
  | { kind: 'identity'; count: number; resolve: (index: number) => void };

function toWire(
  state: LoginPageState | ({ kind: 'done' } & LoginPageOutcome),
  rev: number,
): WireState {
  if (state.kind !== 'qr') return { ...state, rev };
  return {
    kind: 'qr',
    // The SVG's accessible name, i.e. UI, on a page whose reader is a parent.
    svg1: qrSvg(state.qr1, { title: 'MitID-kode 1 af 2' }),
    svg2: qrSvg(state.qr2, { title: 'MitID-kode 2 af 2' }),
    updateCount: state.updateCount,
    rev,
  };
}

function inputResponse(status: number, body: InputReply): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function startLoginPage(initial: LoginPageState = { kind: 'ask-username' }): LoginPage {
  let rev = 1;
  let wire = toWire(initial, rev);

  // Whether anyone is on the other end. `finish()` waits for the browser only
  // if there has ever been one — a login nobody watched should not pay for it.
  let everPolled = false;
  let outcomeCollected: (() => void) | undefined;
  let pending: PendingAsk | undefined;

  // Set the instant `finish()` publishes an outcome, because the wire state is
  // terminal from then on. A deadline that expires while the parent is mid-
  // click rejects the *ask* without disarming the slot, so their submit can
  // still land in the settle window — and `accept()` would push the page back
  // to `starting`, burying the Danish explanation of what went wrong under a
  // spinner and then, once the port dies, under the generic "session ended".
  let finished = false;

  // A path nobody can guess, so "loopback" is not the whole of the access
  // control. 122 bits, and free.
  const token = randomUUID();

  /**
   * Arms the one question slot and pushes the matching state.
   *
   * Bumping `rev` here is the whole delivery mechanism: the poll the browser is
   * already running notices the new revision and draws the form. There is no
   * second channel to keep in step.
   */
  const arm = (slot: PendingAsk, state: LoginPageState) => {
    // One at a time. Two armed slots would mean a submitted value resolving
    // whichever ask happened to be stored last, which is a login that logs in
    // as the wrong person rather than one that fails.
    if (pending) throw new Error('login page: an ask is already pending');
    pending = slot;
    wire = toWire(state, ++rev);
  };

  /**
   * The question is answered: disarm, and move the page on.
   *
   * Left on the ask state, a second tab — or this one after a refresh — would
   * go on showing a form whose submit is now a 409. `starting` is true from the
   * moment the value is accepted, since the caller's next act is to use it.
   */
  const accept = () => {
    pending = undefined;
    wire = toWire({ kind: 'starting' }, ++rev);
  };

  async function handleInput(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      // A GET would carry the username in the URL, which is browser history
      // and every log between here and nowhere. The page only ever POSTs.
      return inputResponse(405, { ok: false, error: 'Forkert metode.' });
    }

    // `application/json` is not a CORS-safelisted content type, so a page on
    // another origin is forced into a preflight that this server never answers
    // — and a plain cross-origin `<form>` cannot produce this header at all.
    // That is what makes the check a guard and not a formality.
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (contentType.toLowerCase() !== 'application/json') {
      return inputResponse(415, { ok: false, error: 'Forkert indholdstype.' });
    }

    // DNS rebinding: an attacker's domain can be made to resolve to 127.0.0.1,
    // and their page is then same-origin with this one as far as the browser is
    // concerned. The one thing it cannot forge is the Host header.
    if (request.headers.get('host') !== `127.0.0.1:${server.port}`) {
      return inputResponse(403, { ok: false, error: 'Forkert vært.' });
    }

    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES) {
      return inputResponse(413, { ok: false, error: 'Svaret er for stort.' });
    }
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      return inputResponse(413, { ok: false, error: 'Svaret er for stort.' });
    }

    // Read the body first, then look at the slot. `await` is a yield point, so
    // a check made before it would let two double-clicked submits both pass
    // and both resolve; after it, disarming is one uninterrupted step.
    const ask = pending;
    if (finished || !ask) {
      return inputResponse(409, { ok: false, error: 'Der er ikke noget at svare på lige nu.' });
    }

    let value: unknown;
    try {
      value = (JSON.parse(body) as { value?: unknown }).value;
    } catch {
      return inputResponse(400, { ok: false, error: 'Kunne ikke læse svaret.' });
    }
    if (typeof value !== 'string') {
      return inputResponse(400, { ok: false, error: 'Kunne ikke læse svaret.' });
    }

    if (ask.kind === 'username') {
      const username = value.trim();
      // Caught here rather than in the CLI, and answered without disarming: an
      // empty identityClaim would spend a whole MitID session to earn a generic
      // error, and a spent session is the thing this design exists to avoid.
      if (username === '') {
        return inputResponse(200, { ok: false, error: 'Skriv dit MitID-brugernavn.' });
      }
      accept();
      ask.resolve(username);
      return inputResponse(200, { ok: true });
    }

    const choice = Number(value);
    if (!Number.isInteger(choice) || choice < 1 || choice > ask.count) {
      return inputResponse(200, { ok: false, error: 'Vælg en af mulighederne.' });
    }
    accept();
    ask.resolve(choice);
    return inputResponse(200, { ok: true });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // Whatever is free: this is opened by URL, never typed from memory.
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === `/${token}`) {
        return new Response(SHELL, { headers: HTML_HEADERS });
      }

      if (url.pathname === `/${token}/input`) {
        return handleInput(request);
      }

      if (url.pathname === `/${token}/state`) {
        everPolled = true;
        if (wire.kind === 'done') {
          const collected = outcomeCollected;
          setTimeout(() => collected?.(), OUTCOME_FLUSH_MS);
        }

        // The client tells us what it already has. Unchanged is the common
        // answer — a rotation is a handful of polls apart.
        const since = Number(url.searchParams.get('since'));
        if (since === wire.rev) {
          const body = JSON.stringify({ rev: wire.rev, unchanged: true } satisfies PollResponse);
          return new Response(body, { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(wire), { headers: JSON_HEADERS });
      }

      return new Response('Not found', { status: 404, headers: COMMON_HEADERS });
    },
  });

  const close = () => {
    // `true` closes live connections too — without it an in-flight poll can
    // hold the process open after the login has already returned.
    // `void`: stop() is async in Bun and nothing here waits on it — the close
    // is fire-and-forget by design, and saying so is what stops the linter
    // reading it as a forgotten await.
    void server.stop(true);
  };

  return {
    url: `http://127.0.0.1:${server.port}/${token}`,
    update(state) {
      wire = toWire(state, ++rev);
    },
    askUsername(opts) {
      return new Promise<string>((resolve) => {
        arm(
          { kind: 'username', resolve },
          { kind: 'ask-username', ...(opts?.error === undefined ? {} : { error: opts.error }) },
        );
      });
    },
    askIdentity(options, opts) {
      return new Promise<number>((resolve) => {
        arm(
          { kind: 'identity', count: options.length, resolve },
          {
            kind: 'ask-identity',
            options,
            ...(opts?.error === undefined ? {} : { error: opts.error }),
          },
        );
      });
    },
    async finish(outcome) {
      // Both before the state changes. Clearing the slot is what makes a late
      // submit a plain 409 rather than a value nobody is waiting for, and the
      // promise it would have resolved is simply left unresolved — whoever was
      // awaiting it is already in the catch that led here.
      finished = true;
      pending = undefined;
      wire = toWire({ kind: 'done', ...outcome }, ++rev);
      if (everPolled) {
        await Promise.race([
          new Promise<void>((resolve) => {
            outcomeCollected = resolve;
          }),
          Bun.sleep(SETTLE_CEILING_MS),
        ]);
      }
      close();
    },
    close,
  };
}

/**
 * Compiled during transpile, inlined here as literals.
 *
 * Both are build output with no runtime input of any kind, and the macro has
 * already refused either of them if it contained a sequence that could end its
 * own tag. That check belongs there rather than here: it fails on the machine
 * doing the building instead of on a parent's screen, mid-login.
 */
const STYLES: string = clientStyles();
const CLIENT: string = clientScript();

/**
 * The page as it arrives on the wire: a skeleton and the client that fills it.
 *
 * Nothing here is rendered twice. Everything the reader sees is drawn into
 * `#root` by the bundle — which is why this markup can be read at a glance and
 * the 200 lines of DOM-patching it replaced could not. The one thing the shell
 * still owns is the case where the bundle never runs at all.
 *
 * A constant rather than a function of the token, and that is load-bearing: the
 * server matches paths by string equality, so this page can only ever load at
 * `/${token}`, and the client reads its own base from `location.pathname`. With
 * nothing interpolated, there is nothing on this page left to escape.
 */
const SHELL = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MitID-login — aula</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%234f46e5'/></svg>">
<style>${STYLES}</style>
</head>
<body>
<main id="root"></main>
<noscript>
  <p class="noscript">Denne side kan ikke vise MitID-koderne uden JavaScript. Slå det til, og hent siden igen — eller afbryd login i terminalen.</p>
</noscript>
<script>${CLIENT}</script>
</body>
</html>
`;
