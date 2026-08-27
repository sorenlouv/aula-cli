/**
 * The guard that keeps the login page's client compiled rather than typed.
 *
 * The client used to be ~212 lines of ES5 inside an untagged template literal
 * in `login-page.ts`. Nothing checked it: `tsc` never saw it (the root project
 * has no "dom" lib and never will), Prettier does not format an untagged
 * literal, and there was no linter. It patched DOM nodes in place and had to
 * remember to clear each one on the way *out* of a state — which it did not.
 *
 * The port fixed that by moving the client into `src/browser/*.tsx` and
 * compiling it at transpile time. Nothing about that arrangement is
 * self-enforcing: the fastest way to make a one-line change to this page is
 * still to type JavaScript into the shell, and it would work. This file is what
 * makes that fail instead — on the machine of whoever does it, with a sentence
 * saying where the code belongs.
 *
 * It lives here rather than in `src/browser/` because it runs in Bun, not in a
 * browser: it spawns the bundler, starts a server and reads files off disk.
 * `src/browser/` is a separate TypeScript project with no Bun types by design,
 * so a test placed there would be typechecked by neither project — which is the
 * one thing a guard must not be.
 *
 * Every assertion below compares a list of *sentences* against an empty list
 * rather than a boolean against `true`. A guard that fails with "expected false
 * to be true" tells the person who broke the convention nothing about it.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { clientScript, clientStyles } from './browser/bundle.ts';
import { startLoginPage, type LoginPageState } from './login-page.ts';
import type { WireState } from './login-protocol.ts';
import { buildQrPayloads } from './vendor/aula-auth/mitid-poll-machine.ts';

const BROWSER_DIR = new URL('./browser/', import.meta.url);
const CLIENT_ENTRY = new URL('login.tsx', BROWSER_DIR);
const SERVER_SOURCE = readFileSync(new URL('./login-page.ts', import.meta.url), 'utf8');

/**
 * The server file *and* the local modules it imports, by repo-relative path.
 *
 * Scanning one file is one `import` away from being scanning nothing: parking
 * the same ES5 in a sibling module and interpolating it is the shortest way
 * past this guard, and it was. One hop rather than the whole graph, because the
 * point is not that the repo contains no DOM code — `src/browser` is nothing
 * but DOM code, on purpose — only that the modules feeding this page contain
 * none. What actually closes the path such code would have to travel to reach a
 * browser is the interpolation inventory below; this hop is what puts the
 * failure on the file somebody typed it into rather than three tests away.
 */
const SERVER_MODULES: { path: string; source: string }[] = [
  { path: 'src/login-page.ts', source: SERVER_SOURCE },
  ...[...SERVER_SOURCE.matchAll(/\bfrom\s+'(\.\/[^']+)'/g)].map(([, spec]) => ({
    path: `src/${(spec ?? '').slice(2)}`,
    source: readFileSync(new URL(spec ?? '', import.meta.url), 'utf8'),
  })),
];

/** Where to put it instead, repeated in every failure because that is the point. */
const WHERE =
  'The browser half of this page lives in src/browser/*.tsx and is compiled into the served page by the macro in src/browser/bundle.ts.';

/**
 * Comments are prose about the client and may name anything; code may not.
 *
 * Block comments go first, so a JSDoc paragraph mentioning `location.pathname`
 * — there is one, explaining why the client derives its base path — is not read
 * as a `location` access. Only whole-line `//` comments are stripped, never a
 * trailing one: cutting at the first `//` on a line would also cut
 * `http://127.0.0.1`, and a rule that quietly deletes code is worse here than a
 * false positive somebody can see the line number of.
 *
 * A block is replaced by its own newlines rather than by nothing, and a comment
 * line by an empty one, so every index below is still the line number in the
 * file. A guard that reports the wrong line sends its reader to the wrong place,
 * which for a convention they have not met yet is most of the failure.
 */
function code(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line));
}

/**
 * Spellings that only make sense in a browser, and one that only makes sense in
 * 2009. Each carries why it cannot be in a file that runs in Bun, because the
 * pattern alone reads as arbitrary style policing and it is not.
 */
const BROWSER_CODE: { pattern: RegExp; why: string }[] = [
  { pattern: /\bdocument\s*[.[]/, why: 'reaches into the DOM' },
  { pattern: /\bwindow\s*[.[]/, why: 'reaches into the DOM' },
  { pattern: /\blocation\s*[.[]/, why: 'reads the browser URL' },
  { pattern: /\baddEventListener\s*\(/, why: 'binds a browser event' },
  {
    pattern: /\b(?:getElementById|querySelector|createElement|createTextNode)\s*\(/,
    why: 'builds DOM by hand — the failure mode the port exists to delete',
  },
  {
    pattern: /\.(?:innerHTML|outerHTML|textContent)\s*=/,
    why: 'writes markup or text into a node',
  },
  { pattern: /\bXMLHttpRequest\b/, why: 'is a browser transport' },
  {
    pattern: /\bvar\s+[A-Za-z_$]/,
    why: 'is ES5 `var`, which only ever appeared here because nothing checked this code',
  },
];

describe('login page client', () => {
  test('the server file and what it imports hold no browser code of their own', () => {
    const found = SERVER_MODULES.flatMap(({ path, source }) =>
      code(source).flatMap((line, index) =>
        BROWSER_CODE.filter(({ pattern }) => pattern.test(line)).map(
          ({ pattern, why }) => `${path}:${index + 1} matches ${pattern} — it ${why}. ${WHERE}`,
        ),
      ),
    );
    expect(found).toEqual([]);
  });

  test('the shell interpolates the bundle and the stylesheet, and nothing else', () => {
    // This is what makes "no hand-written poll loop" structural instead of a
    // list of banned words. `setTimeout` itself is not bannable here — the
    // server uses one for the outcome-flush grace — so the guard is that there
    // is nowhere in this page to put a loop.
    //
    // The subject is the *whole* shell rather than its script tag, and that is
    // the correction of a real hole: a guard that inspects one tag says nothing
    // about `<main onclick="${EXTRA}">`, which is browser code on the page, runs
    // under `script-src 'unsafe-inline'` exactly like a script block, and used
    // to pass every test in this file. Pinning the complete set of `${...}`
    // sinks closes that path, a second script tag, and whatever markup sink
    // nobody has thought of yet, in one assertion.
    const problems: string[] = [];
    const shell = /\nconst SHELL = `([\s\S]*?)\n`;/.exec(SERVER_SOURCE)?.[1];

    if (shell === undefined) {
      problems.push(
        `src/login-page.ts no longer defines the page as a single \`const SHELL = \`...\`\` ` +
          `template, which is what this guard reads. Keep that shape: a page assembled by code ` +
          `is a page whose sinks cannot be counted, and counting them is the whole check. ` +
          `${WHERE}`,
      );
    } else {
      const sinks = [
        ...new Set([...shell.matchAll(/\$\{([^}]*)\}/g)].map(([, name]) => name ?? '')),
      ];
      const unexpected = sinks.filter((name) => name !== 'CLIENT' && name !== 'STYLES');
      for (const name of unexpected) {
        problems.push(
          `the shell interpolates \${${name}} — the only two values that may reach this page are ` +
            `CLIENT and STYLES, both of them compiler output. Anything else is hand-written text ` +
            `served to a browser, whether it sits in a <script> tag or in an attribute. ${WHERE}`,
        );
      }

      const scripts = [...shell.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
        ([, body]) => body ?? '',
      );
      if (scripts.length !== 1 || scripts[0] !== '${CLIENT}') {
        problems.push(
          `the shell has ${scripts.length} <script> tag(s) — ${JSON.stringify(scripts.map((body) => body.slice(0, 60)))} ` +
            `— rather than exactly one whose entire content is \${CLIENT}. The page runs one ` +
            `program, and it is the compiled one. ${WHERE}`,
        );
      }

      // An event handler attribute is script that no script-tag rule can see.
      // Nothing in the CSP stops it either: `script-src 'unsafe-inline'` admits
      // handlers as readily as blocks, and it is spent on the bundle already.
      const handler = /\son[a-z]+\s*=/i.exec(shell);
      if (handler !== null) {
        problems.push(
          `the shell has an inline event handler (${JSON.stringify(handler[0].trim())} at offset ` +
            `${handler.index}). The only script on this page is the compiled bundle; a handler ` +
            `attribute is hand-written client code that every other check here would miss. ` +
            `${WHERE}`,
        );
      }
    }

    // Read together with the above: a script tag holding one interpolation
    // proves nothing if the value came from somewhere other than the macro.
    if (!/bundle\.ts'\s*with\s*\{\s*type:\s*'macro'\s*\}/.test(SERVER_SOURCE)) {
      problems.push(
        `src/login-page.ts no longer imports './browser/bundle.ts' with { type: 'macro' }. ` +
          `That attribute is what runs the bundler at transpile time; without it the page ` +
          `would need a bundler at runtime, and a --compile binary has no source tree to ` +
          `bundle from. ${WHERE}`,
      );
    }

    expect(problems).toEqual([]);
  });

  test('the client is TSX under src/browser and is built on preact', () => {
    const problems: string[] = [];

    if (!existsSync(CLIENT_ENTRY)) {
      problems.push(`src/browser/login.tsx is missing. ${WHERE}`);
    } else {
      const source = readFileSync(CLIENT_ENTRY, 'utf8');
      // `from 'preact'`, not merely the word: the client must render through
      // the framework rather than merely mention it. Anything deeper — hooks,
      // the JSX runtime — arrives through the tsconfig in that directory and is
      // the typechecker's business, not this test's.
      if (!/from\s+'preact'/.test(source)) {
        problems.push(
          `src/browser/login.tsx does not import preact. The page is declarative on purpose: ` +
            `a tree rebuilt from one state cannot leave a node behind, which is the bug class ` +
            `the hand-written client shipped.`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test('the only thing the page asks anyone to type is a MitID username', () => {
    // An allowlist, and that is the correction of a denylist that could only
    // catch a field naming itself: `<input name="kode">` is a credential prompt
    // holding neither banned word, and it passed every test in the repo. The
    // rule this page lives by is not "no field called password" — it is one
    // field, and it is a username. Every secret is typed into the MitID app on
    // the user's own phone, so a second input here is a phishing surface no
    // matter what it is called or what `type` it carries.
    //
    // Read from the source rather than the served bytes because there is
    // nothing to read there: preact compiles an element to a function call, so
    // no `<input` survives into the HTML. The `/password|adgangskode/i` scan in
    // login-page.test.ts is the belt to this — it still catches a field added
    // anywhere in the bundle that this file does not read.
    const problems: string[] = [];
    let usernames = 0;

    for (const file of readdirSync(BROWSER_DIR).filter((name) => name.endsWith('.tsx'))) {
      const source = readFileSync(new URL(file, BROWSER_DIR), 'utf8');
      // Non-greedy up to the self-closing `/>`, not up to the first `>`:
      // attribute values in this file hold `=>` and `!==`, and stopping at a
      // bare `>` would read half an element and miss the `name` on the rest.
      const fields = [...source.matchAll(/<(input|textarea)\b([\s\S]*?)\/>/g)];

      // Which leaves `<input></input>` — legal JSX, and unreachable by a
      // pattern anchored on `/>`. Counting the openings separately turns that
      // into a reported failure rather than a field this guard cannot see.
      const openings = [...source.matchAll(/<(?:input|textarea)\b/g)].length;
      if (openings !== fields.length) {
        problems.push(
          `src/browser/${file} has ${openings} input or textarea elements but this guard could ` +
            `only read ${fields.length}: it is anchored on the self-closing \`/>\`. Write them as ` +
            `\`<input ... />\`, because the check below can only vouch for a field it can parse.`,
        );
      }

      for (const [, tag, attrs] of fields) {
        const name = /\bname="([^"]*)"/.exec(attrs ?? '')?.[1];
        if (tag === 'input' && name === 'username') {
          usernames += 1;
          continue;
        }
        problems.push(
          `src/browser/${file} renders <${tag ?? ''} name="${name ?? ''}">. The only field this ` +
            `page may have is the MitID username: it is the one thing the CLI cannot know and ` +
            `the one thing that is not a secret. Everything else — the code, the approval — ` +
            `happens in the MitID app, and a field for it here is a phishing surface.`,
        );
      }
    }

    // Without this the assertion above passes on a page with no fields at all,
    // including one where a rename quietly took the whole scan out of service.
    if (usernames !== 1) {
      problems.push(
        `src/browser holds ${usernames} <input name="username"> elements rather than one. If the ` +
          `field was renamed, rename it here too — a guard that matches nothing reports nothing.`,
      );
    }

    expect(problems).toEqual([]);
  });

  test('the page serves the compiled bundle, byte for byte', async () => {
    const page = startLoginPage();
    try {
      const html = await (await fetch(page.url)).text();

      // Every tag, not the first one. A non-global `exec` here made "the first
      // script matches the bundle" stand in for "the page has one script", and
      // a second tag full of ES5 sailed past it.
      const tags = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
      expect(tags).toHaveLength(1);
      const served = tags[0]?.[1] ?? '';

      // The definitive assertion, and the reason this file spawns a bundler:
      // `clientScript()` is the same function the macro calls, so the served
      // bytes are compared against a fresh compile of the real entry point
      // through the real flags. Hand-edited script text cannot survive it, and
      // neither can a stale inline copy of an older client.
      expect(served).toBe(clientScript());

      const problems: string[] = [];

      // Anchors the assertion above against the failure mode this whole
      // mechanism introduces: a macro that returned an empty string would make
      // every "the page does not contain X" test pass for the wrong reason.
      if (served.length < 5_000) {
        problems.push(
          `the served script is ${served.length} bytes, which is too small to be preact plus ` +
            `this page. The macro in src/browser/bundle.ts likely produced nothing — check ` +
            `its output before trusting any other assertion about this page.`,
        );
      }

      // Preact's IS_NON_DIMENSIONAL test, a regex literal the minifier keeps
      // verbatim while it renames every identifier around it. If preact ever
      // changes that internal, this marker is what needs updating — the
      // convention it stands for has not changed.
      if (!served.includes('acit|ex')) {
        problems.push(
          `the served script does not contain preact's runtime. Either the client stopped ` +
            `rendering through preact, or preact changed the internal regex used as the marker ` +
            `here. ${WHERE}`,
        );
      }

      // The same fact as the shell's own handler check, asserted on the bytes a
      // browser receives — which is where it actually matters, and which stays
      // true however the page comes to be assembled later. Script and style
      // bodies are cut out first: minified JavaScript is allowed to contain
      // anything, and it is not markup.
      const markup = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '<$1></$1>');
      const handler = /\son[a-z]+\s*=/i.exec(markup);
      if (handler !== null) {
        problems.push(
          `the served page carries an inline event handler (${JSON.stringify(handler[0].trim())}). ` +
            `The only script this page runs is the compiled bundle. ${WHERE}`,
        );
      }

      expect(problems).toEqual([]);
    } finally {
      page.close();
    }
  });

  test('nothing inlined into the page can end its own tag', () => {
    // Both blobs ship inline under `script-src 'unsafe-inline'` — they have to,
    // they are inline — which leaves the tag boundary as the last thing between
    // build output and arbitrary markup in a document holding a live MitID
    // channel binding. `<!--` and `-->` belong in the same list: an inline
    // *classic* script honours the legacy HTML-comment tokens, and a minifier
    // can emit `a-->b` for `a-- > b`.
    //
    // The macro refuses these at transpile time. This asserts that it does,
    // because the guard is only worth what it actually rejects.
    const hazard = /<\/(?:script|style)|<!--|-->/i;
    const problems = [
      { what: 'bundle', text: clientScript() },
      { what: 'stylesheet', text: clientStyles() },
    ]
      .map(({ what, text }) => ({ what, found: hazard.exec(text) }))
      .filter(({ found }) => found !== null)
      .map(
        ({ what, found }) =>
          `the ${what} contains a literal "${found?.[0]}" at offset ${found?.index}, which would ` +
          `end its own tag early and turn the rest of the client into text on the page. Split ` +
          `the literal at its source in src/browser/.`,
      );

    expect(problems).toEqual([]);
  });
});

const QR = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 4);

/**
 * One state per wire kind, exhaustive by construction.
 *
 * A `Record` keyed on `WireState['kind']` is what makes adding a kind to the
 * protocol a compile error here rather than a state nobody ever sent. `done` is
 * absent because it is not a `LoginPageState`: it exists only on the wire and
 * only `finish()` can produce it, so it is driven separately below.
 */
const SAMPLE: Record<Exclude<WireState['kind'], 'done'>, LoginPageState> = {
  'ask-username': { kind: 'ask-username' },
  'ask-identity': { kind: 'ask-identity', options: ['Alma Eksempelsen — forælder'] },
  starting: { kind: 'starting' },
  otp: { kind: 'otp', otp: '481592' },
  qr: { kind: 'qr', qr1: QR.qr1Json, qr2: QR.qr2Json, updateCount: 4 },
  verified: { kind: 'verified' },
};

describe('login wire protocol', () => {
  test('every kind the client switches on is a kind the server can send', async () => {
    const page = startLoginPage();
    try {
      const seen: string[] = [];
      for (const state of Object.values(SAMPLE)) {
        page.update(state);
        const body = (await (await fetch(`${page.url}/state?since=0`)).json()) as WireState;
        seen.push(body.kind);
      }

      // The literals, not the type. `toWire` spreads the state through, so a
      // mistyped kind on either side compiles cleanly and only diverges on the
      // wire — where the client's exhaustive switch would fall through to a
      // page that renders nothing and says nothing.
      expect(seen).toEqual(Object.keys(SAMPLE));
    } finally {
      page.close();
    }
  });

  test('every poll answer carries the revision the client polls on', async () => {
    const page = startLoginPage({ kind: 'starting' });
    try {
      // `rev` is the one field whose absence is silently fatal rather than
      // loudly wrong: the client would poll `?since=undefined` for ever, on a
      // page that looks alive and can never advance. It is what the client's
      // one runtime narrowing checks, so it is checked here on all three
      // shapes a poll can answer with.
      const full = await (await fetch(`${page.url}/state?since=0`)).json();
      expect(typeof (full as { rev: unknown }).rev).toBe('number');

      const rev = (full as { rev: number }).rev;
      const unchanged = await (await fetch(`${page.url}/state?since=${rev}`)).json();
      expect(unchanged).toEqual({ rev, unchanged: true });

      const done = page.finish({ ok: true, message: 'Du kan lukke fanen.' });
      const outcome = await (await fetch(`${page.url}/state?since=${rev}`)).json();
      expect(outcome).toMatchObject({ kind: 'done', rev: rev + 1 });
      await done;
    } finally {
      page.close();
    }
  });
});
