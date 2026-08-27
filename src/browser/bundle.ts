/**
 * Compiles the login page's browser client and hands it back as a string.
 *
 * This is a Bun macro: it runs during transpile, on the machine doing the
 * building, and its return value is inlined into the caller as a literal. By
 * the time the page is served there is no bundler and no build step left —
 * `login-page.ts` holds the finished script the way it used to hold a template
 * literal, except this one was typechecked, linted and formatted first.
 *
 * Why a subprocess rather than `Bun.build`: calling Bun.build inside a macro
 * deadlocks and Bun rejects it outright. Spawning the `bun build` CLI is the
 * documented way around it, and the cost is ~15ms per invalidation — the macro
 * re-runs when login.tsx changes, so the dev loop under `bun run` stays honest
 * without anyone remembering to rebuild.
 *
 * Why not bundle at runtime instead, which would avoid all of this: a
 * `--compile` binary has no source tree. Its own files live in a virtual
 * /$bunfs/root that a bundler cannot walk, so a runtime Bun.build works right
 * up until the release build and then fails for every user. Transpile time is
 * the only time this can happen.
 *
 * The stylesheet comes through here too, for one reason that is not symmetry:
 * `default-src 'none'` means the page can never fetch a stylesheet, so the CSS
 * has to be in the document — and inlining it from a real .css file is what
 * lets Prettier format it and a diff on it stay readable.
 */

import { readFileSync } from 'node:fs';

/**
 * Fails the transpile, loudly.
 *
 * Bun coerces anything thrown out of a macro into "cannot coerce Exception
 * (Cell) to Bun's AST" and drops the message, so the build stops for the right
 * reason and says nothing about what it was. Printing first is what puts the
 * actual cause in front of whoever has to fix it.
 */
function fail(reason: string): never {
  console.error(`\n[login client bundle] ${reason}\n`);
  throw new Error(reason);
}

/**
 * Refuses any blob that could end its own tag.
 *
 * Both blobs are inlined under a CSP that allows 'unsafe-inline' — it has to,
 * they are inlined — which makes the tag boundary the last thing standing
 * between this string and arbitrary markup in a document holding a live MitID
 * channel binding. An HTML parser ends `<script>` at the first `</script`
 * whatever the JavaScript around it says, and `<style>` at the first `</style`.
 *
 * `<!--` and `-->` are the subtle pair: an inline *classic* script still
 * honours the legacy HTML-comment tokens, so `<!--` opens a comment that
 * swallows the rest of the bundle, and a minifier can emit `a-->b` for
 * `a-- > b`. All four are conditions to fix at the source, never to escape
 * past: this throws on a developer's machine so it cannot surface on a
 * parent's.
 */
function inlineSafe(what: string, source: string): string {
  const found = /<\/(?:script|style)|<!--|-->/i.exec(source);
  if (found) {
    fail(
      `the ${what} contains a literal "${found[0]}" sequence, which would end its own ` +
        `tag early. Rewrite the source that produces it — splitting the literal is enough.`,
    );
  }
  return source;
}

export function clientScript(): string {
  const entry = new URL('./login.tsx', import.meta.url).pathname;

  // IIFE rather than ESM because the result is inlined into a plain <script>
  // with no type="module"; minified because it ships on every page load of a
  // login and there is nothing to debug in a released binary anyway.
  const built = Bun.spawnSync([
    'bun',
    'build',
    entry,
    '--target=browser',
    '--minify',
    '--format=iife',
  ]);

  if (built.exitCode !== 0) fail(`bun build failed:\n${built.stderr.toString()}`);

  return inlineSafe('bundle', built.stdout.toString());
}

/**
 * The stylesheet, verbatim.
 *
 * Not minified, unlike the script: it is a few kilobytes served once over
 * loopback, and the comments in it are the record of which rules are load-
 * bearing for a scanner rather than for taste.
 */
export function clientStyles(): string {
  return inlineSafe('stylesheet', readFileSync(new URL('./login.css', import.meta.url), 'utf8'));
}
