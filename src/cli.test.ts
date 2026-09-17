/**
 * End-to-end tests: the CLI as a process, driven through argument parsing,
 * dispatch, fetching and rendering, against the stubbed Aula in
 * `testing/fake-aula.ts`.
 *
 * The other test files exercise helpers in isolation, which is the right shape
 * for pure logic and completely blind to the failure this file exists for:
 * `digest` accepted `--child` and never passed it on. Every helper involved was
 * correct; the wiring between them was not. So these run the real binary and
 * assert on what a user (or Claude) actually gets back.
 *
 * They also count requests, which is the only honest way to test a cache.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SESSION_FREE_COMMANDS } from './auth.ts';
import { cmd } from './runtime.ts';
import { currentSlotStart } from './slots.ts';
import { installFakeClaude } from './testing/fake-claude.ts';

// Bun's test runner otherwise defaults to UTC while the child CLI process uses
// the host zone. Keeping both sides in the application's real zone prevents
// local-day assertions from disagreeing around Copenhagen midnight, even when
// this file is run directly rather than through a package script.
process.env.TZ = 'Europe/Copenhagen';

const ROOT = new URL('..', import.meta.url).pathname;
const PRELOAD = join(ROOT, 'src/testing/fake-aula.ts');
const SEED = join(ROOT, 'src/testing/seed-tokens.ts');
const ENTRY = join(ROOT, 'src/cli.ts');

const sandboxes: string[] = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

type RunResult = { code: number; stdout: string; stderr: string; requests: string[] };

/**
 * One isolated `~/.aula`, so the cache and any stored credentials belong to the
 * test rather than to whoever is running it.
 */
function sandbox(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aula-cli-test-'));
  sandboxes.push(dir);
  const log = join(dir, 'requests.log');
  writeFileSync(log, '');
  /** Mutable so a test can change credentials between runs. */
  const env: Record<string, string> = {
    AULA_DIR: dir,
    FAKE_AULA_LOG: log,
    NO_COLOR: '1',
    ...overrides,
  };

  // Auth is MitID-only, so "logged in" is a state on disk: seed a fixture
  // login through the same encrypted store the CLI reads. The username on the
  // record is also what Meebook and Systematic receive as their session id.
  const seeded = Bun.spawnSync({ cmd: ['bun', SEED], env: { ...process.env, ...env } });
  if (seeded.exitCode !== 0) {
    throw new Error(`token seeding failed: ${seeded.stderr.toString()}`);
  }

  return {
    dir,
    env,
    /** Everything requested since the last `reset()`. */
    requests(): string[] {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    },
    reset(): void {
      writeFileSync(log, '');
    },
    run(...args: string[]): RunResult {
      const result = Bun.spawnSync({
        cmd: ['bun', '--preload', PRELOAD, ENTRY, ...args],
        env: { ...process.env, ...env },
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        requests: readFileSync(log, 'utf8').split('\n').filter(Boolean),
      };
    },
  };
}

function runWithoutLogin(...args: string[]): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'aula-cli-unauthed-test-'));
  sandboxes.push(dir);
  const log = join(dir, 'requests.log');
  writeFileSync(log, '');
  const result = Bun.spawnSync({
    cmd: ['bun', '--preload', PRELOAD, ENTRY, ...args],
    env: { ...process.env, AULA_DIR: dir, FAKE_AULA_LOG: log, NO_COLOR: '1' },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    requests: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

type ErrorLine = { code: string; message: string; hint: string | null };

/**
 * The last line of stderr, parsed — what an agent is told to read instead of
 * the prose above it. Throws when that line is not the error line, which is the
 * assertion: "always the last line" has to hold for every failing exit.
 */
function errorLineOf(stderr: string): ErrorLine {
  const last = stderr.trimEnd().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(last) as { error: ErrorLine };
  assert.deepEqual(Object.keys(parsed), ['error'], last);
  assert.deepEqual(Object.keys(parsed.error), ['code', 'message', 'hint'], last);
  assert.equal(typeof parsed.error.message, 'string');
  assert.ok(parsed.error.message.length > 0, 'a message worth reading');
  assert.ok(!parsed.error.message.includes('\n'), 'one sentence, one line');
  return parsed.error;
}

function json(result: RunResult): any {
  assert.equal(result.code, 0, `expected success, got ${result.code}:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('unknown commands and malformed arguments are rejected before authentication', () => {
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ['not-a-command'], message: /Unknown command/ },
    { args: ['calendar', '--days', 'many'], message: /--days must be an integer/ },
    { args: ['contacts', '--role', 'teacher'], message: /--role must be "child" or "guardian"/ },
    { args: ['pickup-times', '--from', '2026-02-31'], message: /--from must be a real date/ },
    { args: ['thread', '1.5'], message: /id must be a positive integer/ },
  ];

  for (const { args, message } of cases) {
    const result = runWithoutLogin(...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, message);
    // Stripped of the checkout path first. A usage error names the script it
    // was run from, so `cmd()` puts an absolute path in this string, and the
    // assertion would otherwise be reading the name of whatever directory the
    // repo happens to sit in — a worktree named for the login page fails it
    // while leaking nothing. `ROOT` rather than `process.cwd()`: it is derived
    // from this file's own URL, so it is right however the runner was invoked.
    assert.doesNotMatch(result.stderr.replaceAll(ROOT, ''), /login|token file/i);
    assert.deepEqual(result.requests, []);
  }
});

/**
 * The 50-day ceiling is one endpoint's server limit, not a property of the
 * flag: Aula answers a calendar span of 51 with a 403. History-oriented
 * commands may still accept a larger value as long as their calendar slice is
 * independently constrained.
 */
test('--days is bounded by the calendar endpoint only where the full range is read', () => {
  for (const command of ['calendar', 'doctor']) {
    const rejected = runWithoutLogin(command, '--days', '90');
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /--days must be an integer of at least 1 and at most 50/);
    assert.deepEqual(rejected.requests, []);
  }

  for (const command of ['digest', 'pickup-times', 'new']) {
    const result = runWithoutLogin(command, '--days', '90');
    assert.doesNotMatch(result.stderr, /--days must be/, `${command} --days 90 should be accepted`);
  }

  // Still a bound, just a sane one rather than another endpoint's.
  assert.match(runWithoutLogin('digest', '--days', '4000').stderr, /at most 365/);
  assert.match(runWithoutLogin('digest', '--days', '0').stderr, /at least 1/);
});

test('a long digest keeps its history range without exceeding Aula calendar limits', () => {
  const box = sandbox();
  const result = box.run('digest', '--days', '90', '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).window.days, 90);
});

test('a command prints only the options it accepts', () => {
  const help = runWithoutLogin('doctor', '--help');
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes(`Usage: ${cmd('doctor')}`), help.stdout);
  assert.match(help.stdout, /--text --days/);
  assert.doesNotMatch(help.stdout, /--no-cache/);
  assert.deepEqual(help.requests, []);
});

// ------------------------------------------------------------------- --child

// The regression this file was written for. `digest` parsed `--child` and threw
// it away, so a question about one child was answered with the whole family's
// data and no indication that the filter had not been applied.
test('digest --child narrows every read, not just the ones that were wired up', () => {
  const box = sandbox();
  const digest = json(box.run('digest', '--child', 'Alma', '--no-cache'));

  assert.deepEqual(digest.scope, { child: 'Alma', children: ['Alma Eksempelsen'] });
  assert.deepEqual(
    digest.family.children.map((c: any) => c.name),
    ['Alma Eksempelsen'],
  );
  assert.deepEqual(
    digest.threads.map((t: any) => t.subject),
    ['Lejrskole for 2E'],
  );
  assert.deepEqual(
    digest.calendar.map((e: any) => e.title),
    ['Lejrskole'],
  );
  assert.deepEqual(
    digest.presence.map((p: any) => p.child),
    ['Alma Eksempelsen'],
  );
  assert.deepEqual(
    digest.weeklyPlans.flatMap((p: any) => p.items.map((i: any) => i.childName)),
    ['Alma Eksempelsen'],
  );

  // Posts are filtered by the id set Aula is asked with, and the guardian's own
  // ids have to stay in — dropping them returns an empty list with status 0.
  // So the other child's post goes, and the guardian-addressed one stays.
  const titles = digest.posts.map((p: any) => p.title);
  assert.ok(titles.includes('Ugeplan 2E'));
  assert.ok(!titles.includes('Sommerfest i Myretuen'), "the other child's post must not appear");
});

test('digest without --child still covers the whole family', () => {
  const digest = json(sandbox().run('digest', '--no-cache'));
  assert.equal(digest.scope.child, null);
  assert.equal(digest.family.children.length, 2);
  assert.equal(digest.threads.length, 3);
  assert.deepEqual(
    digest.calendar.map((e: any) => e.title),
    ['Lejrskole', 'Bedsteforældredag'],
  );
});

test('digest --child reaches the standalone commands too', () => {
  const box = sandbox();
  const { posts } = json(box.run('posts', '--child', 'Viggo', '--no-cache'));
  const titles = posts.map((p: any) => p.title);
  assert.ok(titles.includes('Sommerfest i Myretuen'));
  assert.ok(!titles.includes('Ugeplan 2E'));
});

// A flag that is quietly ignored produces a confident wrong answer, which is the
// class of bug this project is least equipped to notice.
test('--child is refused by commands that cannot honour it', () => {
  const result = sandbox().run('thread', '5001', '--child', 'Alma');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not accept --child.*otherwise be ignored/);
  assert.match(result.stderr, /digest/, 'should name the commands that do');
  assert.equal(result.requests.length, 0, 'must be refused before spending a request');
});

test('an unknown child is refused rather than silently matching nobody', () => {
  const result = sandbox().run('digest', '--child', 'Nobody');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No child matches "Nobody"/);
});

// --------------------------------------------------------------------- cache

test('a repeated command is served entirely from disk', () => {
  const box = sandbox();
  const first = box.run('digest');
  assert.equal(first.code, 0);
  assert.ok(first.requests.length > 10, `expected a full fetch, got ${first.requests.length}`);

  box.reset();
  const second = box.run('digest');
  assert.equal(second.requests.length, 0, `cached run still sent: ${second.requests.join(', ')}`);
  assert.deepEqual(
    JSON.parse(second.stdout).threads,
    JSON.parse(first.stdout).threads,
    'a cached answer must be the same answer',
  );
});

test('the cache is scoped to the command, not shared across different questions', () => {
  const box = sandbox();
  box.run('digest', '--days', '14');
  box.reset();
  // A different window is a different question and must not hit the entry
  // written for the first one.
  box.run('digest', '--days', '30');
  assert.ok(
    box.requests().includes('calendar.getEventsByProfileIdsAndResourceIds'),
    'a wider window must re-read the calendar',
  );
});

test('--no-cache and a zero TTL both go to Aula', () => {
  const box = sandbox();
  box.run('digest');

  box.reset();
  box.run('digest', '--no-cache');
  assert.ok(box.requests().length > 10, '--no-cache must refetch');

  box.reset();
  box.run('digest', '--cache-ttl', '0');
  assert.ok(box.requests().length > 10, 'a zero TTL must refetch');
});

test('an expired entry is refetched', () => {
  const box = sandbox();
  box.run('messages', '--cache-ttl', '1');
  box.reset();
  Bun.sleepSync(1_200);
  box.run('messages', '--cache-ttl', '1');
  assert.ok(box.requests().includes('messaging.getThreads'), 'a stale entry must not be served');
});

test('cache status reports what is stored, and clear empties it', () => {
  const box = sandbox();
  box.run('digest');

  const { responses, layouts } = json(box.run('cache', 'status'));
  assert.ok(responses.entries > 5);
  assert.ok(responses.byNamespace['messaging.getThreads'] >= 1);
  // Widget tokens expire in about a minute and the expiry retry depends on
  // getting a genuinely fresh one, so they are never stored.
  assert.equal(responses.byNamespace['aulaToken.getAulaToken'], undefined);
  // One entry per widget covers the token *and* the vendor round-trip.
  assert.equal(responses.byNamespace['widget-0004'], 1);
  // The layout cache is reported too. It used to be invisible here and
  // untouched by `clear`, so clearing to force a fresh brief did nothing.
  assert.equal(typeof layouts.entries, 'number');

  assert.equal(json(box.run('cache', 'clear')).cleared, true);
  assert.equal(json(box.run('cache', 'status')).responses.entries, 0);

  box.reset();
  box.run('digest');
  assert.ok(box.requests().length > 10, 'a cleared cache must refetch');
});

// The subtlest interaction in the cache. Widget tokens live about a minute and
// the vendors announce a dead one with HTTP 200, so `WidgetTokens` recovers by
// re-minting. Cache `aulaToken.getAulaToken` and the "fresh" token is the same
// dead string — a routine expiry becomes a hard failure.
test('an expired widget token is still recoverable with the cache on', () => {
  const box = sandbox({ FAKE_AULA_STALE_TOKEN: '1' });
  const plans = json(box.run('weekly-plan'));

  assert.equal(plans.length, 1);
  assert.ok(plans[0].items.length > 0, 'the retry should have produced a plan');
  assert.equal(
    box.requests().filter((r) => r === 'aulaToken.getAulaToken').length,
    2,
    'the retry must mint a genuinely new token, not replay the cached one',
  );
});

test('open without a generated overview fails with a pointer, not a blank page', () => {
  const result = sandbox().run('open');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(cmd('new')), result.stderr);
});

test('schedule refuses a malformed --at before touching the system', () => {
  const result = sandbox().run('schedule', '--at', 'kl-syv');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--at wants/);
});

test('open --web without a configured hosted copy says how to get one', () => {
  const result = sandbox().run('open', '--web');
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(cmd('publish')), result.stderr);
});

// The reported bug this guards against: SkolePortal answered HTTP 500 for the
// daycare children it had never heard of, and the brief presented that as an
// outage. Daycare children must simply never reach a weekly-plan vendor.
test('weekly plans are fetched for school children only, with no warning for the rest', () => {
  const box = sandbox();
  const plans = json(box.run('weekly-plan', '--no-cache'));
  assert.deepEqual(
    plans[0].items.map((i: any) => i.childName),
    ['Alma Eksempelsen'],
  );
  assert.equal(plans[0].warnings, undefined, 'a child with no plan is not a warning');
  assert.deepEqual(
    box.requests().filter((r) => r.startsWith('meebook')),
    ['meebook alma0101'],
    'the daycare child must not appear in the vendor query',
  );
});

test('--page is refused by commands that are not paginated', () => {
  const box = sandbox();
  const result = box.run('messages', '--page', '2');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not accept --page.*otherwise be ignored/);
});

test('--widget bypasses detection and reads the named vendor directly', () => {
  const box = sandbox();
  const plans = json(box.run('weekly-plan', '--widget', '0004', '--no-cache'));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].widgetId, '0004');
  assert.equal(plans[0].provider, 'meebook');
});

test('--widget with an id that has no integration names the supported ones', () => {
  const box = sandbox();
  const result = box.run('weekly-plan', '--widget', '9999', '--no-cache');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No integration for widget "9999"/);
  assert.match(result.stderr, /0004/, 'the error should list the supported ids');
});

test('a failed read is not cached', () => {
  const box = sandbox({ FAKE_AULA_FAIL: 'posts.getAllPosts' });
  assert.notEqual(box.run('posts').code, 0);
  box.reset();
  assert.notEqual(box.run('posts').code, 0);
  assert.ok(
    box.requests().includes('posts.getAllPosts'),
    'a transient failure must not be pinned for the length of the TTL',
  );
});

// Two logins see two different families. Serving one from entries written by
// the other would be a data-protection bug wearing a cache bug's clothes.
test('cached responses belong to one login', () => {
  const box = sandbox();
  box.run('messages');
  box.reset();
  box.run('messages');
  assert.equal(box.requests().length, 0, 'sanity: the same login hits cache');

  box.reset();
  // A different MitID login in the same ~/.aula: re-seed the token store
  // under another username, which is what a family switch actually looks like.
  const reseed = Bun.spawnSync({
    cmd: ['bun', SEED],
    env: { ...process.env, ...box.env, SEED_USERNAME: 'somebody-else' },
  });
  assert.equal(reseed.exitCode, 0, `re-seeding failed: ${reseed.stderr.toString()}`);
  box.run('messages');
  assert.ok(
    box.requests().includes('messaging.getThreads'),
    "a different login must not read the previous login's entries",
  );
});

// ----------------------------------------------------------------- galleries

// An album title is often the best evidence of what a day actually contained,
// so the metadata has to survive the two things Aula does to it: a synthetic
// first row, and a sort order the payload cannot account for.
test('galleries drops the synthetic tagged-media row', () => {
  const { albums } = json(sandbox().run('galleries', '--no-cache'));
  assert.ok(albums.length > 0, 'sanity: the fake serves albums');
  assert.ok(
    !albums.some((a: any) => a.id === null),
    'the id-less "Medier af dig og dine børn" bucket is not an album',
  );
  assert.ok(!albums.some((a: any) => a.title === 'Medier af dig og dine børn'));
});

// Aula orders on mediaCreatedAt and returns creationDate, and the two disagree.
// Trusting the wire order would put a three-week-old album above yesterday's.
test('galleries sorts on the date it actually returns, not the wire order', () => {
  const { albums } = json(sandbox().run('galleries', '--no-cache'));
  const dates = albums.map((a: any) => a.createdAt);
  assert.deepEqual(
    [...dates].sort((a: string, b: string) => a.localeCompare(b)).reverse(),
    dates,
    'newest first by createdAt',
  );
  assert.equal(albums[0].title, 'Tur til stranden');
});

test('galleries carries the metadata that makes an album worth reading', () => {
  const { albums } = json(sandbox().run('galleries', '--no-cache'));
  const beach = albums.find((a: any) => a.title === 'Tur til stranden');
  assert.equal(beach.id, 9001);
  assert.equal(beach.author, 'Yrsa Storm');
  assert.deepEqual(beach.groups, ['2E']);
  assert.ok(!('thumbnailsUrls' in beach), 'signed image URLs are not metadata');
  // thumbnailsUrls is a cover preview capped at one, so any count derived from
  // it would read "1 photo" on every album. Better absent than confidently wrong.
  assert.ok(!('mediaCount' in beach), 'a count that cannot be derived is not reported');
});

test('galleries honours --child, --since and --limit', () => {
  const box = sandbox();
  const viggo = json(box.run('galleries', '--child', 'Viggo', '--no-cache'));
  assert.deepEqual(
    viggo.albums.map((a: any) => a.title),
    ['Sommerfest i Myretuen'],
  );

  // The Myretuen album is 9 days old, so a 7-day window must exclude it —
  // even though it sits above a newer one in the order Aula returns.
  const recent = json(box.run('galleries', '--since', '7d', '--no-cache'));
  assert.deepEqual(
    recent.albums.map((a: any) => a.title),
    ['Tur til stranden', 'Fastelavn i 2E'],
  );

  const one = json(box.run('galleries', '--limit', '1', '--no-cache'));
  assert.equal(one.albums.length, 1);
  assert.equal(
    one.albums[0].title,
    'Tur til stranden',
    '--limit keeps the newest, not the first on the wire',
  );
  assert.equal(one.truncated, true, 'two more albums qualified, and the payload must say so');
  assert.equal(one.limit, 1);
});

test('galleries --text renders titles, dates and photographers', () => {
  const result = sandbox().run('galleries', '--text', '--no-cache');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[9001\] .* — Tur til stranden/);
  assert.match(result.stdout, /by Yrsa Storm → 2E/);
});

// ----------------------------------------------------------------- cut lists

// Twenty rows used to read the same whether twenty or two hundred qualified:
// the list commands printed bare arrays, and the default cap applied even on
// top of a `--since` window. The skill's own `messages --full --since 30d`
// therefore answered with a fraction of a busy month and nothing to show for it.
test('a list cut by the default cap says so, and --since lifts the cap', () => {
  const box = sandbox({ FAKE_AULA_EXTRA_THREADS: '30' });

  const capped = json(box.run('messages', '--no-cache'));
  assert.equal(capped.threads.length, 20);
  assert.equal(capped.truncated, true);
  assert.equal(capped.limit, 20);

  const windowed = json(box.run('messages', '--since', '30d', '--no-cache'));
  assert.equal(windowed.threads.length, 33, 'every thread inside the window, not the newest 20');
  assert.equal(windowed.truncated, false);
  assert.equal(windowed.limit, null);

  const explicit = json(box.run('messages', '--since', '30d', '--limit', '5', '--no-cache'));
  assert.equal(explicit.threads.length, 5);
  assert.equal(explicit.truncated, true, 'a limit the caller chose is still a cut worth stating');
  assert.equal(explicit.limit, 5);
});

test('a list that fits is not reported as cut', () => {
  const box = sandbox();
  const messages = json(box.run('messages', '--no-cache'));
  assert.equal(messages.threads.length, 3);
  assert.equal(messages.truncated, false);

  const posts = json(box.run('posts', '--no-cache'));
  assert.equal(posts.posts.length, 3);
  assert.equal(posts.truncated, false);
  assert.equal(posts.limit, 20);
});

test('--text says when the list was cut', () => {
  const result = sandbox({ FAKE_AULA_EXTRA_THREADS: '30' }).run('messages', '--text', '--no-cache');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /more than 20 matched/);
  assert.match(result.stdout, /--limit/);

  const whole = sandbox().run('messages', '--text', '--no-cache');
  assert.doesNotMatch(whole.stdout, /more than/);
});

test('every command that takes --limit reports the cut it made', () => {
  const shelf = json(
    sandbox({ FAKE_AULA_COMMON_FILES: '5' }).run('commonfiles', '--limit', '2', '--no-cache'),
  );
  assert.equal(shelf.files.length, 2);
  assert.equal(shelf.truncated, true);
  assert.equal(shelf.limit, 2);

  const birthdays = json(
    sandbox({ FAKE_AULA_CONTACT_PAGES: '3' }).run(
      'birthdays',
      '--group',
      '5001',
      '--limit',
      '1',
      '--no-cache',
    ),
  );
  assert.equal(birthdays.birthdays.length, 1);
  assert.equal(birthdays.truncated, true);

  const posts = json(sandbox().run('posts', '--limit', '2', '--no-cache'));
  assert.equal(posts.posts.length, 2);
  assert.equal(posts.truncated, true);
});

// Every sibling answers `--contract`, and the fleet's instructions say this one
// does too. It was `Unknown command "--contract"`, exit 2.
test('--contract answers with no login and no request', () => {
  const result = runWithoutLogin('--contract');
  assert.equal(result.code, 0, result.stderr);
  const slice = JSON.parse(result.stdout);
  const vendored = JSON.parse(readFileSync(join(ROOT, 'contract.json'), 'utf8'));
  assert.equal(slice.contract, vendored.contract);
  assert.deepEqual(slice.exit_codes, vendored.tools.aula.exit_codes);
  assert.deepEqual(slice.body_on, vendored.tools.aula.body_on);
  assert.match(slice.bridge.boundary, /never here/);
  assert.equal(result.requests.length, 0);
});

// ------------------------------------------------------------- the error line

// Every exit without a stdout body ends stderr with one line of compact JSON.
// Until it did, everything an agent could branch on beyond the exit number was
// prose — and for a laptop with no network, a raw stack that called it a bug.
test('every failing exit ends stderr with the error line, and its code names the exit', () => {
  const cases: Array<{
    name: string;
    run: () => RunResult;
    exit: number;
    code: string;
    message: RegExp;
  }> = [
    {
      name: 'an unknown command',
      run: () => runWithoutLogin('not-a-command'),
      exit: 2,
      code: 'USAGE',
      message: /Unknown command/,
    },
    {
      name: 'an unknown flag',
      run: () => runWithoutLogin('messages', '--nope'),
      exit: 2,
      code: 'USAGE',
      message: /--nope/,
    },
    {
      name: 'a flag the command does not take',
      run: () => sandbox().run('thread', '5001', '--child', 'Alma'),
      exit: 2,
      code: 'USAGE',
      message: /does not accept --child/,
    },
    {
      name: 'no stored login',
      run: () => runWithoutLogin('whoami'),
      exit: 5,
      code: 'SETUP',
      message: /Not logged in/,
    },
    {
      name: 'a login Aula will not accept',
      run: () => sandbox({ FAKE_AULA_REJECT_TOKEN: '1' }).run('whoami'),
      exit: 5,
      code: 'SETUP',
      message: /rejected your login/,
    },
    {
      name: 'Aula answering badly',
      run: () => sandbox({ FAKE_AULA_DOWN: '1' }).run('whoami'),
      exit: 1,
      code: 'UPSTREAM',
      message: /having trouble/,
    },
    {
      name: 'no answer at all',
      run: () => sandbox({ FAKE_AULA_UNREACHABLE: '1' }).run('whoami'),
      exit: 1,
      code: 'NETWORK',
      message: /Could not reach Aula/,
    },
    {
      name: 'a method Aula refuses',
      run: () => sandbox({ FAKE_AULA_FAIL: 'posts.getAllPosts' }).run('posts', '--no-cache'),
      exit: 1,
      code: 'UPSTREAM',
      message: /would not let you read/,
    },
  ];

  for (const { name, run, exit, code, message } of cases) {
    const result = run();
    assert.equal(result.code, exit, `${name}: ${result.stderr}`);
    const line = errorLineOf(result.stderr);
    assert.equal(line.code, code, name);
    assert.match(line.message, message, name);
    assert.equal(result.stdout, '', `${name}: an error never puts anything on stdout`);
  }
});

// "Run a MitID login: aula login" reads, to an agent, as the next command to
// run — and a login costs the user an approval on their phone, and an abandoned
// one trips MitID's parallel-session detector for the attempt after it.
test('exit 5 says what still works and who decides about a login, never "log in"', () => {
  const cases: Array<{ name: string; run: () => RunResult }> = [
    { name: 'no stored login', run: () => runWithoutLogin('digest') },
    {
      name: 'a rejected login',
      run: () => sandbox({ FAKE_AULA_REJECT_TOKEN: '1' }).run('whoami'),
    },
    { name: 'refresh-stepup with nothing stored', run: () => runWithoutLogin('refresh-stepup') },
  ];
  for (const { name, run } of cases) {
    const result = run();
    assert.equal(result.code, 5, `${name}: ${result.stderr}`);
    const flat = result.stderr.replace(/\s+/g, ' ');
    assert.match(flat, /still answer without one/, name);
    assert.match(flat, /ask them before starting it/, name);
    assert.doesNotMatch(flat, /Log in again|Run a MitID login|Run `[^`]*login`/i, name);

    const { code, hint } = errorLineOf(result.stderr);
    assert.equal(code, 'SETUP', name);
    assert.match(hint ?? '', /Ask the user before starting/, name);
    assert.match(hint ?? '', /MitID approval on their phone/, name);
  }
});

// A list of what "still works" is only worth printing while it is true.
test('every command exit 5 names really does answer without a session', () => {
  for (const { command } of SESSION_FREE_COMMANDS) {
    const result = runWithoutLogin(command);
    assert.doesNotMatch(result.stderr, /Not logged in/, command);
    // `open` has no overview to show in an empty sandbox, and says so; that is
    // a different exit 5, about the overview, and the point stands: no session
    // was asked for.
    if (command !== 'open') assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, `${command} must not touch the network`);
  }
});

// No network is not a bug in this client. It used to leave as whatever `fetch`
// threw, through the branch that prints a stack.
test('an unreachable Aula is reported in plain language, without a stack', () => {
  const result = sandbox({ FAKE_AULA_UNREACHABLE: '1' }).run('whoami');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.match(errorLineOf(result.stderr).hint ?? '', /network/i);
});

test('exits 0 and 4 carry a body and no error line', () => {
  const box = sandbox();
  for (const args of [['whoami'], ['notifications']]) {
    const result = box.run(...args, '--no-cache');
    assert.ok(result.code === 0 || result.code === 4, args.join(' '));
    assert.doesNotMatch(result.stderr, /\{"error":/, args.join(' '));
  }
});

// `doctor` is the one exit 1 with a body: the report is the point of the
// command. The line still closes stderr, and says where the detail is.
test('a failing doctor keeps its report on stdout and still ends with the error line', () => {
  const result = sandbox({ FAKE_AULA_FAIL: 'presence.getDailyOverview' }).run('doctor');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  const line = errorLineOf(result.stderr);
  assert.equal(line.code, 'UPSTREAM');
  assert.match(line.message, /1 of \d+ checks failed/);
  assert.match(line.hint ?? '', /stdout/);
});

// A pipe is where nobody reads indentation, and where an agent pays for it in
// tokens on every call.
test('JSON is one line when stdout is not a terminal', () => {
  const box = sandbox();
  for (const args of [['whoami'], ['messages'], ['digest'], ['status']]) {
    const result = box.run(...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout.trimEnd().split('\n').length, 1, args.join(' '));
    assert.doesNotThrow(() => JSON.parse(result.stdout), args.join(' '));
  }
  const contract = runWithoutLogin('--contract');
  assert.equal(contract.stdout.trimEnd().split('\n').length, 1);
});

// ---------------------------------------------------------------- attachments

// A presigned URL is the authorisation itself, and one mangled character is a
// 403 that reads like an auth failure — `attachments.ts` has always said they
// must not round-trip through a model. Every payload carried them anyway, and a
// post's attachment had no download command, so copying the URL out of the JSON
// was the only way to fetch it.
test('no payload carries a signed URL', () => {
  const box = sandbox({ FAKE_AULA_COMMON_FILES: '3' });
  for (const args of [
    ['digest'],
    ['thread', '5001'],
    ['messages', '--full'],
    ['posts'],
    ['attachments', '5001'],
    ['commonfiles'],
    ['thread', '5001', '--text'],
    ['posts', '--text'],
  ]) {
    const result = box.run(...args, '--no-cache');
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Signature=/, `${args.join(' ')} leaked a signed URL`);
    assert.doesNotMatch(result.stdout, /files\.eksempel\.dk/, args.join(' '));
  }
});

test('attachments are numbered across the thread, the same way everywhere', () => {
  const box = sandbox();
  const expected = [
    { index: 0, id: 401, name: 'Tilmelding', kind: 'link' },
    { index: 1, id: 402, name: 'Pakkeliste.pdf', kind: 'file' },
    { index: 2, id: 403, name: 'Sovepose.jpg', kind: 'media' },
  ];
  const pick = (rows: any[]) =>
    rows.map((a) => ({ index: a.index, id: a.id, name: a.name, kind: a.kind }));

  const listed = json(box.run('attachments', '5001', '--no-cache'));
  assert.deepEqual(pick(listed.attachments), expected);
  assert.equal(listed.attachments[2].from, 'Far Eksempelsen');
  // A link is content somebody pasted, not a signed download, so it stays.
  assert.equal(listed.attachments[0].link, 'https://tilmelding.eksempel.dk/lejrskole');
  assert.equal(listed.attachments[1].link, null);

  const thread = json(box.run('thread', '5001', '--no-cache'));
  assert.deepEqual(pick(thread.messages.flatMap((m: any) => m.attachments)), expected);

  const digest = json(box.run('digest', '--no-cache'));
  const inDigest = digest.threads.find((t: any) => t.id === 5001);
  assert.deepEqual(pick(inDigest.messages.flatMap((m: any) => m.attachments)), expected);
});

// A position counts from the thread's first message, so one page of a thread
// cannot know it. Null is honest; a page-local 0 would download another file.
test('one page of a thread gives its attachments no index', () => {
  const box = sandbox({ FAKE_AULA_THREAD_PAGE_SIZE: '2' });
  const page = json(box.run('thread', '5001', '--page', '1', '--no-cache'));
  const attachments = page.messages.flatMap((m: any) => m.attachments);
  assert.equal(attachments.length, 3);
  assert.ok(attachments.every((a: any) => a.index === null));

  // `attachments` took --page too, and numbered that page from zero.
  const refused = box.run('attachments', '5001', '--page', '1');
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /does not accept --page/);
});

test('attachment downloads by index, and never prints where it came from', () => {
  const box = sandbox();
  const out = join(box.dir, 'pakkeliste.pdf');
  const result = box.run('attachment', '5001', '1', '--out', out, '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.path, out);
  assert.equal(saved.filename, 'Pakkeliste.pdf');
  assert.equal(readFileSync(out, 'utf8'), 'bytes of Pakkeliste.pdf');
  assert.doesNotMatch(result.stdout, /Signature=/);
  assert.ok(box.requests().includes('download Pakkeliste.pdf'));

  const link = box.run('attachment', '5001', '0', '--no-cache');
  assert.equal(link.code, 2, 'a link has no bytes to download');
  assert.match(link.stderr, /is a link, not a file/);
});

test("post-attachment downloads a post's file by the index posts shows", () => {
  const box = sandbox();
  const { posts } = json(box.run('posts', '--no-cache'));
  const plan = posts.find((p: any) => p.id === 7001);
  assert.deepEqual(plan.attachments, [
    { index: 0, id: 501, name: 'Ugeplan uge 33.pdf', kind: 'file', link: null },
  ]);

  const out = join(box.dir, 'ugeplan.pdf');
  const result = box.run('post-attachment', '7001', '0', '--out', out, '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).filename, 'Ugeplan uge 33.pdf');
  assert.equal(readFileSync(out, 'utf8'), 'bytes of Ugeplan uge 33.pdf');
  assert.doesNotMatch(result.stdout, /Signature=/);

  // The index defaults to the first attachment, as it does for `attachment`.
  const byDefault = box.run('post-attachment', '7001', '--out', out, '--no-cache');
  assert.equal(byDefault.code, 0, byDefault.stderr);
});

test('post-attachment names what is wrong with a bad post id or index', () => {
  const box = sandbox();
  const noPost = box.run('post-attachment', '7999', '--no-cache');
  assert.equal(noPost.code, 2);
  assert.match(noPost.stderr, /No post 7999 is visible to this login/);

  const noIndex = box.run('post-attachment', '7001', '4', '--no-cache');
  assert.equal(noIndex.code, 2);
  assert.match(noIndex.stderr, /has 1 attachment\(s\); there is no index 4/);
  assert.match(noIndex.stderr, /\[0\] Ugeplan uge 33\.pdf/);

  const none = box.run('post-attachment', '7002', '--no-cache');
  assert.equal(none.code, 2);
  assert.match(none.stderr, /has 0 attachment\(s\)/);
});

test('commonfile still downloads, from a URL commonfiles no longer prints', () => {
  const box = sandbox({ FAKE_AULA_COMMON_FILES: '3' });
  const { files } = json(box.run('commonfiles', '--no-cache'));
  assert.ok(files.every((f: any) => !('url' in f)));
  assert.equal(files[0].status, 'available');

  const out = join(box.dir, 'faelles.pdf');
  const result = box.run('commonfile', '2', '--out', out, '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'bytes of Faelles fil 2.pdf');
});

// ------------------------------------------------------------- the exit table

// Exit 4 was in the contract, the skill and `EXIT` for as long as this repo has
// used the shared table, and nothing ever returned it: an empty inbox left at
// exit 0, so an agent branching on the code read "nothing" as a result.
test('an empty answer is exit 4 with its body still on stdout', () => {
  const box = sandbox();
  const cases: Array<{ args: string[]; body: unknown }> = [
    { args: ['notifications'], body: [] },
    // The Viggo thread is already read, so nothing unread concerns him.
    {
      args: ['messages', '--unread', '--child', 'Viggo'],
      body: { threads: [], truncated: false, limit: 20 },
    },
    // The newest album is two days old.
    { args: ['galleries', '--since', '1d'], body: { albums: [], truncated: false, limit: null } },
    { args: ['commonfiles'], body: { files: [], truncated: false, limit: null } },
  ];
  for (const { args, body } of cases) {
    const result = box.run(...args, '--no-cache');
    assert.equal(result.code, 4, `${args.join(' ')}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), body, args.join(' '));
  }

  const pickups = box.run('pickup-times', '--no-cache');
  assert.equal(pickups.code, 4);
  assert.deepEqual(JSON.parse(pickups.stdout).days, []);

  const attachments = box.run('attachments', '5002', '--no-cache');
  assert.equal(attachments.code, 4);
  assert.deepEqual(JSON.parse(attachments.stdout).attachments, []);
});

test('an answer with anything in it is still exit 0', () => {
  const box = sandbox();
  for (const args of [['messages'], ['posts'], ['calendar'], ['presence'], ['groups']]) {
    assert.equal(box.run(...args, '--no-cache').code, 0, args.join(' '));
  }
});

// `digest` is a dozen reads in one payload, and one of them coming back empty
// says nothing about the rest.
test('digest never exits 4, however little one of its reads returned', () => {
  const result = sandbox({ FAKE_AULA_EMPTY_POSTS: '1' }).run('digest', '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).posts, []);
});

// Only positive evidence of emptiness is "nothing". Every attachment in 5001
// sits on its second page, so a read that lost that page sees none — and that
// proves nothing about the thread.
test('a thread that could not be read to the end is never "no attachments"', () => {
  const box = sandbox({
    FAKE_AULA_THREAD_PAGE_SIZE: '2',
    FAKE_AULA_FAIL_THREAD_PAGE: '5001:1',
  });
  const result = box.run('attachments', '5001', '--no-cache');
  assert.equal(result.code, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.attachments, []);
  assert.equal(listed.messagesIncomplete, true);
});

// The fixture school has Meebook and nothing else. That is an answer about the
// school, and it used to be a stack trace at exit 1.
test('a capability no school offers is exit 4, not a crash', () => {
  const result = sandbox().run('weekly-letter', '--no-cache');
  assert.equal(result.code, 4, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.match(result.stderr, /No weekly-letter widget is enabled/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'a normal answer must not print a stack');
});

test('an unknown cache subcommand is a usage error', () => {
  const result = sandbox().run('cache', 'purge');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown cache subcommand "purge"/);
  assert.equal(result.stdout, '');
});

// Through `raw` the caller typed the method name. Both of these left at exit 1,
// the fleet's "a source is down, retry later" — so an agent that had just asked
// a read-only tool to send a message was told to try again in a minute.
test('raw refuses a write as a usage error, before a request is sent', () => {
  const box = sandbox();
  const result = box.run('raw', 'messaging.sendMessage', 'text=hej');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /read-only/);
  assert.equal(result.stdout, '');
  assert.equal(result.requests.length, 0, 'the guard runs before any socket opens');
});

test('raw with a method Aula does not have blames the spelling, not the client', () => {
  const result = sandbox().run('raw', 'posts.getNothingAtAll', '--no-cache');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Aula has no method called "posts\.getNothingAtAll"/);
  assert.match(result.stderr, /Check the spelling/);
  assert.doesNotMatch(result.stderr, /bug in aula-cli/);
});

// 5, not the literal 2 the old scheme left behind: no retry brings a dead
// broker session back, and nothing about the command line is wrong.
test('refresh-stepup with a lapsed broker session is exit 5', () => {
  const result = sandbox({ FAKE_AULA_BROKER_EXPIRED: '1' }).run('refresh-stepup');
  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /broker session has expired/);
});

// -------------------------------------------------------------------- doctor

test('doctor walks every endpoint and reports timing', () => {
  const box = sandbox();
  const report = json(box.run('doctor'));

  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 0);
  const names = report.checks.map((c: any) => c.name);
  for (const method of [
    'profiles.getProfilesByLogin',
    'profiles.getProfileContext',
    'messaging.getThreads',
    'messaging.getMessagesForThread',
    'posts.getAllPosts',
    'gallery.getAlbums',
    'calendar.getEventsByProfileIdsAndResourceIds',
    'presence.getDailyOverview',
    'presence.getPresenceTemplates',
    'groups.getGroupsByContext',
    'profiles.getContactlist',
    'notifications.getNotificationsForActiveProfile',
    'commonFiles.getCommonFiles',
  ]) {
    assert.ok(names.includes(method), `doctor should check ${method}`);
  }
  assert.ok(names.some((n: string) => n.startsWith('aulaToken.getAulaToken (')));
  assert.ok(names.some((n: string) => n.startsWith('widget read (')));
  for (const check of report.checks) {
    assert.equal(typeof check.ms, 'number', `${check.name} should be timed`);
  }
});

// The whole point of the command: a passing test suite says nothing about the
// live API, so doctor must never answer from a cache the suite filled in.
test('doctor never answers from the cache', () => {
  const box = sandbox();
  box.run('digest');
  box.reset();
  box.run('doctor');
  assert.ok(box.requests().length > 10, 'doctor must make every call for real');
});

// API.md's central point: the dangerous responses are the successful-looking
// ones. A check that returns a known symptom is a warning, not a pass — and not
// a failure either, because nothing errored.
test('doctor warns on the responses that look successful but are not', () => {
  const noStepUp = json(sandbox({ FAKE_AULA_NO_STEPUP: '1' }).run('doctor'));
  const stepUp = noStepUp.checks.find((c: any) => c.name === 'session step-up');
  assert.equal(stepUp.status, 'warn');
  assert.match(stepUp.note, /sensitive threads/);
  assert.equal(noStepUp.ok, true, 'a warning is not a failure');

  const noPosts = json(sandbox({ FAKE_AULA_EMPTY_POSTS: '1' }).run('doctor'));
  const posts = noPosts.checks.find((c: any) => c.name === 'posts.getAllPosts');
  assert.equal(posts.status, 'warn');
  assert.match(posts.note, /id set/);
});

test('doctor exits non-zero when an endpoint is broken, and keeps checking', () => {
  const result = sandbox({ FAKE_AULA_FAIL: 'presence.getDailyOverview' }).run('doctor');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);

  const failed = report.checks.find((c: any) => c.name === 'presence.getDailyOverview');
  assert.equal(failed.status, 'fail');
  assert.ok(failed.note.length > 0, 'a failure should say what Aula said');

  // One dead endpoint must not stop the walk — that is the whole reason the
  // checks are independent.
  const after = report.checks.find((c: any) => c.name === 'commonFiles.getCommonFiles');
  assert.equal(after.status, 'ok');
});

test('doctor --text is readable and marks each check', () => {
  const result = sandbox().run('doctor', '--text');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /aula doctor — API v\d+/);
  assert.match(result.stdout, /\[PASS\] messaging\.getThreads/);
  assert.match(result.stdout, /passed, \d+ warned/);
});

test('contact and shared-file commands have no hidden legacy page ceilings', () => {
  const contacts = json(
    sandbox({ FAKE_AULA_CONTACT_PAGES: '55' }).run('contacts', '--group', '5001'),
  );
  assert.equal(contacts.length, 55);

  const shelf = json(sandbox({ FAKE_AULA_COMMON_FILES: '550' }).run('commonfiles'));
  assert.equal(shelf.files.length, 550);
  assert.equal(shelf.truncated, false);
  assert.equal(shelf.limit, null, 'nothing capped the read, so no limit is claimed');
});

// ------------------------------------------------------------- hosted copy

const ARTIFACT = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A sandbox whose `claude` is the fake, answering as told. */
function sandboxWithClaude(mode: string, result?: string) {
  const box = sandbox();
  const fake = installFakeClaude(join(box.dir, 'fakebin'));
  box.env.PATH = fake.path;
  box.env.FAKE_CLAUDE_MODE = mode;
  if (result !== undefined) {
    box.env.FAKE_CLAUDE_RESULT_JSON = JSON.stringify(result);
    if (result.trim().startsWith('{')) box.env.FAKE_CLAUDE_STRUCTURED_JSON = result;
  }
  return box;
}

test('calendar connector discovery and fetch failures are explicit non-zero results', () => {
  // The fake answers with a `result` envelope and no `init` line, so the
  // session reported no servers at all. That is the one branch that must not
  // be stated as "Google Calendar is not connected": it is also what a race
  // against the connector's own startup looked like, and asserting the
  // conclusion sent people to reconnect something already connected.
  const missing = sandboxWithClaude('ok').run('calendars');
  // 5, the fleet's "setup required — do not retry unchanged". This was 1,
  // which every sibling reads as "a source is down, retry later", so an agent
  // driving the fleet would loop on a state that only a person can change.
  assert.equal(missing.code, 5);
  assert.match(missing.stderr, /reported no MCP servers at all/);
  assert.doesNotMatch(missing.stderr, /^Google Calendar is not connected/m);
  assert.match(missing.stderr, /Settings.*Connectors.*Google Calendar/s);

  // A `claude` that ran and failed is the opposite case: something is down and
  // retrying is exactly the right advice, so it keeps exit 1.
  const failed = sandboxWithClaude('error').run('calendars');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Could not ask Claude for your calendars/);
  assert.match(failed.stderr, /Not logged in/);
});

/**
 * A sandbox whose `claude` answers one scripted connector session per call.
 *
 * The `ok` fake cannot do this: it emits a `result` envelope with no `init`
 * line and no tool call, which is a *broken* connector. Everything below the
 * "is it connected" branch — resolving a name, saving it, reading the receipt
 * back — therefore had no end-to-end coverage at all.
 */
function sandboxWithConnector(sessions: unknown[][]) {
  const box = sandboxWithClaude('stream');
  const file = join(box.dir, 'session.ndjson');
  const write = (path: string, lines: unknown[]) =>
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  sessions.forEach((lines, index) => write(`${file}.${index + 1}`, lines));
  write(file, sessions.at(-1) ?? []);
  box.env.FAKE_CLAUDE_STREAM_FILE = file;
  box.env.FAKE_CLAUDE_LOG = join(box.dir, 'claude-calls.log');
  writeFileSync(box.env.FAKE_CLAUDE_LOG, '');
  return box;
}

const CONNECTED = {
  type: 'system',
  subtype: 'init',
  mcp_servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }],
};

/** One scripted connector call: the tool_use we expect, and its payload. */
const connectorCall = (tool: string, input: unknown, payload: unknown) => [
  CONNECTED,
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: `mcp__claude_ai_Google_Calendar__${tool}`, input },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify(payload) }],
    },
  },
];

const CALENDARS = connectorCall(
  'list_calendars',
  { pageSize: 250 },
  {
    calendars: [
      { id: 'familien@eksempel.dk', summary: 'Familien' },
      { id: 'arbejde@eksempel.dk', summary: 'Arbejde' },
    ],
  },
);

test('calendars lists what the connector sees and marks what is read', () => {
  const box = sandboxWithConnector([CALENDARS]);
  const listed = box.run('calendars');
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /"Familien"/);
  assert.match(listed.stdout, /"Arbejde"/);
  assert.match(listed.stdout, /reads none of them yet/);
});

test('a calendar name that is wrong is a usage error, not an outage', () => {
  const box = sandboxWithConnector([CALENDARS]);
  const wrong = box.run('calendars', 'set', 'Nothing like it');
  // 2, not 1: the name came off the command line. It used to share exit 1 with
  // "Aula is down", which is the one reading that makes an agent retry.
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /No calendar named "Nothing like it"/);
});

test('a name that differs only in case still names its calendar', () => {
  const box = sandboxWithConnector([CALENDARS]);
  // Already selected, so `set` settles without the receipt read a newly started
  // calendar triggers — the subject here is resolution, not the receipt.
  writeFileSync(
    join(box.dir, 'config.json'),
    JSON.stringify({ calendars: [{ id: 'familien@eksempel.dk', name: 'Familien' }] }),
  );
  // The agent is copying this out of a checkbox question a person answered,
  // which is where the case and the spaces go. `No calendar named "familien"`
  // about a calendar in the list directly above taught nobody anything.
  const set = box.run('calendars', 'set', '  familien ');
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Already reading "Familien"/);
});

test('dropping a saved calendar needs no connector at all', () => {
  const box = sandboxWithClaude('ok');
  writeFileSync(
    join(box.dir, 'config.json'),
    JSON.stringify({ calendars: [{ id: 'familien@eksempel.dk', name: 'Familien' }] }),
  );
  const none = box.run('calendars', 'set', 'none');
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /Stopped reading "Familien"/);
  // The whole point: unticking must keep working while the connector does not.
  assert.equal(none.stderr, '');
});

test('publish creates the artifact, saves its url to config.json, and records the deploy', () => {
  const box = sandboxWithClaude('ok', `Deployed: ${ARTIFACT}`);
  mkdirSync(join(box.dir, 'brief'), { recursive: true });
  writeFileSync(join(box.dir, 'brief', 'artifact.html'), '<title>x</title>');

  const created = box.run('publish');
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.stdout.trim(), ARTIFACT);
  assert.match(created.stderr, /new artifact/);
  assert.equal(
    JSON.parse(readFileSync(join(box.dir, 'config.json'), 'utf8')).artifactUrl,
    ARTIFACT,
  );
  const state = JSON.parse(readFileSync(join(box.dir, 'brief', 'state.json'), 'utf8'));
  assert.equal(state.lastDeploy.url, ARTIFACT);

  // Configured now, so a second publish redeploys rather than creates.
  const again = box.run('publish');
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /Redeploying/);

  const off = box.run('publish', '--off');
  assert.equal(off.code, 0);
  assert.match(off.stdout, /off/);
  assert.equal(
    JSON.parse(readFileSync(join(box.dir, 'config.json'), 'utf8')).artifactUrl,
    undefined,
  );
});

test('publish takes no arguments — there is one way to get a url, and it is publish itself', () => {
  const box = sandboxWithClaude('ok', ARTIFACT);
  const result = box.run('publish', ARTIFACT);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /takes no arguments/);
  assert.equal(existsSync(join(box.dir, 'config.json')), false);
});

test('publish with no overview yet says what to do first', () => {
  const box = sandboxWithClaude('ok', ARTIFACT);
  const result = box.run('publish');
  // 5, "setup required — do not retry unchanged". It was 1, which says a source
  // is down and a retry may help; no retry writes the overview `publish` needs.
  assert.equal(result.code, 5);
  assert.equal(errorLineOf(result.stderr).code, 'SETUP');
  assert.ok(result.stderr.includes(cmd('new')), result.stderr);
});

test('a failed publish leaves no url behind', () => {
  const box = sandboxWithClaude('denied');
  mkdirSync(join(box.dir, 'brief'), { recursive: true });
  writeFileSync(join(box.dir, 'brief', 'artifact.html'), '<title>x</title>');
  const result = box.run('publish');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Artifact/);
  assert.equal(existsSync(join(box.dir, 'config.json')), false);
});

test('new --catch-up does nothing — not even a request — once this slot is complete', () => {
  const box = sandbox();
  mkdirSync(join(box.dir, 'brief'), { recursive: true });
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  writeFileSync(
    join(box.dir, 'brief', 'state.json'),
    JSON.stringify({ seen: {}, lastRun: { day, at: today.toISOString(), complete: true } }),
  );
  const result = box.run('new', '--catch-up', '--text');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /allerede opdateret/);
  assert.deepEqual(result.requests, []);
});

/**
 * The regression that left the family's hosted page two days stale. The check
 * used to be `todayIsComplete`, so the 18:00 run read the 06:00 run's
 * `complete: true`, decided the day was covered and generated nothing —
 * the evening overview could never have existed.
 *
 * Stamped one minute before whatever slot the clock is in right now, so the
 * assertion means the same thing whatever time of day the suite runs at.
 */
test('new --catch-up regenerates when the complete run belongs to the previous slot', () => {
  const box = sandbox();
  mkdirSync(join(box.dir, 'brief'), { recursive: true });
  const previousSlot = new Date(currentSlotStart(new Date()).getTime() - 60_000);
  const day = `${previousSlot.getFullYear()}-${String(previousSlot.getMonth() + 1).padStart(2, '0')}-${String(previousSlot.getDate()).padStart(2, '0')}`;
  writeFileSync(
    join(box.dir, 'brief', 'state.json'),
    JSON.stringify({
      seen: {},
      lastRun: { day, at: previousSlot.toISOString(), complete: true },
    }),
  );
  const result = box.run('new', '--catch-up', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.requests.length > 0, 'the new slot should be generated');
});

test('new --catch-up runs when the last run was incomplete', () => {
  const box = sandbox();
  mkdirSync(join(box.dir, 'brief'), { recursive: true });
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  writeFileSync(
    join(box.dir, 'brief', 'state.json'),
    JSON.stringify({ seen: {}, lastRun: { day, at: today.toISOString(), complete: false } }),
  );
  // Rules only and no deploy, so the run needs neither claude nor a target —
  // and on those terms it is complete.
  const result = box.run('new', '--catch-up', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.requests.length > 0, 'the incomplete day should be generated again');
  const out = JSON.parse(result.stdout);
  assert.equal(out.complete, true);
  const state = JSON.parse(readFileSync(join(box.dir, 'brief', 'state.json'), 'utf8'));
  assert.equal(state.lastRun.complete, true);
  assert.equal(state.lastRun.day, day);
});

test('every completed brief records revision and phase timings privately', () => {
  const box = sandbox();
  const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);

  const entries = readFileSync(join(box.dir, 'logs', 'brief.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const finished = entries.find((entry) => entry.event === 'brief.run.finished');

  assert.ok(finished, 'completed runs should be diagnosable after the terminal closes');
  assert.equal(finished.details.complete, true);
  assert.equal(typeof finished.details.totalMs, 'number');
  assert.equal(typeof finished.details.phaseMs.collect, 'number');
  assert.equal(typeof finished.details.phaseMs.render, 'number');
  assert.equal(finished.revision.commit?.length, 40);
  assert.equal(typeof finished.revision.dirty, 'boolean');
});

test('a brief reads the weekly plan for this week and the next', () => {
  // `digest` reads one week; the brief's timeline runs to the end of next
  // week, so it asks the vendor twice. The fake records one line per request.
  const box = sandbox();
  const digest = box.run('digest');
  assert.equal(digest.code, 0, digest.stderr);
  assert.equal(digest.requests.filter((line) => line.startsWith('meebook ')).length, 1);

  box.reset();
  const brief = box.run('new', '--no-llm', '--no-deploy', '--no-open', '--no-cache');
  assert.equal(brief.code, 0, brief.stderr);
  assert.equal(brief.requests.filter((line) => line.startsWith('meebook ')).length, 2);
});

test('a brief with no hosted copy configured says so and still counts as complete', () => {
  // The deploy is deliberately left on: every other `new` test passes
  // `--no-deploy`, which is how a lost `artifactUrl` stayed invisible. Both
  // produced the same silent `skipped`, so an installation whose config had
  // gone missing published nothing and reported success every morning. With no
  // target configured this returns before spawning anything, so the test costs
  // no subprocess.
  const box = sandbox();
  const result = box.run('new', '--no-llm', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.deployed, null);
  // Not a failure, and it must never become one: retrying cannot create a URL,
  // so an incomplete run here would put the scheduler into an all-day loop.
  assert.equal(out.complete, true);
  assert.ok(
    out.notes.some((note: string) => note.includes(cmd('publish'))),
    `the run must name the command that fixes it, got: ${JSON.stringify(out.notes)}`,
  );
});

test('a model outage is prominent on the page and leaves private diagnostics', () => {
  const box = sandboxWithClaude('error');
  const result = box.run('new', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.layout, 'fallback');
  assert.equal(output.complete, false);

  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  const warningAt = page.indexOf('data-block="overview-warning"');
  assert.ok(warningAt >= 0, 'the model failure must be visible without opening a fold');
  assert.ok(warningAt < page.indexOf('class="topline"'));
  assert.ok(warningAt < page.indexOf('data-section="cards"'));
  assert.match(page, /Modellen kunne ikke prioritere indholdet/);
  assert.doesNotMatch(page, /Not logged in/, 'technical detail belongs in the developer log');
  assert.match(page, /<footer>Genereret \d{1,2}\. \S+ \d{4} kl\. \d{2}:\d{2}<\/footer>/);

  const logPath = join(box.dir, 'logs', 'brief.jsonl');
  const entries = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const logged = entries.find((entry) => entry.event === 'brief.model.failed');
  assert.ok(logged, 'model failure should be logged');
  assert.equal(logged.event, 'brief.model.failed');
  assert.match(logged.details.message, /Not logged in/);
  assert.match(logged.details.details.attempts[0].stdout, /Not logged in/);
  assert.equal(entries[0]?.event, 'brief.run.started');
  assert.ok(entries.some((entry) => entry.event === 'brief.phase.finished'));
  assert.equal(logged.revision.commit?.length, 40);
  assert.ok(output.notes.includes(`Udviklerlog: ${logPath}`));
});

test('a retryable read failure is rendered and leaves catch-up eligible', () => {
  const box = sandbox({ FAKE_AULA_FAIL: 'presence.getDailyOverview' });
  const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.complete, false);
  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Komme\/gå-status kunne ikke hentes/);
  const state = JSON.parse(readFileSync(join(box.dir, 'brief', 'state.json'), 'utf8'));
  assert.equal(state.lastRun.complete, false);
});

test('optional source failures never masquerade as validated empty sections', () => {
  const cases = [
    ['groups.getGroupsByContext', /klasse- og gruppetilknytning kunne ikke hentes/],
    ['gallery.getAlbums', /Gallerioversigten kunne ikke hentes/],
    ['calendar.getEventsByProfileIdsAndResourceIds', /Aula-kalenderen kunne ikke hentes/],
  ] as const;
  for (const [method, warning] of cases) {
    const box = sandbox({ FAKE_AULA_FAIL: method });
    const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
    assert.equal(result.code, 0, `${method}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).complete, false, method);
    const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
    assert.match(page, warning);
    if (method === 'calendar.getEventsByProfileIdsAndResourceIds') {
      assert.doesNotMatch(page, /Aula-kalenderen er tom for perioden/);
    }
  }
});

// -------------------------------------------------- unreadable message threads

// A thread whose body Aula refuses still arrives with its subject, because the
// subject comes off the thread *list*. So it used to render as a perfectly
// ordinary card with nothing in it — the one failure the finished page could
// not show. `withFullMessages` hides the error on purpose (one bad thread must
// not sink the digest), and BRIEF.md's promise is that a missing section and a
// failed fetch look different. These two are that promise.
test('a thread whose messages cannot be fetched is named on the page, not silently emptied', () => {
  const box = sandbox({ FAKE_AULA_FAIL_THREAD: '5001' });
  const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);

  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Beskederne i tråden «Lejrskole for 2E» kunne ikke hentes/);
  // The other two were readable, so nothing else may be claimed as missing.
  assert.ok(!/tråde kunne ikke hentes/.test(page), 'only one thread failed');

  // Nothing reported the page as short of a required warning: `validate.ts`
  // rule 3 checks each `warn` note reached the HTML, and a miss would land in
  // `notes` as a rejected layout rather than failing the run.
  const notes: string[] = JSON.parse(result.stdout).notes;
  assert.deepEqual(
    notes.filter((n) => /datastatus/.test(n)),
    [],
  );
});

test('a total messaging outage is one line naming a few, not one warning per thread', () => {
  const box = sandbox({ FAKE_AULA_FAIL: 'messaging.getMessagesForThread' });
  const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);

  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Beskederne i 3 tråde kunne ikke hentes/);
  assert.match(page, /heriblandt «Lejrskole for 2E» og «Lukkedag i Myretuen»/);
  assert.equal(page.match(/kunne ikke hentes/g)?.length, 1, 'three failures, one line');
});

test('thread commands and the brief read every message page', () => {
  const box = sandbox({ FAKE_AULA_THREAD_PAGE_SIZE: '2' });
  const thread = json(box.run('thread', '5001'));
  assert.equal(thread.messages.length, 4);
  assert.equal(thread.moreMessagesExist, false);

  const brief = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(brief.code, 0, brief.stderr);
  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Perfekt, tak/);
  assert.doesNotMatch(page, /Ikke alle beskeder i tråden «Lejrskole/);
});

test('a later thread-page failure preserves evidence, warns, and leaves the run incomplete', () => {
  const box = sandbox({
    FAKE_AULA_THREAD_PAGE_SIZE: '2',
    FAKE_AULA_FAIL_THREAD_PAGE: '5001:1',
  });
  const thread = json(box.run('thread', '5001'));
  assert.equal(thread.messagesIncomplete, true);
  assert.match(thread.messageReadWarning, /side 2/);
  assert.equal(thread.messages.length, 2);

  const attachments = json(box.run('attachments', '5001'));
  assert.equal(attachments.messagesIncomplete, true);
  assert.deepEqual(attachments.attachments, []);

  const download = box.run('attachment', '5001');
  assert.notEqual(download.code, 0);
  assert.match(download.stderr, /Could not read every message/);

  const result = box.run('new', '--no-llm', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false);
  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Ikke alle beskeder i tråden «Lejrskole for 2E» kunne hentes/);
  assert.match(page, /Skal de have madpakke med begge dage/);
});

// -------------------------------------------------------------- preferences

test('remember, preferences, forget — the curation round trip', () => {
  const box = sandbox();
  const path = join(box.dir, 'preferences.md');

  // A fresh install already has opinions, and says so. Before this they were
  // sentences in the extraction prompt that no user could see or change.
  assert.equal(existsSync(path), false);
  const shipped = box.run('preferences');
  assert.equal(shipped.code, 0, shipped.stderr);
  assert.match(shipped.stdout, /1\. Det vigtigste for mig/);
  assert.match(shipped.stdout, /5\. Fællesbeskeder til alle forældre i kommunen/);
  assert.ok(existsSync(path), 'the defaults are written down, not held in code');

  const remembered = box.run('remember', 'beskeder fra John (Hjaltes far) er altid vigtige');
  assert.equal(remembered.code, 0, remembered.stderr);
  assert.match(remembered.stdout, /Remembered:/);
  assert.match(
    readFileSync(path, 'utf8'),
    /^- beskeder fra John \(Hjaltes far\) er altid vigtige$/m,
  );
  assert.match(box.run('preferences').stdout, /6\. beskeder fra John/);

  // Claude will say it twice sooner or later; twice is still once.
  assert.match(
    box.run('remember', 'Beskeder fra John (Hjaltes far) er ALTID vigtige').stdout,
    /Already remembered/,
  );

  // The point of the exercise: a shipped opinion the family disagrees with
  // can be dropped, and stays dropped.
  const forgotten = box.run('forget', '5');
  assert.equal(forgotten.code, 0, forgotten.stderr);
  assert.match(forgotten.stdout, /Forgotten: "Fællesbeskeder/);
  const after = box.run('preferences');
  assert.ok(!/kommunen/.test(after.stdout), 'the dropped default must not come back');
  assert.match(after.stdout, /5\. beskeder fra John/);

  const bad = box.run('forget', 'den om John');
  assert.notEqual(bad.code, 0);
  assert.ok(bad.stderr.includes(cmd('preferences')), bad.stderr);
});

test('a remembered wish reaches the model that writes the overview', () => {
  // The wiring failure this file exists for: every piece works in isolation
  // and the preference still never leaves the disk.
  const box = sandboxWithClaude('ok', 'ikke JSON');
  const log = join(box.dir, 'claude-calls.log');
  box.env.FAKE_CLAUDE_LOG = log;
  box.run('remember', 'beskeder fra John (Hjaltes far) er altid vigtige');

  const result = box.run('new', '--no-deploy', '--no-open');
  assert.equal(result.code, 0, result.stderr);

  // The fake logs argv and nothing else, so a hit here is proof the wish
  // travelled in the instructions — not on stdin, where the school's own
  // untrusted prose goes.
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /beskeder fra John \(Hjaltes far\) er altid vigtige/);
  assert.match(calls, /brugerens egen liste/);
  assert.match(calls, /Brug dem ikke til at analysere sammenfald/);
  // …and so do the opinions the tool ships with, by the same route.
  assert.match(calls, /Fællesbeskeder til alle forældre i kommunen/);
});

test("the model's cards and hides reach the page — the whole return leg", () => {
  // The companion to the test above: that one proves a wish reaches the model,
  // this one proves the model's answer reaches the page. Between them they
  // cover the round trip, and the return leg is the half with no second
  // opinion behind it: the model's cards are the cards, and its `hidden` is
  // the only path from the user's list to something not being shown. Every
  // piece of that path is unit-tested and the wiring is not: disconnecting it
  // (index.ts dropping a field, rank() called without `hidden`) leaves every
  // other test in this repo green.
  const answer = JSON.stringify({
    topline: 'Rolig uge.',
    // thread:5002 is about one child; thread:5003 is the fake school's
    // "Til alle forældre".
    cards: [
      {
        title: 'Svar Yrsa om mødet',
        summary: 'Yrsa spørger om en dato.',
        children: [],
        date: null,
        needsAction: true,
        reason: 'Beskeden er rettet til jer om jeres barn.',
        sourceKeys: ['thread:5002'],
      },
    ],
    personalEvents: [],
    childSummaries: {},
    hidden: ['thread:5003'],
  });
  const box = sandboxWithClaude('ok', answer);

  const result = box.run('new', '--no-deploy', '--no-open', '--text', '--explain');
  assert.equal(result.code, 0, result.stderr);
  // Exactly the model's one card; one source hidden, as the model said.
  assert.match(result.stdout, /1 kort, 1 kilde\(r\) skjult — modellen skrev kortene/);
  assert.match(result.stderr, /1 Aula-kort, 0 kalenderkort, .* 1 skjult/);
  assert.doesNotMatch(result.stderr, /rule-made/);
  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Svar Yrsa om mødet/);
  assert.match(page, /<summary>1 skjult<\/summary>/);
  assert.match(page, /Vist fordi:<\/b> Beskeden er rettet til jer/);
});

test('a reused layout says so, and --no-cache forces a fresh one', () => {
  // The extraction cache is keyed on payload + prompt + schema with no TTL, so
  // an unchanged morning answers in milliseconds. `layout: "model"` is true of
  // both a fresh call and a reused one, which made a two-second run look
  // identical to a four-minute one from the outside.
  const answer = JSON.stringify({
    topline: 'Genbrugt svar.',
    cards: [
      {
        title: 'Svar Yrsa om mødet',
        summary: 'Yrsa spørger om en dato.',
        children: [],
        date: null,
        needsAction: true,
        reason: 'Beskeden er rettet til jer om jeres barn.',
        sourceKeys: ['thread:5002'],
      },
    ],
    personalEvents: [],
    childSummaries: {},
    hidden: [],
  });
  const box = sandboxWithClaude('ok', answer);
  const claudeLog = join(box.dir, 'claude.log');
  box.env.FAKE_CLAUDE_LOG = claudeLog;
  const modelCalls = () => readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).length;

  const first = json(box.run('new', '--no-deploy', '--no-open'));
  assert.equal(first.layout, 'model');
  assert.equal(first.layoutCached, false, 'the first run has nothing to reuse');
  assert.equal(modelCalls(), 1);

  const second = json(box.run('new', '--no-deploy', '--no-open'));
  assert.equal(second.layout, 'model');
  assert.equal(second.layoutCached, true);
  assert.equal(modelCalls(), 1, 'a cache hit must not spawn the model at all');

  // The escape hatch, and the reason the flag is worth having: without a way to
  // force the call, a wrong cached answer is unfalsifiable.
  const fresh = json(box.run('new', '--no-deploy', '--no-open', '--no-cache'));
  assert.equal(fresh.layoutCached, false);
  assert.equal(modelCalls(), 2, '--no-cache must reach the model again');

  // `cache clear` used to empty ~/.aula/cache only, leaving the layout on disk
  // to come straight back — the one thing someone clearing the cache wants
  // gone.
  assert.equal(json(box.run('cache', 'clear')).layouts.cleared, true);
  const afterClear = json(box.run('new', '--no-deploy', '--no-open'));
  assert.equal(afterClear.layoutCached, false, 'a cleared layout must not be served');
  assert.equal(modelCalls(), 3);
});

test('a partial model response is supplemented by rule-grounded obligations', () => {
  const answer = JSON.stringify({
    topline: 'Ufuldstændigt svar.',
    cards: [
      {
        title: 'Opdigtet dato',
        summary: 'Dette står ikke i kilden den 24. september 2026.',
        children: ['Alma'],
        date: '2026-09-24',
        needsAction: true,
        reason: 'Test.',
        sourceKeys: ['thread:5001'],
      },
    ],
    personalEvents: [],
    childSummaries: {},
    hidden: [],
  });
  const box = sandboxWithClaude('ok', answer);
  const result = box.run('new', '--no-deploy', '--no-open', '--explain');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false);
  assert.match(result.stderr, /rule-made/);
  const page = readFileSync(join(box.dir, 'brief', 'latest.html'), 'utf8');
  assert.match(page, /Husk regntøj/);
  assert.match(page, /reglerne som reserve/);
});

test('preferences reset puts the shipped list back and names the casualties', () => {
  const box = sandbox();
  box.run('remember', 'beskeder fra John (Hjaltes far) er altid vigtige');
  box.run('forget', '5'); // drop a shipped opinion too

  const reset = box.run('preferences', 'reset');
  assert.equal(reset.code, 0, reset.stderr);
  assert.match(reset.stdout, /Reset preferences to the defaults/);
  assert.match(reset.stdout, /Dropped 1 of your own/);
  assert.match(reset.stdout, /beskeder fra John \(Hjaltes far\)/);

  const listed = box.run('preferences').stdout;
  assert.match(
    listed,
    /5\. Fællesbeskeder til alle forældre i kommunen/,
    'the dropped default is back',
  );
  assert.ok(!/John/.test(listed), "the user's own line is gone");

  const bad = box.run('preferences', 'nulstil');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /preferences reset/);
});

/**
 * What the user actually reads when their login has died.
 *
 * This is the end-to-end version of the failure that produced "Aula API error:
 * Malformed object payload from profiles.getProfilesByLogin." — a message that
 * named the wrong layer, offered nothing to do, and sent at least one person
 * reading the client's validation code instead of logging in again.
 */
test('a login Aula will not accept is reported in plain language, with the fix', () => {
  const box = sandbox({ FAKE_AULA_REJECT_TOKEN: '1' });
  const result = box.run('whoami');

  assert.equal(result.code, 5, 'setup required — never a retry');

  const flat = result.stderr.replace(/\s+/g, ' ');
  assert.match(flat, /Aula rejected your login/i);
  // The spelling follows how the CLI was invoked — a binary user has no `bun`,
  // so a hardcoded `bun run login` here would be an instruction they cannot run.
  assert.match(flat, new RegExp(cmd('login').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(flat, /Malformed|payload|envelope/i, 'no shape complaints');
  assert.doesNotMatch(flat, /Aula API error/, 'the prefix that labelled without saying anything');

  // The first line has to carry the point on its own: `doctor` reports only
  // that line, and the CLI is the only place the rest is even shown.
  assert.match(result.stderr.split('\n')[0] ?? '', /Aula rejected your login\.$/);
});

test('Aula being down does not send the user off to redo MitID', () => {
  const box = sandbox({ FAKE_AULA_DOWN: '1' });
  const result = box.run('whoami');

  assert.equal(result.code, 1, 'a source is down: retry later, not a credentials problem');
  const flat = result.stderr.replace(/\s+/g, ' ');
  assert.match(flat, /Aula is having trouble/i);
  assert.doesNotMatch(flat, /bun run login/, 'logging in again cannot fix an outage');
});

/**
 * The invariant the whole login page rests on: the page is up, and MitID has
 * not been touched.
 *
 * `login` used to take the username as an argument, which meant an agent asked
 * for it in the chat and the MitID session started on the same command line.
 * Now the page is asked first and MitID second, and the gap between them is
 * unbounded — the user can go and find a username they have not typed in a
 * year. That is only safe while nothing has been started on MitID's side, so
 * this asserts the ordering rather than trusting it: the page answers, and the
 * request log is empty.
 *
 * `--no-open` exists for this test as much as for headless machines. Without
 * it, `openLoginPage` spawns a browser, and running the suite would open a
 * window on whoever is running it.
 */
test('login serves the username page without contacting MitID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aula-cli-login-test-'));
  sandboxes.push(dir);
  const log = join(dir, 'requests.log');
  writeFileSync(log, '');

  // Deliberately not seeded with tokens: this is the state a first-time setup
  // is actually in, and `login` is the one command that must work from it.
  const proc = Bun.spawn({
    cmd: ['bun', '--preload', PRELOAD, ENTRY, 'login', '--no-open'],
    env: { ...process.env, AULA_DIR: dir, FAKE_AULA_LOG: log, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const stderr = await readUntilUrl(proc.stderr);
    const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/)?.[0];
    assert.ok(url, `login printed no page URL:\n${stderr}`);

    // The line that keeps an agent from reverting to the old habit. It is
    // instruction, not decoration, so it is worth a test.
    assert.match(stderr, /do not ask for the username in the chat/i);
    // The failure the old terminal prompt produced when an agent drove it.
    assert.doesNotMatch(stderr, /stdin/i);

    const state = (await (await fetch(`${url}/state`)).json()) as { kind: string };
    assert.equal(state.kind, 'ask-username', 'the page is armed and waiting for the username');

    // The point of the whole ordering: nothing has gone out yet. `fake-aula.ts`
    // replaces `globalThis.fetch` and logs every call, and the vendored HTTP
    // client goes through that same global — so an empty log is proof, not an
    // absence of evidence.
    assert.deepEqual(
      readFileSync(log, 'utf8').split('\n').filter(Boolean),
      [],
      'MitID must not be contacted before the username arrives',
    );
  } finally {
    proc.kill();
  }
});

// The fake has no MitID in it, so a login that gets as far as its first request
// fails there — which is all this needs. A failed login left at a literal 2,
// from the scheme in which 2 meant credentials; on the shared table that says
// "fix the command line" about a command that takes no arguments.
test('a login that fails is exit 5, not a usage error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aula-cli-login-test-'));
  sandboxes.push(dir);
  const log = join(dir, 'requests.log');
  writeFileSync(log, '');

  const proc = Bun.spawn({
    cmd: ['bun', '--preload', PRELOAD, ENTRY, 'login', '--no-open'],
    env: { ...process.env, AULA_DIR: dir, FAKE_AULA_LOG: log, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const stderr = await readUntilUrl(proc.stderr);
    const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/)?.[0];
    assert.ok(url, `login printed no page URL:\n${stderr}`);

    const answered = await fetch(`${url}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'eksempelforaelder' }),
    });
    assert.equal(answered.status, 200);

    const code = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => 'timed out')]);
    assert.equal(code, 5);
  } finally {
    proc.kill();
  }
});

/** Reads stderr until the login page announces its address, or gives up. */
async function readUntilUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let seen = '';
  const collect = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      seen += decoder.decode(value, { stream: true });
      if (/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}/.test(seen)) return;
    }
  })();
  // The URL is printed as soon as the port binds, so this ceiling is only ever
  // reached when the command died on the way there — in which case `seen` holds
  // whatever it managed to say, which is what the assertion above will show.
  await Promise.race([collect, Bun.sleep(20_000)]);
  reader.releaseLock();
  return seen;
}
