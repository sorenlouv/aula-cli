/**
 * The seam between the CLI and the vendored login flow.
 *
 * Deliberately narrow: only what `src/` actually consumes is re-exported.
 * The vendor-internal modules import each other directly, so anything not
 * listed here is package-private by convention — and a symbol nothing imports
 * shows up as such instead of hiding behind a barrel re-export.
 */

export { AulaLoginClient, AulaSilentSsoFailedError } from './aula-login-client.ts';
export { DEFAULT_OAUTH_CONFIG, refreshAccessToken } from './aula-oauth.ts';
export type { IdentityOption } from './aula-saml-flow.ts';
export { AulaCookieJar } from './cookies.ts';
export { AulaAuthFlowError } from './errors.ts';
export { AulaHttpClient } from './http.ts';
export { type Logger, silentLogger, stderrLogger } from './logger.ts';
export { MitidIdentityNotFoundError, MitidParallelSessionError } from './mitid-client.ts';
export {
  EncryptedFileTokenStore,
  type StoredTokenRecord,
  TokenStoreError,
  withFreshTokens,
} from './token-store.ts';
export { JsonlFileTracer } from './wire-tracer.ts';
