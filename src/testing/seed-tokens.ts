/**
 * Writes a fixture MitID login into `$AULA_DIR`, through the same encrypted
 * store the CLI reads. Spawned by the process-level tests: auth is MitID-only,
 * so "logged in" is a state on disk, and this is the only way into it that
 * does not need a phone.
 *
 * It refuses to run against the real `~/.aula`. Getting that wrong is not a
 * failed test — it is a destroyed login: the fixture overwrites the *refresh*
 * token as well, so nothing can recover it and the only way back is a full
 * MitID round-trip with the phone. That happened, and the symptom was
 * miserable to trace, because Aula reports a token it will not accept as an
 * HTTP 500 carrying a "success" envelope rather than as an auth failure.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tokenStore } from '../auth.ts';

assertSandboxed();

await tokenStore().save({
  version: 1,
  // Overridable so a test can model a *different* login in the same store,
  // or assert on a known token value without reading the encrypted file.
  username: process.env.SEED_USERNAME ?? 'valdemarex',
  tokens: {
    access_token: process.env.SEED_ACCESS_TOKEN ?? 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    obtained_at: Math.floor(Date.now() / 1000),
    // Hours out, so `withFreshTokens` never attempts a real refresh mid-test.
    expires_at: Math.floor(Date.now() / 1000) + 7200,
  },
  saved_at: Math.floor(Date.now() / 1000),
});

/**
 * `$AULA_DIR` must be set, and must not be the directory the CLI uses when it
 * is unset. Checked here rather than in `auth.ts` because the store itself is
 * right to write wherever it is pointed — it is *this* script, the one holding
 * fixture credentials, that has no business near a real one.
 */
function assertSandboxed(): void {
  const target = process.env.AULA_DIR;
  const real = join(homedir(), '.aula');
  if (target && resolve(target) !== resolve(real)) return;

  const why = target
    ? `$AULA_DIR points at ${target}, which is the real token store.`
    : `$AULA_DIR is not set, so this would overwrite the real login in ${real}.`;

  console.error(
    [
      `Refusing to seed fixture credentials: ${why}`,
      '',
      'This script writes a fixture login for the tests, which point $AULA_DIR at a',
      'temporary directory first. Writing it to the real store overwrites the refresh',
      'token too, so the only way back is a full MitID login.',
      '',
      '  AULA_DIR=$(mktemp -d) bun src/testing/seed-tokens.ts',
    ].join('\n'),
  );
  process.exit(1);
}
