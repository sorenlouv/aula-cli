/**
 * Writes a fixture MitID login into `$AULA_DIR`, through the same encrypted
 * store the CLI reads. Spawned by the process-level tests: auth is MitID-only,
 * so "logged in" is a state on disk, and this is the only way into it that
 * does not need a phone.
 */

import { tokenStore } from '../auth.ts';

await tokenStore().save({
  version: 1,
  // Overridable so a test can model a *different* login in the same store,
  // or assert on a known token value without reading the encrypted file.
  username: process.env.SEED_USERNAME ?? 'mikkelex',
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
