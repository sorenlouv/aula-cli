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
- **Prose is the model's to read.** No regex or keyword heuristics over text a
  parent or teacher wrote; the model returns a typed verdict and code acts on
  it.
- `src/testing/seed-tokens.ts` needs `AULA_DIR` pointed at a scratch directory,
  or it would overwrite the real login, refresh token included. It refuses
  otherwise; do not work around that.

## Code is English. Danish is what the reader sees.

The product is Danish; the codebase is not. Danish belongs in exactly one place —
strings a parent reads — and nowhere else.

**Danish is allowed in:** rendered page text and CLI output, prompt prose, and
the `problems`/`notes` diagnostics that reach the page.

**Danish is banned from:** identifiers, type names, object keys, JSON keys
exchanged with the model, `data-*` attributes, CSS class names, enum/sentinel
values, and the explanatory prose of comments, doc-comments and test names.

### Whose word is it?

Three rules, and they decide every case:

1. **The external contract is Danish → we are Danish.** MinUddannelse really
   does send `kuvertnavn` and `ugebreve`. Mirror those verbatim in the response
   type and map to English at the boundary — `min-uddannelse.ts` is the pattern.
   The giveaway that a payload is genuinely theirs is a language mix nobody
   would design: `MuTask` has `kuvertnavn` next to `title`, and `hold` whose
   nested field is `name`.
2. **The external contract is English → we stay English.** Never translate a
   wire term into the Danish word for it.
3. **The vocabulary is ours → always English.** Identifiers, type names, object
   keys, JSON keys exchanged with the model, `data-*` attributes, CSS classes,
   enum and sentinel values, and the prose of comments, doc-comments and test
   names.

**Rule 2 is the one that gets broken, because Aula's API is entirely English
while Aula's UI is entirely Danish.** The wire says `activityType`, `pickup`,
`selfDecider`, `commonFiles`, `institutionProfileId`; the screen the parent
looks at says "Henteform", "Komme/gå", "Fælles Filer". Naming code after the
screen is how a field ends up called `henteform` when the thing it is built
from is `activityType`. Aula being a Danish product is not evidence that any
particular term of theirs is Danish — go and look at the response.

So: name the concept by the English wire term, and cross-reference the Danish
UI label where it helps someone find the feature — `"Fælles Filer" in Aula's own
UI`, not `Flattens a Fælles Filer entry`.

**Guessing the language of a field is how you lose data silently.** `MuTask.hold`
was typed as `{ name }` when MinUddannelse sends `{ navn }`, so `subject` never
populated — and the test passed, because the fixture had been written to match
our code instead of the wire. A self-authored fixture proves only that the code
agrees with itself. Two things would have caught it: the fixture contradicted
itself (`hold: [{ name }]` beside `forloeb: { navn }`), and MinUddannelse
publishes its schema:

```
https://api.minuddannelse.net/csv/metadata?op=OpgavelisteRequest
```

That endpoint is public and needs no token — it lists `HoldDto` as `Id`, `Navn`,
`FagId`, `FagNavn`. Check it before typing a MinUddannelse payload. (Only some
`op=` values are public; `UgebrevRequest` answers 403.)

Note also that a widget the family does not have is not testable from a normal
account: Aula will happily mint a token for any `widgetId`, but the vendor then
answers `403 Token is invalid (Person not found: …)`. `scaarup/aula` and
`Casperjuel/aula-mcp` are the fallback sources when you cannot make the call.

One further exception, on top of the three rules: **Danish specimens quoted in
comments.** `rules.ts` matches literal Danish, so a comment showing `"på mandag"`
or `"ansøgningsfristen"` is a specimen of the input, not a name. Translating
those would make the comment describe code that does not exist.

The mistake that catches most of the rest: never name one of our own concepts by
the Danish label it renders as. The tiers are `act`, `week`, `context`, `hidden`
— a comment saying "at most five items in *Kræver handling*" names the heading
where it means the `act` tier. Pair the two only where the point is the
rendering itself, as `BRIEF.md`'s page-section list does.

Where a Danish label and an English code value both have to exist, keep them
side by side rather than picking one: `cli-helpers.ts` maps Aula's presence
constants through `{ da: 'På tur', en: 'on a field trip' }`, keyed by the wire
number.

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
- **An agent cannot drive the terminal login.** `readline`'s `question()` on a
  stdin already at EOF never settles — it does not throw and does not return
  empty, it waits — so a captured shell gets a silence and a killed process.
  `prompt()` in `io.ts` aborts on the stream closing (not on `isTTY`, which
  would break legitimate piping) and throws naming the flag that avoids it. Any
  prompt added to the login path needs the same, and a `hint` saying how to get
  past it without a terminal.
- **The MitID QR mode cannot be relayed through a chat**: the pair refreshes
  every few seconds, so a pasted code is stale, and it is a picture either way.
  When stderr is not a TTY the approval is served as a page on loopback instead
  (`login-page.ts`) and the user opens it; the terminal renderer is skipped
  then, because it appends rather than redraws off a TTY and would push a fresh
  block of QR into the driving agent's context on every rotation.
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

The login approval page is the one thing tests cannot really show you, because
what matters is whether a phone can read it. Drive it by hand instead of
holding a real MitID session open — it builds its payloads with the production
`buildQrPayloads`, so a scanner sees the shape MitID actually sends:

```bash
bun scripts/login-page-demo.ts        # the rotating QR pair
bun scripts/login-page-demo.ts otp    # the code-comparison mode
```

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
