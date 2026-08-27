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
 * How often the browser asks for the current state.
 *
 * MitID's own poll runs at 1s and rotates the QR pair every few of those. Twice
 * that rate keeps a rotation from being visibly late, and a poll that finds
 * nothing new costs one small JSON body — see `since`.
 */
const POLL_MS = 500;

/**
 * How long `finish()` will wait for the browser to collect the outcome.
 *
 * Only ever reached when the tab was closed between the last poll and the end
 * of the login, so it is a ceiling on a case nobody is watching, not a delay
 * anybody pays in the normal flow.
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
 * than as a form — see the comment on that call. `connect-src 'self'` is what
 * lets it.
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

/**
 * The state as the browser receives it: QR payloads already rendered.
 *
 * Rendering server-side is what keeps a QR library out of the page, and `rev`
 * is what keeps the rendering out of the poll — a client that already has
 * revision N is answered with four bytes instead of two encoded symbols.
 */
type WireState = (
  | { kind: 'starting' | 'verified' }
  | { kind: 'ask-username'; error?: string }
  | { kind: 'ask-identity'; options: string[]; error?: string }
  | { kind: 'otp'; otp: string }
  | { kind: 'qr'; svg1: string; svg2: string; updateCount: number }
  | { kind: 'done'; ok: boolean; message: string }
) & { rev: number };

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
    svg1: qrSvg(state.qr1, { title: 'MitID code 1 of 2' }),
    svg2: qrSvg(state.qr2, { title: 'MitID code 2 of 2' }),
    updateCount: state.updateCount,
    rev,
  };
}

function inputResponse(status: number, body: Record<string, unknown>): Response {
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
        return new Response(SHELL(token), { headers: HTML_HEADERS });
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
          const body = JSON.stringify({ rev: wire.rev, unchanged: true });
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
    server.stop(true);
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
 * The page itself: one shell, patched in place by the poll.
 *
 * Reloading instead would be simpler and wrong — a QR that blinks out of
 * existence every rotation is a QR the phone keeps losing, and a reload between
 * the form and the approval would throw away the field the user is typing in.
 *
 * Everything the reader sees here is Danish: the reader is a parent, and this
 * page is the only surface of the login they ever touch.
 */
const SHELL = (token: string) => `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MitID-login — aula</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%234f46e5'/></svg>">
<style>
  :root {
    --bg:#faf8f5; --panel:#fff; --ink:#1c1a17; --ink-2:#57534e; --ink-3:#8a837c;
    --line:#e7e2db; --accent:#4f46e5; --ok:#0d9488; --bad:#be123c;
    --shadow:0 1px 2px rgba(28,26,23,.04),0 4px 16px -6px rgba(28,26,23,.10);
  }
  @media (prefers-color-scheme:dark) {
    :root {
      --bg:#16151a; --panel:#1e1d23; --ink:#f0eeea; --ink-2:#b4afa8; --ink-3:#807b74;
      --line:#302e37; --accent:#a5a0fb; --ok:#5eead4; --bad:#fda4af;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px -6px rgba(0,0,0,.5);
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex; min-height:100vh; align-items:center; justify-content:center; padding:1.5rem;
  }
  main { width:100%; max-width:44rem; text-align:center; }
  h1 { font-size:1.35rem; margin:0 0 .35rem; letter-spacing:-.01em; }
  h1.ok { color:var(--ok); } h1.bad { color:var(--bad); }
  p { margin:.35rem 0; color:var(--ink-2); }
  .card {
    background:var(--panel); border:1px solid var(--line); border-radius:16px;
    box-shadow:var(--shadow); padding:1.75rem 1.5rem; margin-top:1.25rem;
  }
  /* The symbols stay dark-on-light in both themes — the SVG paints its own
     white ground, and this padding keeps a dark page off the quiet zone that
     scanners measure the edges from. */
  .codes { display:flex; gap:1rem; justify-content:center; flex-wrap:wrap; }
  .codes svg { width:min(15rem,40vw); height:auto; background:#fff; border-radius:10px; padding:.35rem; }
  .otp {
    font:700 clamp(2.5rem,12vw,4rem)/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.12em; color:var(--accent); margin:.5rem 0;
  }
  .meta { color:var(--ink-3); font-size:.85rem; margin-top:1rem; }
  .dot { display:inline-block; width:.5rem; height:.5rem; border-radius:50%;
    background:var(--accent); margin-right:.4rem; animation:pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.2; } }
  @media (prefers-reduced-motion:reduce) { .dot { animation:none; } }
  /* The ask states: a form is read left-to-right, not centred like a code. */
  .field { display:block; text-align:left; }
  .field .label { display:block; font-weight:600; color:var(--ink); }
  .field .hint { display:block; color:var(--ink-3); font-size:.85rem; margin:.15rem 0 .7rem; }
  .field input {
    width:100%; padding:.7rem .8rem; border-radius:10px; color:var(--ink);
    font:inherit; background:var(--bg); border:1px solid var(--line);
  }
  .field input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .options { display:flex; flex-direction:column; gap:.5rem; text-align:left; }
  .option {
    display:flex; gap:.65rem; align-items:center; padding:.7rem .8rem;
    border:1px solid var(--line); border-radius:10px; cursor:pointer;
  }
  .option:has(input:checked) { border-color:var(--accent); }
  .go {
    margin-top:1rem; width:100%; padding:.7rem 1rem; border:0; border-radius:10px;
    font-family:inherit; font-size:1rem; font-weight:600; cursor:pointer;
    /* Text in the page background colour, so the contrast holds in both
       themes — the accent is dark in one and pale in the other. */
    color:var(--bg); background:var(--accent);
  }
  .go:disabled, .field input:disabled { opacity:.55; cursor:default; }
  .error { color:var(--bad); font-size:.9rem; margin-top:.75rem; text-align:left; }
</style>
</head>
<body>
<main>
  <h1 id="headline">Log ind med MitID</h1>
  <p id="lede">Et øjeblik…</p>
  <div class="card" id="card"><p><span class="dot"></span>Henter</p></div>
  <p class="meta" id="meta"></p>
</main>
<script>
(function () {
  var headline = document.getElementById('headline');
  var lede = document.getElementById('lede');
  var card = document.getElementById('card');
  var meta = document.getElementById('meta');


  var rev = 0;
  var timer = null;
  var stopped = false;

  // Text from the process, never markup: the outcome message carries whatever
  // MitID said, the identity names come off the wire, and the OTP is compared
  // digit by digit against a phone.
  function text(el, value) { el.textContent = value; }

  function say(title, lede_, cls) {
    text(headline, title);
    text(lede, lede_);
    headline.className = cls || '';
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function make(tag, cls, value) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function errorBox(message) {
    var box = make('p', 'error', message || '');
    if (!message) box.hidden = true;
    return box;
  }

  function busy(controls, value) {
    for (var i = 0; i < controls.length; i++) controls[i].disabled = value;
  }

  function submit(value, controls, box) {
    busy(controls, true);
    box.hidden = true;
    // Sent with fetch, never as a native form submit. The CSP this page is
    // served with sets form-action 'none', so a <form> would be blocked with
    // nothing on screen to explain it — the button would simply do nothing.
    // connect-src 'self' is what permits this call. Do not "simplify" it back
    // into a form.
    fetch('/${token}/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: String(value) }),
      cache: 'no-store'
    })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        // Accepted: the controls stay disabled and the next poll paints
        // whatever the login does with the value.
        if (body && body.ok) { schedule(0); return; }
        busy(controls, false);
        text(box, (body && body.error) || 'Der skete en fejl. Prøv igen.');
        box.hidden = false;
      })
      .catch(function () {
        busy(controls, false);
        text(box, 'Kunne ikke sende svaret. Prøv igen.');
        box.hidden = false;
      });
  }

  function renderUsername(state) {
    say('Log ind med MitID', 'Du skal bruge MitID til at logge ind på Aula.');
    clear(card);

    var field = make('label', 'field');
    field.appendChild(make('span', 'label', 'MitID-brugernavn'));
    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'username';
    input.autocomplete = 'username';
    // A MitID username is not a word: a phone keyboard would otherwise
    // capitalise the first letter and autocorrect the rest of it.
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    field.appendChild(input);
    card.appendChild(field);

    var button = make('button', 'go', 'Fortsæt');
    card.appendChild(button);
    var box = errorBox(state.error);
    card.appendChild(box);

    function send() { submit(input.value, [input, button], box); }
    button.addEventListener('click', send);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') send();
    });
    input.focus();
  }

  function renderIdentity(state) {
    say('Vælg, hvem du logger ind som', 'MitID gav mere end én mulighed for dit login.');
    clear(card);

    var list = make('div', 'options');
    var radios = [];
    for (var i = 0; i < state.options.length; i++) {
      var row = make('label', 'option');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'identity';
      // 1-based, because that is the numbering MitID's own option list uses.
      radio.value = String(i + 1);
      if (i === 0) radio.checked = true;
      row.appendChild(radio);
      row.appendChild(make('span', 'option-name', state.options[i]));
      list.appendChild(row);
      radios.push(radio);
    }
    card.appendChild(list);

    var button = make('button', 'go', 'Fortsæt');
    card.appendChild(button);
    var box = errorBox(state.error);
    card.appendChild(box);

    button.addEventListener('click', function () {
      var picked = '';
      for (var j = 0; j < radios.length; j++) {
        if (radios[j].checked) picked = radios[j].value;
      }
      submit(picked, radios.concat([button]), box);
    });
  }

  function render(state) {
    // Only the QR state writes a meta line; clearing it everywhere else keeps
    // a rotation counter from outliving the codes.
    if (state.kind !== 'qr') text(meta, '');

    if (state.kind === 'ask-username') {
      renderUsername(state);
    } else if (state.kind === 'ask-identity') {
      renderIdentity(state);
    } else if (state.kind === 'starting') {
      say('Kontakter MitID…', 'Åbn MitID på din telefon.');
      card.innerHTML = '<p><span class="dot"></span>Venter på MitID</p>';
    } else if (state.kind === 'otp') {
      say('Godkend denne kode i MitID-appen', 'Åbn MitID på din telefon, og tjek at den viser det samme tal.');
      card.innerHTML = '<div class="otp"></div>';
      text(card.firstChild, state.otp);
    } else if (state.kind === 'qr') {
      say('Scan med MitID-appen', 'Hold appen op mod begge koder — de skifter samtidig, og det er meningen.');
      // Server-rendered SVG from our own encoder; the payload it carries is
      // drawn as geometry, never interpolated into this markup.
      card.innerHTML = '<div class="codes">' + state.svg1 + state.svg2 + '</div>';
      text(meta, 'Opdatering #' + state.updateCount + ' · parret skifter hvert par sekunder');
    } else if (state.kind === 'verified') {
      say('Kanalen er bekræftet', 'Godkend nu dit login i MitID-appen.');
      card.innerHTML = '<p><span class="dot"></span>Venter på din godkendelse</p>';
    } else if (state.kind === 'done') {
      say(state.ok ? 'Du er logget ind' : 'Login mislykkedes', state.message, state.ok ? 'ok' : 'bad');
      card.innerHTML = '<p>Du kan lukke siden nu.</p>';
      text(meta, '');
      return true;
    }
    return false;
  }

  var failures = 0;

  function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  function poll() {
    if (stopped) return;
    fetch('/${token}/state?since=' + rev, { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (state) {
        failures = 0;
        rev = state.rev;
        if (!state.unchanged && render(state)) { stopped = true; return; }
        schedule(${POLL_MS});
      })
      .catch(function () {
        // One dropped request is not the end of the login. Three in a row means
        // the command exited, which is worth saying rather than spinning
        // against a dead port.
        if (++failures < 3) return schedule(${POLL_MS});
        stopped = true;
        say('Login-sessionen er slut', 'Login-kommandoen kører ikke længere. Start den igen, hvis du stadig vil logge ind.');
        card.innerHTML = '';
        text(meta, '');
      });
  }

  // Background tabs get their timers throttled to about once a minute, so a
  // tab coming back to the front would otherwise show a stale code for as long
  // as that took to notice.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) schedule(0);
  });

  poll();
})();
</script>
</body>
</html>
`;
