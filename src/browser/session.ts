/**
 * The poll loop, and everything on this page that is not rendering.
 *
 * It lives outside the component tree deliberately. The hard requirement is
 * *exactly one loop, and never a poll after `done`*: a `useEffect` with an
 * empty dependency array is a promise about a dependency array, while a closure
 * started once from module scope is a structural guarantee that nothing in the
 * tree can restart.
 *
 * Everything it hands the UI is already a finished state. There is no path here
 * that reaches into the DOM, which is what makes the render a pure function of
 * one value and retires the whole class of bug the old client had — a node left
 * behind because the code that drew it forgot to clear it on the way out.
 */

import {
  MAX_POLL_FAILURES,
  POLL_MS,
  type InputReply,
  type PollResponse,
  type WireState,
} from '../login-protocol.ts';

/**
 * Everything the page can be showing, including the two states no server ever
 * sends: the moment before the first poll answers, and the moment after the
 * command exited. Folding them into the same union is what lets the whole page
 * be one exhaustive switch with no branch that falls through silently — which
 * is exactly what the old `render()` did.
 */
export type ViewState = { kind: 'connecting' } | WireState | { kind: 'session-ended' };

/** The server's own answer to a submit, passed through unchanged. */
export type Submit = (value: string) => Promise<InputReply>;

export type Session = { submit: Submit; start(): void };

/** The server rejected the answer but said nothing usable about why. */
const GENERIC_ERROR = 'Der skete en fejl. Prøv igen.';

/** The answer never reached the server at all. */
const OFFLINE_ERROR = 'Svaret nåede ikke frem. Prøv igen.';

/**
 * Always exactly `/${token}`: the server matches paths by string equality and
 * 404s everything else, trailing slash included. So the token needs no
 * interpolation into script text — which is what lets the bundle be a build-time
 * constant, and reduces the `</script>` hazard to an assertion made once on a
 * developer's machine rather than a guess made on every page load.
 */
const BASE = location.pathname;

/**
 * `rev` is the only field worth checking, because it is the only one whose
 * absence is silently fatal rather than loudly wrong: `fetch` resolves for
 * 4xx/5xx, and a body without it would set `rev = undefined` and poll
 * `?since=undefined` for ever — a page that looks alive and can never advance.
 */
function isPollResponse(value: unknown): value is PollResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { rev?: unknown }).rev === 'number'
  );
}

export function createSession(onState: (state: ViewState) => void): Session {
  let rev = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A hard latch, checked in every scheduling path. `done` is the last byte
  // this socket carries: the server force-closes 50ms after the poll that
  // collects the outcome. One stray poll after that is a dropped request, and
  // three of those would replace MitID's own explanation with "the page lost
  // the connection" — the exact failure the server's settle window exists to
  // prevent.
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    // One timer, always. A schedule(0) from an accepted submit or from a tab
    // coming back to the front replaces the pending tick rather than doubling
    // the loop.
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), ms);
  };

  const stop = (state: ViewState) => {
    stopped = true;
    clearTimeout(timer);
    onState(state);
  };

  async function poll(): Promise<void> {
    if (stopped) return;

    let body: PollResponse;
    try {
      const response = await fetch(`${BASE}/state?since=${rev}`, { cache: 'no-store' });
      // Gated on the status, unlike `submit` below: a state is a state or it is
      // nothing, and there is no Danish sentence to salvage from a bad one.
      if (!response.ok) throw new Error(String(response.status));
      const parsed: unknown = await response.json();
      if (!isPollResponse(parsed)) throw new Error('unreadable state');
      body = parsed;
    } catch {
      if (++failures < MAX_POLL_FAILURES) {
        schedule(POLL_MS);
        return;
      }
      stop({ kind: 'session-ended' });
      return;
    }

    failures = 0;
    rev = body.rev;

    if ('unchanged' in body) {
      // Nothing is rendered and the DOM is not touched at all. This is the
      // outermost of the four things keeping the caret in the username field.
      schedule(POLL_MS);
      return;
    }

    if (body.kind === 'done') {
      // Paint it, latch, and never ask again — in that order, inside `stop`.
      stop(body);
      return;
    }

    onState(body);
    schedule(POLL_MS);
  }

  const submit: Submit = async (value) => {
    try {
      const response = await fetch(`${BASE}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent with fetch, never as a native form submit: this page is served
        // with form-action 'none', so a <form> would be blocked with nothing on
        // screen to explain it — the button would simply do nothing.
        // connect-src 'self' is what permits this call, and the JSON content
        // type is what forces any cross-origin caller into a preflight this
        // server never answers. Do not "simplify" it back into a form.
        body: JSON.stringify({ value }),
        cache: 'no-store',
      });

      // Deliberately NOT gated on response.ok. Every rejection this server
      // issues — 405, 415, 403, 413, 409, 400 — carries a Danish sentence in
      // `error`, and that sentence is the whole of what the parent gets to
      // read. Narrowed by hand rather than cast to InputReply: this is the one
      // place a malformed body would otherwise become a blank error message.
      const body = (await response.json()) as { ok?: unknown; error?: unknown };
      if (body.ok === true) {
        // Accepted. The server has already pushed `starting`; poll now rather
        // than waiting out the tick. Nothing optimistic happens here — the
        // controls stay disabled until a poll paints something over them.
        schedule(0);
        return { ok: true };
      }
      return { ok: false, error: typeof body.error === 'string' ? body.error : GENERIC_ERROR };
    } catch {
      return { ok: false, error: OFFLINE_ERROR };
    }
  };

  // Background tabs get their timers throttled to about once a minute, so a tab
  // coming back to the front would otherwise sit on a code that rotated away
  // long ago. The latch inside `schedule` is what keeps this inert afterwards: a
  // tab refocused ten minutes later must not poke a port closed for nine of them.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(0);
  });

  return { submit, start: () => void poll() };
}
