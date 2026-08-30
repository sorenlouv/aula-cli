# Working on aula-cli

Read-only CLI over Aula (aula.dk), run by an agent on behalf of a non-technical
parent. [GOALS.md](GOALS.md) says why and for whom; read it before a design
decision. [API.md](API.md) is the wire reference, including Aula's failure
modes, nearly all of which return a successful-looking response.
[BRIEF.md](BRIEF.md) is the daily brief's design; [SETUP.md](SETUP.md) the
install runbook.

## Working agreements

How I want work done. The hard rules below are this project's own and win where
they conflict.

**Every feature is implemented in a worktree.** Create it before the first edit
(the `EnterWorktree` tool, `git worktree add ../aula-cli-<feature> -b
<feature>`, or an `isolation: "worktree"` subagent); this checkout is for
reading and merging only. I run several agents at once and they would otherwise
overwrite each other. Removing the worktree and branch is part of the merge, not
a follow-up — if one is dirty, show me the diff instead of force-removing it. On
my machine a `PreToolUse` hook blocks edits made in this checkout; if you hit
it, you skipped this step.

**Commit at every completed step of the plan**, once `bun test src/` and
`bun run typecheck` pass, and **merge back into `main` as soon as the whole
change is green.** Both are standing authorization, no need to ask — a
finished change parked on a branch goes stale, and the other agents working
alongside you cannot see it until it lands, so do not leave one sitting in a
worktree waiting for me. Pushing and PRs still wait for me.

**Keep technical debt low; do not preserve backwards compatibility.** I am the
only user, so breaking changes are encouraged wherever they simplify — with the
public-repo hard rules below the one thing that never bends.

## Exit codes

The fleet's shared table, as of the change that adopted it. This repo used to
have its own colliding scheme (1 usage *and* bug, 2 credentials, 3 API error),
which meant an agent driving several of these tools could not branch on a code
without first knowing which tool produced it — and the fleet doc spent five
lines saying so.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | Aula is down or blocking, or a bug in this client |
| 2 | usage error |
| 4 | resolved, but nothing to report |
| 5 | credentials or setup — run `aula login` |

They are the public contract, shared with `cvr`, `bolig`, `tinglysning` and
`dgs` and recorded in `../contract.json`; change them only in lockstep with
that file and `../AGENTS.md`.

**`--json` is accepted everywhere and ignored.** JSON is already the default
here; the flag exists so an agent driving the whole fleet does not have to
remember which tool wants it and which rejects it. It used to be a hard error
with empty stdout.

**Every argv mistake is a `UsageError`.** `parseArgs` runs with `strict: true`
and throws a plain Node `TypeError`, which escaped into the "this is a bug in
the client" branch and printed a raw stack — a mistyped flag was byte-identical
to a crash. `parseCommandLine` wraps it.

## Hard rules

- **Never write to Aula.** `assertReadOnly` in `client.ts` and `widgets.ts`
  enforces it before a socket opens. Do not extend the allowlist or route around
  `#request` to try something; `presence.updatePresenceTemplate` is absent on
  purpose.
- **Never perform a MitID approval.** That is the user's phone and identity.
- **Real family data never enters tracked files.** Before writing a fixture, a
  test, an example, a doc or a commit message, **read `data/private-terms.txt`**
  — a gitignored, hand-maintained list of the real names of this family, the
  people around them, their institutions and their identifiers. Nothing on that
  list may appear anywhere in tracked content. This repository is public.
  Being inspired by a live Aula response is fine; pasting one is not — change
  the names, the class, the institution and any signup code before it lands.
  Invent a name rather than borrowing one, and check the invention against the
  list first: the fictional cast once reused names that turned out to belong to
  real people in the class. Fixtures and docs use the fictional Eksempelsen
  family with `eksempel.dk` values; anything real goes in the gitignored
  `data/`. Add to the list the moment a new real name appears, and never move a
  term out of it into a tracked file.
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
- **Our own vocabulary is English.** A card's placement is `upcoming`,
  `undated`, `past`; what the page shows is *Kommende*, *Uden fast dato*,
  *Tidligere* — never the headings in code. Where both must exist, keep them
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
- **The page starts before any MitID contact.** `aula login` takes no
  arguments: it binds the loopback page (`login-page.ts`), prints the URL, and
  only once a username has been typed there does the first MitID request go
  out. That ordering is the invariant to protect. Collect the username first
  and the session ages through every minute the user spends finding the link
  and typing, and an aged, abandoned session is exactly what the CAP008
  parallel-session detector looks for. It also makes the page load-bearing: a
  loopback port that will not bind ends `login` rather than falling back, and
  `io.ts` no longer reads stdin at all — there is no terminal prompt left to
  fall back to, and adding one back would reopen both problems.
- **The MitID QR pair cannot be relayed through a chat** — it rotates every few
  seconds and is a picture either way. So the page draws it, and since the user
  is already sitting in front of the page, the page takes the answers too:
  `askUsername` and `askIdentity` arm one question at a time and resolve when
  the browser POSTs to it. `login.ts` caps both waits, with deliberately
  different ceilings — before the username there is no MitID session to lose,
  so waiting is nearly free; after it, one is expiring on their side.

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
bun scripts/login-page-demo.ts           # the rotating QR pair
bun scripts/login-page-demo.ts otp       # code comparison
bun scripts/login-page-demo.ts username  # the username form
bun scripts/login-page-demo.ts identity  # the identity picker
```

The two ask modes call the real `askUsername` / `askIdentity` and reject the
first answer on purpose: the inline error is the part easiest to get subtly
wrong and impossible to see from a test.

What *is* tested is the ordering the whole design rests on: `cli.test.ts` spawns
`aula login --no-open`, reads the page's address off stderr and asserts the page
answers while the request log is still empty — the page is up, MitID has not
been touched. That flag exists for this; without it `login` spawns a browser and
the suite opens a window on whoever runs it. The assertion only means something
because `fake-aula.ts` records requests to hosts it does not know: before it
did, an unwired host fell through to the Aula switch and answered `null`
silently, and "the log is empty" was a fact about the log rather than about the
process.

## Releasing

End users install a compiled binary, not this checkout — they have neither git
nor bun, and on a fresh Mac `git` is the Command Line Tools stub that opens a
GUI installer. `bun run build` compiles `dist/aula-<platform>-<arch>` for macOS,
Linux and Windows plus `SHA256SUMS`; `bun run build --target aula-linux-x64`
does one. Pushing a `v*` tag runs the same thing in CI and attaches the results
to the release, so **the asset names in SETUP.md's curl are load-bearing** —
renaming one breaks the documented install.

`src/runtime.ts` is the only place that knows which mode the process is in.
Anything that writes a command into a file somebody else runs later — the
launchd plist, a Scheduled Task, cron lines, the installed skill — must take
its argv from `programs()` or its spelling from `commandPrefix()`, never
assume `bun src/cli.ts`. Both take the runtime as an optional parameter so the
compiled branch is testable from a checkout; use that rather than adding a
mode-specific test path.

New files the binary must carry — templates, fixtures, anything read at
runtime — have to be imported (`with { type: 'text' }`), not read from disk.
`import.meta.dir` is a virtual path in a compiled binary, so `readFileSync`
against it compiles happily and fails only for the user.

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
