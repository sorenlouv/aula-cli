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
| 5 | no usable session, or setup — never fixed by retrying |

They are the public contract, shared with `cvr`, `bolig`, `tinglysning` and
`dgs` and recorded in `../contract.json`; change them only in lockstep with
that file and `../AGENTS.md`.

**Every exit without a body ends stderr with the error line** —
`{"error":{"code","message","hint"}}`, one line of compact JSON, after whatever
prose came before it. The code is on the error class (`CliError.errorCode`), not
worked out from the message when it is printed, and the exit follows from the
code (`EXIT_FOR`), never the other way round. It used to be worked out from
nothing: the catch chain picked an exit by `instanceof`, everything else an
agent could branch on was prose, and a laptop with no network got a raw stack
through the "bug in this client" branch — `fetch` rejecting is now `NETWORK`.
Codes are `USAGE`, `SETUP`, `NETWORK`, `UPSTREAM` and `BUG`; no `BLOCKED`,
because Aula has no bot wall this client has met. A site that prints its own
prose and returns a code calls `failWith`; `ensureErrorLine` is the net under a
forgotten one. `doctor` is the one exit 1 that also has a body. On stdout, JSON
is one line unless a terminal is reading it (`toJson`).

**Exit 5 never tells the reader to log in.** It said "Run a MitID login: `aula
login`", and the reader is usually an agent, which took that as the next command
— a login costs the user an approval on their phone, and an abandoned one trips
MitID's parallel-session detector for the attempt after it. `sessionGuidance`
and `sessionHint` in `auth.ts` are the one wording: what still answers without
a session (`SESSION_FREE_COMMANDS`, each run without a login by `cli.test.ts`),
and that the user is asked before `aula login`. `AulaAuthError` appends it to
every credential failure, so a throw site cannot forget it. The skill and
`SETUP.md` say the same thing in the same words.

**`aula --contract` prints this tool's slice of that file**, as every sibling
does — it was `Unknown command "--contract"`, exit 2, while the fleet's own
instructions said each tool answers it. `src/contract.ts` *imports* the vendored
`contract.json` rather than reading it, because the compiled binary has no
checkout beside it (see Releasing). No `join_keys` in the output: this tool sits
outside the join graph on purpose.

**Exit 4 is returned, not just declared.** It sat in `EXIT`, the skill and the
contract while nothing emitted it — `Object.values(EXIT)` was all that kept the
contract test green — so an empty inbox left at exit 0. `emit` takes a
`nothing` flag and `emitList` derives it; the body is still printed, because
`body_on` is `[0, 4]`. Pass it only on positive evidence of emptiness: not for
one page of a thread, not for a vendor plan whose `status` is `failed`, and
never for `digest`. A capability no school offers (`NoProviderError`) is 4 with
`[]`; it used to be a stack trace at exit 1.

**A vendor plan states its `status`, and a read that failed outright is exit
1.** A failed fetch and a quiet week are the same `items: []` on the wire; the
difference lived in whether `warnings` happened to be non-empty, which the
skill told the agent to check in prose, and which the one warning that is not a
failure ("the vendor was not asked") got wrong. `graded` in
`integrations/index.ts` stamps `ok` / `partial` / `failed` / `skipped`; the plan
commands (`emitPlans`) print a body at exit 0 or 4 when anything is readable or
nothing failed, and exit 1 with no body when nothing readable came back and a
vendor failed — the vendor's reason goes to stderr. `digest` never exits for
one part; its `weeklyPlans[].status` is what cannot be misread.

**Who typed the method name decides the code.** `AulaMethodError` — the
read-only guard refusing a name, or Aula answering 404 for one — is exit 1 from
a typed wrapper, where it is a bug in this client, and exit 2 from `raw`, where
the caller chose it. Both were 1, so an agent that asked `raw` to send a message
was told a source was down and to retry. A failed `login` and a lapsed
`refresh-stepup` are 5; they were a literal 2 left over from the old scheme.

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
  term out of it into a tracked file. `bun run scan:private` checks every
  tracked file against the list (from a worktree too) and prints file and line
  only; run it before committing anything that touched a fixture, a test, a doc
  or an example.
- **Preferences are the model's to read.** The model interprets the prose in
  `preferences.md` and returns a typed relevance verdict; ranking code acts on
  that verdict. Do not parse preference wording in code.
- **Tests never touch `~/.aula`.** `bun test src/` stays credential-free: this
  repo is public, and a test that refreshed a stranger's token would also break
  any `aula` run beside it. `src/testing/seed-tokens.ts` refuses to run without
  `AULA_DIR` pointed at a scratch directory; do not work around that.

## Code is English; Danish is what the reader sees

Everything a parent reads is Danish, and Danish belongs nowhere else: rendered
page text, CLI output, prompt prose, diagnostics that reach the page, and the
questions an agent puts to them on our behalf. Identifiers, type names, keys
(including JSON exchanged with the model), `data-*` attributes, CSS classes,
sentinel values, comments and test names are English.

- **What an agent says to the parent is parent-facing copy; the document it
  reads to know what to say is not.** `SETUP.md` is English, for the agent
  following it. Its feature question first said to ask "in the language the
  user has been speaking" — so an agent that had just read several pages of
  English asked a Danish parent in English, and handed them a checkbox list to
  answer in a language nobody in the family had used. Every line the parent's
  own eyes land on is therefore written out in Danish in the document itself.
  Leave none of it to be translated at runtime; that is the step that gets
  skipped.
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

- **Every `claude` subprocess is started in `~/.aula/cwd`, an empty directory
  of our own.** `claude` treats its working directory as a project, and an
  inherited one is a decision nobody made: under launchd it was `/`, so every
  scheduled model call opened a session rooted at the boot volume, and macOS
  asked the family to approve *aula* for their Photos library, Music library,
  Desktop and Documents. Run by hand it was whatever checkout the user's shell
  was in. `spawnClaude` sets it, rather than the plist, because that fixes the
  interactive case too. The directory must stay empty — that is what makes it
  boring — and `src/llm/claude.test.ts` fails if anything writes there.
- **`--allowedTools` pre-approves; `--tools` is what removes a tool.** Measured
  twice now: an allow-list alone still let a session read any file. `--tools`
  strips the *built-in* set only — every tool of every connected MCP server
  stays in the list regardless, so a calendar read is offered Gmail's
  `send_message` and Drive's `share_file`. They are not pre-approved, so a
  headless run cannot call one, but `connector.ts` also denies the Google
  Calendar connector's four write tools by name, because a read-only promise
  kept only by the prompt is not kept. A bare `mcp__` prefix denies nothing;
  `--disallowedTools` matches real server and tool names only.
- **`bunfig.toml` preloads `src/testing/test-setup.ts`, which points `$AULA_DIR`
  at a scratch directory.** "Tests never touch `~/.aula`" used to be kept by
  convention — every test passed an explicit path — and the first code to derive
  a path itself broke it on the first run. `AULA_DIR` is resolved at module load,
  so this cannot be done from inside a test file.
- **The schedule's unit is a slot, not a day.** `aula schedule` installs 06:00
  and 18:00, every day of the week, and `slots.ts` defines the half-open
  interval each one owns — 06:00 until 18:00, then 18:00 until 06:00. Every
  instant belongs to exactly one, which is what gives a laptop opened at 14:00
  something to ask about. The ledger check was `todayIsComplete` while there
  was one run a day; at 18:00 that read the morning's `complete: true` and the
  evening overview could never have existed.
- **The plist has three triggers, and `launchd.plist(5)` is the opposite way
  round from what the names suggest.** `StartCalendarInterval` fires at the slot
  times *and* is the wake-up catch-up: a firing missed during sleep is started
  the next time the Mac wakes, several coalesced into one. `RunAtLoad` covers
  the Mac that was switched off, where nothing was loaded to be overdue.
  `StartInterval` is dropped outright during sleep — the man page blames
  kqueue(3) — so it catches up nothing; it covers the awake Mac whose
  coordinator died with the slot's own firing already spent, and it replaced a
  grid of retry entries thirteen times its size. Do not attribute the wake
  behaviour to `StartInterval`; that was wrong when first written here.
  All of it is affordable only because `--catch-up` answers a settled slot from
  one file read without opening a socket, so do not add work before that check.
- **A spent retry window is written to `state.json` as `exhaustedSlot`.** The
  coordinator's three hours start at the first attempt that *ran*, so a Mac
  that wakes at noon still gets all of them — which means a later process
  cannot recompute the window and has to be told. Without it the heartbeat
  hands a permanent failure three fresh hours every fifteen minutes until the
  next slot. It is anchored to the slot rather than kept on `lastRun`, so it
  expires by itself and no later run can clear it.
- **The slot times are in `~/.aula/config.json` as well as in the plist.** A
  plist cannot be asked what it says, and the run a heartbeat starts has to
  know which slot it is in. `aula schedule` writes both, config first.
- **The calendar session must be told to wait for its own connector:
  `MCP_CONNECTION_NONBLOCKING=false`.** A claude.ai connector is not configured
  on disk — the CLI fetches the account's server list from
  `api.anthropic.com/v1/mcp_servers` at startup and connects each one — and by
  default that whole leg is fire-and-forget (`[MCP] claude.ai connectors running
  fully async (nonblocking)` in `claude --debug-file`). The session's tool list
  and its `init` envelope are assembled without it. Measured here: the fetch
  lands ~380ms in, the prompt long before that, and six runs in seven reported
  `mcp_servers: []` and never called the tool. `aula calendars` therefore told a
  user with Google Calendar connected that it was not connected, while
  `claude mcp list` said `✔ Connected` — the seventh run won the race and
  worked, which is what kept it looking intermittent. `connector.ts` sets the
  variable; nothing else needs it, and the brief's own `claude` calls should not
  buy the round-trip. **`mcp_servers: []` in an `init` line is not evidence that
  a connector is missing** — it is equally the account list never having
  arrived, which `ANTHROPIC_API_KEY` in the environment also causes by taking
  precedence over the claude.ai login.
- **MCP tools are deferred in a headless run, so a prompt that forbids other
  tools must exempt `ToolSearch`.** The session lists an MCP tool's name and
  withholds its schema until `ToolSearch` asks for it, so "call no other tools"
  forbade the only route to the tool it was demanding.
- **A connector's `status` vocabulary is `connected`, `pending`, `needs-auth`,
  `failed`, `disconnected`.** `needs-auth` is the lapsed Google grant — the one
  state where "reconnect it" is the right advice — and it used to fall past the
  status check and come back as `list_events blev aldrig kaldt`.
- **Both connector reads are paginated, and each page is a whole `claude`
  subprocess.** `listAllPages` follows up to four. `list_events` used to ask for
  250 and treat a `nextPageToken` as fatal, so a busy shared calendar lost its
  fortnight rather than its 251st appointment; `list_calendars` never read the
  field at all and the connector's default page is 100, so a long calendar list
  silently lost its tail — which surfaced two commands later as `calendars set`
  refusing a name that plainly exists. Ask for `pageSize` explicitly.
- **A partial calendar is partial, never empty.** `loadPersonalEvents` catches
  per calendar *and* per event: one appointment whose shape this code cannot
  read used to escape to the per-calendar catch and cost the family the whole
  fortnight, reported as an unreadable calendar. The per-event warning is one
  line with a count, not one line per event — a wholly unreadable calendar would
  otherwise write two hundred `Datastatus` lines onto the page.
- **The calendar session's read-only promise is kept by an allow-list, not only
  by `--disallowedTools`.** `attemptTool` rejects a session that called anything
  beyond the one tool it asked for plus `ToolSearch`. `WRITE_TOOLS` is still
  named by name because that is all `--disallowedTools` matches, but it goes
  stale the moment the connector grows a fifth way to write; the allow-list does
  not. The module header promised this check under the name `expectedCalls` for
  a long time before it existed.
- **`doctor` reads the configured calendars for real.** A lapsed connector
  otherwise passes every Aula check, accepts `aula schedule`, and drops the
  calendar half of the brief at 06:00 with nobody watching — and a page with no
  appointments on it is indistinguishable from a quiet fortnight. It warns
  rather than fails (every Aula read still works), skips when no calendar is
  configured, and names a configured calendar that answered with nothing,
  because that is what a wrong id looks like.
- **A missing connector is exit 5, not 1.** "Setup required — do not retry
  unchanged": no amount of waiting connects a connector. A wrong calendar name
  is exit 2. Both used to be 1, which the fleet reads as "a source is down,
  retry later".
- **A model answer has problems and warnings, and only problems retry.** A
  refused card or a missing calendar verdict is a problem: the run stays
  incomplete, the scheduler tries again, the answer is not cached. Dropped
  prose whose decision survived — an ungrounded topline or child line, a
  verdict's summary — is a warning: named in *Datastatus*, logged as
  `brief.model.adjusted`, and never worth another five-minute model call.
  They were all problems once, and one invented "8/9-11" in a verdict summary
  kept 2026-09-11's scheduled runs retrying the same extraction twelve times.
  The card repair runs whenever a card was refused, not only when card dates
  were the *only* failures, and the rules fallback fills in solely for the
  sources the refused cards cited (`rejectedSourceKeys`).
- **The weekly plan is read for this week and next, and the timetable is
  recurrence evidence.** PE on Thursday in two consecutive plans grounds *husk
  idrætstøj om torsdagen* and its next-Thursday date without any sentence
  saying "hver torsdag"; one week alone is a one-off. `recurrenceWeekdayOf` in
  `dates.ts` is the one reader of that evidence, shared by the validator and
  the ranker — it was two slightly different copies.
- **An answer is as old as its oldest part, and says so.** Every cached
  response is stored with the moment it was fetched (`Stamped` in `cache.ts`),
  `ResponseCache.oldestHitAt` is the oldest one a process answered from, and
  `AulaClient.dataFetchedAt()` turns that into the `fetchedAt` on `digest` and
  on every list envelope. `digest` used to stamp itself `generatedAt: now`
  whether it had made sixty requests or none — and "did the teacher reply yet?"
  is a question where ten cached minutes are the whole answer. An entry written
  before entries carried a time reads as a miss.
- **`status` answers from disk, and never refreshes anything.** It reported
  the access token's remaining minutes — which renew themselves and say nothing
  about whether the login works — and read them through the refreshing path,
  so asking could retire the token of a run beside it. Whether Aula accepts the
  login is only knowable by asking Aula, so `session-seen.ts` writes the answer
  down whenever a command does: `profiles.getProfileContext` succeeding (the
  bootstrap every uncached read performs, and the only response that states
  step-up), an `AulaAuthError` at the top level, and a login, logout or
  `refresh-stepup`. `status` reads that note back. Aula publishes no lifetime
  for the refresh token or for step-up, so there is no expiry to report; the
  last observation, with its time, is the substitute.
- **Two caches, and `cache status` reports both.** Remote *responses* — Aula,
  the vendor weekly plans and the Google Calendar reads — share one TTL'd
  `ResponseCache` in `~/.aula/cache/responses`; the model's *layout* is cached
  separately in `~/.aula/brief/cache`, keyed on content with no TTL. `--no-cache`
  bypasses both, and `cache clear` empties both. It used to empty only the
  responses, so clearing to force a fresh brief still served the stored ranking
  back in ten milliseconds.
- Reads are cached 600 s in `~/.aula/cache/responses`, so a second `digest`
  inside the window makes no requests; `--no-cache` is the first thing to reach
  for and `cache status` shows what is held. Never cached:
  `aulaToken.getAulaToken`, because the vendor-token retry needs a genuinely
  fresh one, and failed calls, so a transient 403 is not pinned for the TTL.
  `#ensureApiVersion` and `#ensureSession` bypass the cache deliberately.
- The calendar goes through that same response cache, keyed on
  `{calendarId, from, to}` — `calendarWindow` truncates to local midnight, so
  the key is stable for a day. Per calendar, and storing the *raw* connector
  answer: one unreadable calendar must not cost the others their entry, and
  `toPersonalEvent` is ours to change. Without this, two configured calendars
  cost ~25 s of `claude` subprocesses on *every* run — on a fully warm
  `aula new`, essentially the entire runtime.
- `login`, `logout` and `refresh-stepup` drop the cache — threads cached without
  step-up under-report the sensitive ones and look complete.
- An access token can be refused while far from its `exp`: a `refresh_token`
  grant retires the previous one and the loser gets `403` + code `20`. The
  client re-reads the token store, adopts a newer token or buys one, and replays
  once. Keep that order — two runs that both refresh rotate each other's tokens
  forever.
- **A list that was cut says so, in the payload.** Every command that takes
  `--limit` prints `{ <rows>, truncated, limit }` through `emitList`, and the
  collectors in `digest.ts` return `Collected<T>` so the fact cannot be dropped
  by omission. They were bare arrays, the default cap of 20 applied even on top
  of a `--since` window, and the only collector that reported a cut did it
  through an out-parameter that `buildDigest` alone passed — so `messages --full
  --since 30d`, the skill's own example, answered with a fraction of a busy
  month that read as all of it. A `--since` window now lifts the default cap.
- **A presigned URL never reaches a payload.** `attachments.ts` has always said
  they must not round-trip through a model — one mangled character is a
  `MalformedSignature` 403 that reads like a dead login — while `digest`,
  `thread`, `messages --full`, `posts`, `attachments` and `commonfiles` each
  printed them, a few hundred tokens apiece, and a post's attachment had no
  download command, so copying the URL out of the JSON was the only way to get
  it. Payloads carry `AttachmentRef` (`describeAttachments`): an `index` for
  `attachment` or `post-attachment`, and a `link` for the one kind that is a web
  address rather than a download. A thread's attachments are numbered across
  all of its messages, which is why `normaliseMessages` is plural and why the
  index is null for one `--page` or an incomplete read — `attachments` used to
  take `--page` and number that page from zero, positions `attachment` then
  resolved against the whole thread.
- **`contacts` rows are ours, not Aula's.** It printed the wire object with a
  `group` stapled on — the one command whose keys Aula could rename, and the
  one carrying the fleet's bridge (`--role guardian` → `address`), under
  `postalDistrict`. `normaliseContact` in `cli-helpers.ts` is the shape now,
  and `contract.json` declares it.
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

**`typescript/await-thenable` is off in this repo's test files, and only this
repo's.** Every one of the eleven findings was `await expect(p).rejects
.toThrow(...)`, which in Bun genuinely returns a promise that must be awaited —
`@types/bun` types it as returning void. Dropping the awaits to satisfy the
rule would turn each of those assertions into an unhandled rejection that
asserts nothing. It is scoped to `.oxlintrc.json` here rather than the fleet
base because aula-cli is the only Bun repo; the rule stays on everywhere else.

**The rest of the lint and format config is not this repo's to change.**
`.prettierrc` and `oxlint.base.json` are copies owned by the fleet root
(`../config/`), copied in by `../scripts/sync-config.sh` and asserted by
`src/config.test.ts`. `.oxlintrc.json` extends the vendored base and holds only
what is genuinely local: the `src/browser` React overrides, the ignore list, and
the two rules above. `../config/README.md` says which rules are on and why.

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
runtime — have to be imported (`with { type: 'text' }`, or `type: 'json'` as
`src/contract.ts` does), not read from disk.
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
