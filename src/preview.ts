/**
 * The server behind Claude Code's Preview button.
 *
 * `.claude/launch.json` points the desktop app here, so "Preview" on this
 * project shows the newest generated overview instead of a blank port. It
 * serves `~/.aula/brief` (or `$AULA_DIR/brief`) read-only, and only the brief
 * pages themselves — no directory listing, no traversal, nothing else on the
 * machine.
 *
 * Bound to 127.0.0.1 explicitly: the pages carry the children's names and
 * messages, and a preview server must not be an invitation to the whole LAN.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_DIR } from './brief/state.ts';

/** Must match the `port` in `.claude/launch.json` — that is what the app opens. */
const PORT = Number(process.env.PORT ?? 4317);

/**
 * `/` and `/latest.html` are the newest page; a dated page by its filename.
 * Anything else — including every traversal spelling — is a 404, because the
 * pattern admits no separators.
 */
const PAGE = /^\/(latest\.html|brief-\d{4}-\d{2}-\d{2}\.html)?$/;

/**
 * Shown while there is nothing to show. It refreshes itself so a brief being
 * generated right now appears the moment `aula new` finishes writing it.
 */
const EMPTY_STATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Aula AI oversigt</title>
<style>
  body { background: #faf8f5; color: #57534e; margin: 0;
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #16151a; color: #b4afa8; } }
  main { max-width: 34rem; margin: 20vh auto 0; padding: 0 1.5rem; text-align: center; }
  code { font-size: 0.95em; }
</style>
</head>
<body>
<main>
  <p>No overview has been generated yet.</p>
  <p>Run <code>aula new</code> — this page refreshes itself and will show the
  result as soon as it exists.</p>
</main>
</body>
</html>
`;

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

export function briefResponse(pathname: string, dir = BRIEF_DIR): Response {
  const match = PAGE.exec(pathname);
  if (!match) return new Response('Not found.', { status: 404 });

  const file = join(dir, match[1] ?? 'latest.html');
  if (!existsSync(file)) {
    // The newest page not existing yet is a state, not an error; a dated page
    // not existing is simply a day that has no overview on disk.
    return match[1] === undefined || match[1] === 'latest.html'
      ? new Response(EMPTY_STATE, { status: 200, headers: HTML })
      : new Response('No overview on disk for that day.', { status: 404 });
  }
  // no-store because the same URL serves a new page every morning — a cached
  // copy would quietly show yesterday.
  return new Response(readFileSync(file), { headers: HTML });
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch: (req) => briefResponse(new URL(req.url).pathname),
  });
  console.log(`Aula AI oversigt: http://localhost:${PORT} (serving ${BRIEF_DIR}, local only)`);
}
