/**
 * Credential storage, as the CLI actually uses it.
 *
 * `EncryptedFileTokenStore` itself is covered by the vendored
 * `token-store.test.ts` — encryption, key resolution, wrong-key handling. What
 * is tested here is the wiring this project put around it after dropping the
 * macOS keychain: where the file lands, what it is chmodded to, which env var
 * supplies the key, and that a key problem is reported as a key problem rather
 * than as "not logged in".
 *
 * Subprocesses, because `AULA_DIR` is read when the module is first imported,
 * and a test that has to defeat module caching to set it is testing the test.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;
const ENTRY = join(ROOT, 'src/cli.ts');
const ACCESS_TOKEN = 'access-token-that-must-not-be-readable';

const sandboxes: string[] = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aula-auth-test-'));
  sandboxes.push(dir);
  const env: Record<string, string> = {
    AULA_DIR: dir,
    NO_COLOR: '1',
    ...overrides,
  };

  return {
    dir,
    env,
    tokenPath: join(dir, 'tokens.json'),
    /** Stores a login without going through MitID — see src/testing/seed-tokens.ts. */
    storeTokens() {
      const r = Bun.spawnSync({
        cmd: ['bun', join(ROOT, 'src/testing/seed-tokens.ts')],
        env: { ...process.env, ...env, SEED_ACCESS_TOKEN: ACCESS_TOKEN },
      });
      assert.equal(r.exitCode, 0, `writing tokens failed: ${r.stderr.toString()}`);
    },
    run(...args: string[]) {
      const r = Bun.spawnSync({ cmd: ['bun', ENTRY, ...args], env: { ...process.env, ...env } });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
  };
}

test('a login is stored encrypted under ~/.aula, on any platform', () => {
  const box = sandbox();
  box.storeTokens();

  assert.ok(existsSync(box.tokenPath), 'tokens.json should exist');
  const raw = readFileSync(box.tokenPath, 'utf8');
  assert.ok(!raw.includes(ACCESS_TOKEN), 'the token must not be readable in the file');
  assert.equal(JSON.parse(raw).alg, 'aes-256-gcm');

  // The key file sits beside the ciphertext, so the directory mode is doing
  // real work here rather than being belt-and-braces.
  assert.equal(statSync(box.tokenPath).mode & 0o777, 0o600);
  assert.equal(statSync(box.dir).mode & 0o777, 0o700);
});

test('status reads the stored login back, with no mention of a keychain', () => {
  const box = sandbox();
  box.storeTokens();

  const status = JSON.parse(box.run('status').stdout);
  assert.equal(status.loggedIn, true);
  assert.equal(status.username, 'mikkelex');
  assert.equal(status.tokenStore, box.tokenPath);
  assert.ok(status.accessTokenExpiresInSeconds > 0);
  assert.ok(!('keychainAvailable' in status), 'the macOS-only gate is gone');

  const text = box.run('status', '--text');
  assert.doesNotMatch(text.stderr, /keychain/i);
});

test('status on a machine with no login says so rather than erroring', () => {
  const status = JSON.parse(sandbox().run('status').stdout);
  assert.equal(status.loggedIn, false);
  assert.equal(status.username, null);
});

test('$AULA_TOKEN_KEY keeps the key out of the filesystem', () => {
  const key = 'a'.repeat(64);
  const box = sandbox({ AULA_TOKEN_KEY: key });
  box.storeTokens();

  assert.ok(!existsSync(join(box.dir, '.token-key')), 'no key file when the env supplies one');
  assert.equal(JSON.parse(box.run('status').stdout).tokenKeyFromEnv, true);

  // Without the key the file is just bytes — which is the point of setting it.
  delete box.env.AULA_TOKEN_KEY;
  const blind = box.run('status');
  assert.equal(blind.code, 2);
  assert.match(blind.stderr, /AULA_TOKEN_KEY/);
});

// Reporting a key problem as "not logged in" sends you off to redo MitID, and
// the fresh login then fails to write for exactly the same reason.
test('an unreadable token file is reported as a key problem, not a missing login', () => {
  const box = sandbox();
  box.storeTokens();
  writeFileSync(box.tokenPath, '{ not json');

  const result = box.run('status');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /could not be read/);
  assert.doesNotMatch(result.stderr, /Not logged in/);
});

test('logout removes the stored login and the cached responses', () => {
  const box = sandbox();
  box.storeTokens();
  mkdirSync(join(box.dir, 'cache'), { recursive: true });
  writeFileSync(join(box.dir, 'cache', 'responses'), '{}');

  assert.equal(box.run('logout').code, 0);
  assert.ok(!existsSync(box.tokenPath), 'tokens.json should be gone');
  assert.ok(!existsSync(join(box.dir, 'cache')), 'the cache holds message bodies — it goes too');
  assert.equal(JSON.parse(box.run('status').stdout).loggedIn, false);
});

/**
 * The guard on the fixture seeder.
 *
 * `seed-tokens.ts` writes a *fixture* login through the real store. Run once
 * without `$AULA_DIR` it overwrites `~/.aula/tokens.json` — including the
 * refresh token, so nothing can recover it and the only way back is MitID with
 * the phone. That is a bad enough half-hour on its own; what made it worse is
 * that the resulting failure does not look like a credentials problem, because
 * Aula reports a token it will not accept as an HTTP 500.
 *
 * `HOME` is redirected so this test is safe to run: if the guard ever stops
 * working, the file it destroys is in a temp directory rather than the one
 * belonging to whoever ran `bun test`.
 */
function seedWithFakeHome(overrides: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aula-fake-home-'));
  sandboxes.push(home);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    NO_COLOR: '1',
    ...overrides,
  };
  if (!('AULA_DIR' in overrides)) delete env.AULA_DIR;

  const r = Bun.spawnSync({ cmd: ['bun', join(ROOT, 'src/testing/seed-tokens.ts')], env });
  return { home, code: r.exitCode, stderr: r.stderr.toString() };
}

test('the token seeder refuses to write fixture credentials into the real ~/.aula', () => {
  const seeded = seedWithFakeHome();

  assert.equal(seeded.code, 1, 'it must refuse rather than write');
  assert.ok(
    !existsSync(join(seeded.home, '.aula', 'tokens.json')),
    'no token file may be created at all',
  );
  assert.match(seeded.stderr, /Refusing to seed fixture credentials/);
  assert.match(seeded.stderr, /AULA_DIR=\$\(mktemp -d\)/, 'and it should show how to run it right');
});

test('the token seeder refuses even when $AULA_DIR is pointed at the real store', () => {
  const home = mkdtempSync(join(tmpdir(), 'aula-fake-home-'));
  sandboxes.push(home);
  const real = join(home, '.aula');

  const r = Bun.spawnSync({
    cmd: ['bun', join(ROOT, 'src/testing/seed-tokens.ts')],
    env: { ...process.env, HOME: home, AULA_DIR: real, NO_COLOR: '1' },
  });

  assert.equal(r.exitCode, 1, 'naming the real directory explicitly is not consent');
  assert.ok(!existsSync(join(real, 'tokens.json')));
});

test('the token seeder still works where the tests point it', () => {
  const box = sandbox();
  box.storeTokens();
  assert.ok(existsSync(box.tokenPath), 'a sandboxed $AULA_DIR is exactly what it is for');
});
