/**
 * A local page that carries the parts of a MitID login a terminal cannot.
 *
 * MitID picks the channel-binding mode per account, and one of the two is
 * unusable when an agent is driving: in TQR mode the approval is *two* QR codes
 * that rotate every few seconds (see `qr.ts`), which cannot be relayed through
 * a chat transcript — by the time it is pasted it is stale, and it is a picture
 * either way. The OTP mode relays fine; the QR mode is the wall.
 *
 * So when nothing is watching stderr, the codes go where a human can still see
 * them: a page on 127.0.0.1, opened in the user's own browser, polling this
 * process for whatever MitID last said. The agent renders nothing and holds
 * nothing — it hands over a URL, and the user scans with the phone that was
 * always going to have to approve.
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

/** What MitID last told us, in the shape the page draws. */
export type LoginPageState =
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
 * `default-src 'none'` and nothing whitelisted but this page's own inline
 * script and style. There is no reason for a page holding a live channel
 * binding to be able to reach the network, and one line here is worth more than
 * trusting that the markup never grows a tag that can.
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
  | { kind: 'otp'; otp: string }
  | { kind: 'qr'; svg1: string; svg2: string; updateCount: number }
  | { kind: 'done'; ok: boolean; message: string }
) & { rev: number };

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

export function startLoginPage(initial: LoginPageState = { kind: 'starting' }): LoginPage {
  let rev = 1;
  let wire = toWire(initial, rev);

  // Whether anyone is on the other end. `finish()` waits for the browser only
  // if there has ever been one — a login nobody watched should not pay for it.
  let everPolled = false;
  let outcomeCollected: (() => void) | undefined;

  // A path nobody can guess, so "loopback" is not the whole of the access
  // control. 122 bits, and free.
  const token = randomUUID();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // Whatever is free: this is opened by URL, never typed from memory.
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === `/${token}`) {
        return new Response(SHELL(token), { headers: HTML_HEADERS });
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
    async finish(outcome) {
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
 * existence every rotation is a QR the phone keeps losing.
 */
const SHELL = (token: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MitID login — aula</title>
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
</style>
</head>
<body>
<main>
  <h1 id="headline">Contacting MitID…</h1>
  <p id="lede">Keep your phone nearby.</p>
  <div class="card" id="card"><p><span class="dot"></span>Waiting for MitID</p></div>
  <p class="meta" id="meta">Served by the login command on this machine. It closes itself when the login finishes.</p>
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
  // MitID said, and the OTP is compared digit by digit against a phone.
  function text(el, value) { el.textContent = value; }

  function say(title, lede_, cls) {
    text(headline, title);
    text(lede, lede_);
    headline.className = cls || '';
  }

  function render(state) {
    if (state.kind === 'starting') {
      say('Contacting MitID…', 'Keep your phone nearby.');
      card.innerHTML = '<p><span class="dot"></span>Waiting for MitID</p>';
    } else if (state.kind === 'otp') {
      say('Approve this code in the MitID app', 'Open MitID on your phone and check that it shows the same number.');
      card.innerHTML = '<div class="otp"></div>';
      text(card.firstChild, state.otp);
    } else if (state.kind === 'qr') {
      say('Scan with the MitID app', 'Point the app at both codes — they refresh together, which is normal.');
      // Server-rendered SVG from our own encoder; the payload it carries is
      // drawn as geometry, never interpolated into this markup.
      card.innerHTML = '<div class="codes">' + state.svg1 + state.svg2 + '</div>';
      text(meta, 'Refresh #' + state.updateCount + ' · the pair rotates every few seconds');
    } else if (state.kind === 'verified') {
      say('Channel verified', 'Now approve the login in your MitID app.');
      card.innerHTML = '<p><span class="dot"></span>Waiting for your approval</p>';
    } else if (state.kind === 'done') {
      say(state.ok ? 'Logged in' : 'Login failed', state.message, state.ok ? 'ok' : 'bad');
      card.innerHTML = '<p>You can close this page.</p>';
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
        say('Login session ended', 'The login command is no longer running. Start it again if you still need to log in.');
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
