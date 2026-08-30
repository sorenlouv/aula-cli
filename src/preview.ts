/**
 * The server behind Claude Code's Preview button.
 *
 * `.claude/launch.json` points the desktop app here, so "Preview" on this
 * project shows the newest generated overview instead of a blank port. It
 * serves `~/.aula/brief` (or `$AULA_DIR/brief`) read-only — only the brief
 * pages themselves, no directory listing, no traversal, nothing else on the
 * machine — with one deliberate exception: when no overview exists yet,
 * opening the preview is the clearest possible request for one, so the server
 * runs `aula new` itself and shows progress until the page appears.
 *
 * A failed attempt is remembered and shown, and is retried only through the
 * explicit link on the failure page. Auto-retrying would turn "not logged in"
 * into an infinite loop of two-minute model runs.
 *
 * Bound to 127.0.0.1 explicitly: the pages carry the children's names and
 * messages, and a preview server must not be an invitation to the whole LAN.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_DIR } from './brief/state.ts';
import { escapeHtml } from './html.ts';

/** Must match the `port` in `.claude/launch.json` — that is what the app opens. */
const PORT = Number(process.env.PORT ?? 4317);

const ENTRY = join(import.meta.dir, 'cli.ts');

/**
 * `/` and `/latest.html` are the newest page; a dated page by its filename.
 * Anything else — including every traversal spelling — is a 404, because the
 * pattern admits no separators.
 */
const PAGE = /^\/(latest\.html|brief-\d{4}-\d{2}-\d{2}\.html)?$/;

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const STYLE = `<style>
  body { background: #faf8f5; color: #57534e; margin: 0;
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #16151a; color: #b4afa8; } }
  main { max-width: 34rem; margin: 20vh auto 0; padding: 0 1.5rem; text-align: center; }
  pre { text-align: left; white-space: pre-wrap; font-size: 0.85em; opacity: 0.8;
    border: 1px solid currentColor; border-radius: 8px; padding: 0.8rem; }
  a { color: inherit; }
  .pulse { animation: pulse 1.2s ease-in-out infinite; display: inline-block; }
  @keyframes pulse { 50% { opacity: 0.25; } }
</style>`;

function page(opts: { refreshSeconds?: number; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ''}
<title>Aula AI oversigt</title>
${STYLE}
</head>
<body>
<main>
${opts.body}
</main>
</body>
</html>
`;
}

const GENERATING = page({
  refreshSeconds: 3,
  body: `<p><span class="pulse">●</span> Generating today's overview…</p>
<p>This takes a couple of minutes — the model reads 60 days of Aula. The
page refreshes itself and will show the result as soon as it exists.</p>`,
});

function failedPage(reason: string): string {
  return page({
    body: `<p>The overview could not be generated.</p>
<pre>${escapeHtml(reason)}</pre>
<p>Fix the cause, then <a href="/retry">try again</a>.</p>`,
  });
}

export type Generation = {
  readonly running: boolean;
  readonly failed: string | null;
  /** Begins a run unless one is already under way — safe to call per request. */
  start(): void;
  /** Forgets a recorded failure so the next request may try again. */
  reset(): void;
};

/**
 * Runs `aula new` at most once at a time and remembers how the last attempt
 * ended. `env` exists for the tests, which must be able to point the child at
 * a sandbox instead of the machine's real login.
 */
export function generation(dir = BRIEF_DIR, env?: Record<string, string>): Generation {
  let running = false;
  let failed: string | null = null;
  return {
    get running() {
      return running;
    },
    get failed() {
      return failed;
    },
    reset() {
      failed = null;
    },
    start() {
      if (running) return;
      running = true;
      failed = null;
      const child = Bun.spawn([process.execPath, ENTRY, 'new', '--text', '--no-open'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: { ...process.env, ...env },
      });
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // `void`, and nothing chains off this: the rule exists to catch a .then
      // whose undefined return silently becomes the next .then's argument, and
      // there is no next one. The handler is a terminal side effect.
      // oxlint-disable-next-line promise/always-return
      void child.exited.then(async (code) => {
        const [out, err] = await output;
        running = false;
        if (code !== 0) {
          failed = (err.trim() || out.trim() || `aula new exited with ${code}`).slice(-800);
        } else if (!existsSync(join(dir, 'latest.html'))) {
          // Should be impossible — but without this line, a clean exit that
          // wrote nothing would retrigger forever, one silent two-minute model
          // run after another.
          failed = 'aula new finished without producing a page.';
        }
      });
    },
  };
}

let shared: Generation | undefined;
function sharedGeneration(): Generation {
  return (shared ??= generation());
}

export function briefResponse(
  pathname: string,
  dir = BRIEF_DIR,
  gen: Generation = sharedGeneration(),
): Response {
  if (pathname === '/retry') {
    gen.reset();
    return new Response(null, { status: 303, headers: { location: '/' } });
  }

  const match = PAGE.exec(pathname);
  if (!match) return new Response('Not found.', { status: 404 });

  const file = join(dir, match[1] ?? 'latest.html');
  if (existsSync(file)) {
    // no-store because the same URL serves a new page every morning — a cached
    // copy would quietly show yesterday.
    return new Response(readFileSync(file), { headers: HTML });
  }
  if (match[1] !== undefined && match[1] !== 'latest.html') {
    return new Response('No overview on disk for that day.', { status: 404 });
  }

  // The newest page does not exist. Make it exist — that is what opening the
  // preview asks for. Failures wait for the explicit retry link.
  if (gen.failed !== null)
    return new Response(failedPage(gen.failed), { status: 200, headers: HTML });
  gen.start();
  return new Response(GENERATING, { status: 200, headers: HTML });
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch: (req) => briefResponse(new URL(req.url).pathname),
  });
  console.log(`Aula AI oversigt: http://localhost:${PORT} (serving ${BRIEF_DIR}, local only)`);
}
