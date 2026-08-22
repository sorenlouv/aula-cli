# Working on aula-cli

Read-only CLI over Aula (aula.dk), driven by an agent on behalf of a
non-technical parent. [GOALS.md](GOALS.md) says why and for whom — read it
before a design decision. [API.md](API.md) is the wire reference and lists
Aula's failure modes, nearly all of which return a successful-looking response.
[BRIEF.md](BRIEF.md) is the daily brief's design; [SETUP.md](SETUP.md) the
install runbook.

## Hard rules

- **Never write to Aula.** `assertReadOnly` in `client.ts` and `widgets.ts`
  enforces it before a socket opens. Do not extend the allowlist or route a
  call around `#request` to try something. `presence.updatePresenceTemplate`
  is absent on purpose.
- **Never perform a MitID approval.** That is the user's phone and identity.
- **Real family data never enters tracked files.** Fixtures and docs use the
  fictional Eksempelsen family; anything real goes in the gitignored `data/`.
- **Code is English; Danish is for the UI only** — never in an identifier, key
  or sentinel.
- **Prose is the model's to read.** No regex or keyword heuristics over text a
  parent or teacher wrote; the model returns a typed verdict and code acts on
  it.
- `src/testing/seed-tokens.ts` needs `AULA_DIR` pointed at a scratch directory,
  or it would overwrite the real login, refresh token included. It refuses
  otherwise; do not work around that.

## Non-obvious behaviour

- Reads are cached for 600 s in `~/.aula/cache/responses`, so a second `digest`
  inside the window makes no requests. Reach for `--no-cache` first; `cache
  status` shows what is held. `aulaToken.getAulaToken` and failed calls are
  never cached — the first because the vendor-token expiry retry needs a fresh
  one, the second so a transient 403 is not pinned. `#ensureApiVersion` and
  `#ensureSession` bypass the cache deliberately; don't "simplify" them onto
  `#request`.
- `login`, `logout` and `refresh-stepup` drop the cache. Threads cached by a
  session without step-up under-report the sensitive ones and look complete.
- An access token can be refused while still far from its `exp`: a
  `refresh_token` grant rotates the previous one out, and the loser gets `403` +
  code `20`. The client recovers on its own — it re-reads the token store,
  adopts a newer token or buys one, and replays the request once. Keep that
  order if you touch it: two runs that both refresh will rotate each other's
  tokens forever.
- `family.ts` resolves the id sets the endpoints want once
  (`postInstitutionProfileIds`, `childInstitutionProfileIds`,
  `institutionCodes`). Use them; re-deriving at a call site is how wrong-id
  403s happen.

## Verifying

`bun test src/` stubs `fetch`; `cli.test.ts` and `auth.test.ts` run the CLI as a
process against a stubbed Aula. No stub can tell you the live API still
behaves, because its failures look like success — `bun src/cli.ts doctor --text`
is that check: it calls every endpoint uncached and marks a call that succeeded
with a known symptom as `WARN`.

## Finding an unwrapped endpoint

Don't guess method names; read them out of Aula's bundle:

```bash
curl -s https://www.aula.dk/portal/ -o portal.html   # no cookie needed
grep -oE 'src="/static/js/[^"]*"' portal.html | sed 's/src="//;s/"//' | while read -r p; do curl -s "https://www.aula.dk$p" -O; done
grep -ohoE '\?method=[a-zA-Z]+\.[a-zA-Z]+' ./*.js | sed 's/?method=//' | sort -u   # 304 methods
```

The store action shows the request; the *component* builds the params object
(grep the `mapActions` alias, e.g. `ACTION_GET_COMMON_FILES_LIST,append`).
`raw <method> k=v` confirms a guess; any wrong parameter set returns status
`40` with no detail.
