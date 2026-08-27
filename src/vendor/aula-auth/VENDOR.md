# Vendored: `@aula-mcp/aula-auth`

The MitID login flow — SRP, PKCE, OAuth and the SAML broker chain — copied from
[Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp).

| | |
| --- | --- |
| Upstream path | `packages/aula-auth/src/` |
| Commit | `0a2ba721f96980db0110faedcc9af3e8589af728` |
| Commit date | 2026-06-09 |
| License | MIT — see [LICENSE](LICENSE), Copyright (c) 2026 Casper Juel |

## Why this is a copy rather than a dependency

The upstream package is `private: true` and source-only (`main: ./src/index.ts`,
no build). It cannot be installed from npm, and a `file:` dependency would put
raw TypeScript under `node_modules`, which some runtimes refuse to transpile.
Copying it keeps this repo self-contained: nothing outside it is needed at
runtime.

## Local changes

Changes are allowed; record each one here so `vendor-diff.sh` output stays
readable as intentional-vs-drift.

- **Deleted `keychain-token-store.ts` and its test**, and dropped the export
  from `index.ts`. Upstream keeps two `TokenStore` implementations and picks
  between them at runtime; this project keeps only `EncryptedFileTokenStore`.
  The keychain one is macOS-only — `isSupported()` is `process.platform ===
  'darwin'` — so carrying it meant `login` simply refused to run on a Linux
  devbox, and it made two encryption stories where one will do. Nothing else in
  the vendored tree referenced it.
- **Pruned everything this CLI does not call** (2026-08-20 release audit).
  Upstream is a library serving an MCP server as well; this is a CLI with one
  login path. Removed, with their tests where they had any: `MemoryTokenStore`
  and the `TokenStore` interface; the donor's `~/.config/aula-mcp` defaults and
  `AULA_MCP_KEY` naming in `token-store.ts` (paths now always come from
  `src/auth.ts`); the `meta` record field; `state.ts` (`generateState` was an
  alias of `randomBase64Url`); `consoleLogger` (stdout is this CLI's data
  channel — `login --debug` uses `stderrLogger`); `InMemoryTracer`,
  `CompositeTracer` and `formatTraceText`; `pkcs7Pad`/`pkcs7Unpad`,
  `bytesToHex`, `bigIntToHex` and `base64url.decode`; `extractText`,
  `extractAllAttr` and `pageTitle`; `HtmlParseError`; the unused `aad`
  parameter on the AES-GCM helpers; SRP's `publicAValue`/`K` accessors,
  `authDecPin` and the class-level `N`/`g`; `MitidClientState`/`getState()`;
  the never-passed `signal`/`pollIntervalMs`/`maxPollMs` login options and the
  abort plumbing under them; `AulaLoginClient.refresh()` and the `oauth`
  override; the `defaultHeaders`/`noDefaultHeaders`/`maxHops` HTTP options;
  the base64 arm of `signFlowValueProof` (only the removed `/complete` path
  used it); and the `CookieJar` back-compat constructor branch.
- **Removed the kodeviser (CODE_TOKEN) and PASSWORD authenticators**
  (2026-08-27). A kodeviser login ends in a MitID password and six digits read
  off a physical code generator, both typed at the terminal — and the terminal
  is no longer a login surface at all: `aula login` now asks everything on the
  loopback page, which has no password field and never will. Keeping the flow
  meant carrying a second SRP path that nothing could reach. Removed:
  `MitidClient.authenticateWithToken` and `authenticateWithPassword`; the
  `codeTokenInit`/`codeTokenProve`/`passwordInit`/`passwordProve` URL builders;
  `pbkdf2Sha256` and its tests (the PASSWORD derivation was its only caller —
  the token store uses AES-GCM); `SrpInitResponse.pbkdf2Salt` and its validator
  arm; and, on the client, `AulaAuthMethod`, `AulaLoginCredentials`, the
  `method`/`password`/`promptForCodeToken` options and the branch they fed, so
  `assertMethodAvailable` becomes `assertAppAvailable`.

  Kept **on purpose**, and the reason a future vendor diff should not "finish
  the job": `MitidAuthenticatorType` still carries `'CODE_TOKEN'` and
  `'PASSWORD'`, `normalizeAuthenticatorType` still maps the server's raw
  `'TOKEN'` onto the first of them, and both still have rows in the combination
  tables. That union is a *wire* type, not a menu — MitID nominates whatever
  authenticator the account defaults to, so on a kodeviser-first account
  `'TOKEN'` arrives on the very first `/next`, before anything has been chosen.
  Narrowing the union to `'APP'` would turn "your MitID has no app" into
  `Unknown MitID authenticator type: TOKEN` thrown from a JSON validator.
  `MitidAuthenticatorUnavailableError` stays too: two of its three throw sites
  are on the APP path.
- **Renamed the base error `AulaAuthError` → `AulaAuthFlowError`.** The main
  codebase has its own `AulaAuthError` in `client.ts` ("credentials expired"),
  and two unrelated classes sharing a name meant vendor errors missed the
  CLI's exit-code-2 branch.
- **`index.ts` re-exports only what `src/` imports.** Vendor-internal modules
  import each other directly.

The remaining code typechecks and passes its tests under this project's
stricter `tsconfig.json`. Expect `vendor-diff.sh` to be noisy against upstream
now — the list above is what makes it readable.

## Checking for upstream drift

```bash
scripts/vendor-diff.sh [path-to-aula-mcp-checkout]
```

It **diffs only** — it never copies over local files. Read the diff, take what
is wanted by hand, and note it above.

## Tests

The 12 `*.test.ts` files came across with the source and run as part of
`bun test src/`. They are the only local coverage of the crypto and protocol
code in here, so keep them running rather than excluding them.
`token-store.test.ts` in particular is what covers the encryption the CLI now
depends on for every login; [`src/auth.test.ts`](../../auth.test.ts) covers the
wiring around it.
