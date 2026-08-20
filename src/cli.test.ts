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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

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

function json(result: RunResult): any {
  assert.equal(result.code, 0, `expected success, got ${result.code}:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ------------------------------------------------------------------- --child

// The regression this file was written for. `digest` parsed `--child` and threw
// it away, so a question about one child was answered with the whole family's
// data and no indication that the filter had not been applied.
test('digest --child narrows every read, not just the ones that were wired up', () => {
  const box = sandbox();
  const digest = json(box.run('digest', '--child', 'Alma', '--no-cache'));

  assert.deepEqual(digest.scope, { child: 'Alma', children: ['Alma Eksempelsen'] });
  assert.deepEqual(digest.family.children.map((c: any) => c.name), ['Alma Eksempelsen']);
  assert.deepEqual(digest.threads.map((t: any) => t.subject), ['Lejrskole for 2E']);
  assert.deepEqual(digest.calendar.map((e: any) => e.title), ['Lejrskole']);
  assert.deepEqual(digest.presence.map((p: any) => p.child), ['Alma Eksempelsen']);
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
  assert.deepEqual(digest.calendar.map((e: any) => e.title), ['Lejrskole', 'Bedsteforældredag']);
});

test('digest --child reaches the standalone commands too', () => {
  const box = sandbox();
  const posts = json(box.run('posts', '--child', 'Viggo', '--no-cache'));
  const titles = posts.map((p: any) => p.title);
  assert.ok(titles.includes('Sommerfest i Myretuen'));
  assert.ok(!titles.includes('Ugeplan 2E'));
});

// A flag that is quietly ignored produces a confident wrong answer, which is the
// class of bug this project is least equipped to notice.
test('--child is refused by commands that cannot honour it', () => {
  const result = sandbox().run('thread', '5001', '--child', 'Alma');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot narrow to one child/);
  assert.match(result.stderr, /digest/, 'should name the commands that do');
  assert.equal(result.requests.length, 0, 'must be refused before spending a request');
});

test('an unknown child is refused rather than silently matching nobody', () => {
  const result = sandbox().run('digest', '--child', 'Nobody');
  assert.equal(result.code, 1);
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

  const stats = json(box.run('cache', 'status'));
  assert.ok(stats.entries > 5);
  assert.ok(stats.byNamespace['messaging.getThreads'] >= 1);
  // Widget tokens expire in about a minute and the expiry retry depends on
  // getting a genuinely fresh one, so they are never stored.
  assert.equal(stats.byNamespace['aulaToken.getAulaToken'], undefined);
  // One entry per widget covers the token *and* the vendor round-trip.
  assert.equal(stats.byNamespace['widget-0004'], 1);

  assert.equal(json(box.run('cache', 'clear')).cleared, true);
  assert.equal(json(box.run('cache', 'status')).entries, 0);

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
  const plans = json(box.run('ugeplan'));

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
  assert.match(result.stderr, /aula new/);
});

test('open --web without a configured hosted copy says how to get one', () => {
  const result = sandbox().run('open', '--web');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /SETUP\.md/);
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
  const albums = json(sandbox().run('galleries', '--no-cache'));
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
  const albums = json(sandbox().run('galleries', '--no-cache'));
  const dates = albums.map((a: any) => a.createdAt);
  assert.deepEqual([...dates].sort().reverse(), dates, 'newest first by createdAt');
  assert.equal(albums[0].title, 'Tur til stranden');
});

test('galleries carries the metadata that makes an album worth reading', () => {
  const albums = json(sandbox().run('galleries', '--no-cache'));
  const beach = albums.find((a: any) => a.title === 'Tur til stranden');
  assert.equal(beach.id, 9001);
  assert.equal(beach.author, 'Lone Lærke');
  assert.deepEqual(beach.groups, ['2E']);
  assert.ok(!('thumbnailsUrls' in beach), 'signed image URLs are not metadata');
  // thumbnailsUrls is a cover preview capped at one, so any count derived from
  // it would read "1 photo" on every album. Better absent than confidently wrong.
  assert.ok(!('mediaCount' in beach), 'a count that cannot be derived is not reported');
});

test('galleries honours --child, --since and --limit', () => {
  const box = sandbox();
  const viggo = json(box.run('galleries', '--child', 'Viggo', '--no-cache'));
  assert.deepEqual(viggo.map((a: any) => a.title), ['Sommerfest i Myretuen']);

  // The Myretuen album is 9 days old, so a 7-day window must exclude it —
  // even though it sits above a newer one in the order Aula returns.
  const recent = json(box.run('galleries', '--since', '7d', '--no-cache'));
  assert.deepEqual(recent.map((a: any) => a.title), ['Tur til stranden', 'Fastelavn i 2E']);

  const one = json(box.run('galleries', '--limit', '1', '--no-cache'));
  assert.equal(one.length, 1);
  assert.equal(one[0].title, 'Tur til stranden', '--limit keeps the newest, not the first on the wire');
});

test('galleries --text renders titles, dates and photographers', () => {
  const result = sandbox().run('galleries', '--text', '--no-cache');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[9001\] .* — Tur til stranden/);
  assert.match(result.stdout, /by Lone Lærke → 2E/);
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

// AGENTS.md's central point: the dangerous responses are the successful-looking
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
