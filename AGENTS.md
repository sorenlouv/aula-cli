# Working on aula-cli

Read-only CLI over Aula (aula.dk), run by an agent on behalf of a non-technical
parent. [GOALS.md](GOALS.md) says why and for whom; read it before a design
decision. [API.md](API.md) is the wire reference, including Aula's failure
modes, nearly all of which return a successful-looking response.
[BRIEF.md](BRIEF.md) is the daily brief's design; [SETUP.md](SETUP.md) the
install runbook.

## Hard rules

- **Never write to Aula.** `assertReadOnly` in `client.ts` and `widgets.ts`
  enforces it before a socket opens. Do not extend the allowlist or route around
  `#request` to try something; `presence.updatePresenceTemplate` is absent on
  purpose.
- **Never perform a MitID approval.** That is the user's phone and identity.
- **Real family data never enters tracked files.** Fixtures and docs use the
  fictional Eksempelsen family; anything real goes in the gitignored `data/`.
- **Preferences are the model's to read.** The model interprets the prose in
  `preferences.md` and returns a typed relevance verdict; ranking code acts on
  that verdict. Do not parse preference wording in code.
- **Tests never touch `~/.aula`.** `bun test src/` stays credential-free: this
  repo is public, and a test that refreshed a stranger's token would also break
  any `aula` run beside it. `src/testing/seed-tokens.ts` refuses to run without
  `AULA_DIR` pointed at a scratch directory; do not work around that.

## Code is English; Danish is what the reader sees

Danish belongs only in strings a parent reads: rendered page text, CLI output,
prompt prose, diagnostics that reach the page. Identifiers, type names, keys
(including JSON exchanged with the model), `data-*` attributes, CSS classes,
sentinel values, comments and test names are English.

- **A Danish external contract is mirrored verbatim** and mapped at the
  boundary; `min-uddannelse.ts` is the pattern. MinUddannelse really does send
  `kuvertnavn`, `ugebreve` and `hold: [{ navn }]`, and its schema is public at
  `https://api.minuddannelse.net/csv/metadata?op=OpgavelisteRequest` (no token;
  some other `op=` values 403). Check it before typing a payload; a fixture
  written from our own type can make a wrong field name look correct.
- **Aula's API is English even though its UI is Danish.** The wire says
  `activityType`, `commonFiles`, `institutionProfileId` where the screen says
  "Henteform", "Fælles Filer". Name code after the wire; mention the Danish
  label only where it helps someone find the feature.
- **Our own vocabulary is English.** The tiers are `act`, `week`, `context`,
  `hidden`, never the headings they render as. Where both must exist, keep them
  side by side — `cli-helpers.ts` maps presence codes through `{ da, en }`.
- Danish quoted as a *specimen* of input is not a name: `rules.ts` matches
  literal "på mandag", so the comment showing it stays Danish.

A widget the family does not have cannot be exercised from a normal account:
Aula mints a token for any `widgetId` and the vendor then answers `403 Token is
invalid (Person not found …)`. `scaarup/aula` and `Casperjuel/aula-mcp` are the
fallback sources.

## Non-obvious behaviour

- Reads are cached 600 s in `~/.aula/cache/responses`, so a second `digest`
  inside the window makes no requests; `--no-cache` is the first thing to reach
  for and `cache status` shows what is held. Never cached:
  `aulaToken.getAulaToken`, because the vendor-token retry needs a genuinely
  fresh one, and failed calls, so a transient 403 is not pinned for the TTL.
  `#ensureApiVersion` and `#ensureSession` bypass the cache deliberately.
- `login`, `logout` and `refresh-stepup` drop the cache — threads cached without
  step-up under-report the sensitive ones and look complete.
- An access token can be refused while far from its `exp`: a `refresh_token`
  grant retires the previous one and the loser gets `403` + code `20`. The
  client re-reads the token store, adopts a newer token or buys one, and replays
  once. Keep that order — two runs that both refresh rotate each other's tokens
  forever.
- `family.ts` resolves the id sets endpoints want once
  (`postInstitutionProfileIds`, `childInstitutionProfileIds`,
  `institutionCodes`); re-deriving at a call site is how wrong-id failures start.
- **An agent cannot drive the terminal login.** `readline`'s `question()` on a
  stdin already at EOF never settles, so a captured shell gets silence and a
  killed process. `prompt()` in `io.ts` aborts when the stream closes (not on
  `isTTY`, which would break legitimate piping) and names the flag that avoids
  it. Any prompt added to the login path needs the same.
- **The MitID QR pair cannot be relayed through a chat** — it rotates every few
  seconds and is a picture either way. Off a TTY the approval is served as a
  loopback page (`login-page.ts`) and the terminal renderer is skipped, because
  it appends rather than redraws there and would push a fresh QR block into the
  driving agent's context on every rotation.

## Formatting

Prettier owns the layout — single quotes, 100 columns, pinned in `.prettierrc`.
Both sides run that same config: VSCode format-on-save through the Prettier
extension, and agent edits through the `PostToolUse` hook in
`.claude/settings.json`, which calls `scripts/format-hook.sh`. Do not hand-align
code against the formatter; run `bun run format` (or `format:check`) instead.

Markdown is in `.prettierignore` on purpose. The docs are hand-wrapped and their
tables are hand-aligned, and Prettier pads every cell to the widest row. Leave
them alone.

## Verifying

`bun test src/` stubs `fetch`; `cli.test.ts` and `auth.test.ts` run the CLI as a
process against a stubbed Aula.

The login page can only really be judged by whether a phone reads it. Drive it
by hand rather than holding a live MitID session open; it builds its payloads
with the production `buildQrPayloads`:

```bash
bun scripts/login-page-demo.ts        # the rotating QR pair
bun scripts/login-page-demo.ts otp    # code comparison
```

## Finding an unwrapped endpoint

Read the method names out of Aula's bundle rather than guessing:

```bash
curl -s https://www.aula.dk/portal/ -o portal.html
grep -oE 'src="/static/js/[^"]*"' portal.html | sed 's/src="//;s/"//' | while read -r p; do curl -s "https://www.aula.dk$p" -O; done
grep -ohoE '\?method=[a-zA-Z]+\.[a-zA-Z]+' ./*.js | sed 's/?method=//' | sort -u   # 304 methods
```

The store action shows the request; the component builds the params (grep the
`mapActions` alias, e.g. `ACTION_GET_COMMON_FILES_LIST,append`). `raw <method>
k=v` confirms a guess; a wrong parameter set returns status `40` with no detail.
