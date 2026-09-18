---
name: aula
description: Query Aula (aula.dk), the Danish school and daycare platform, to answer questions about the user's kids — messages from teachers and other parents, posts/opslag from school and daycare, calendar events, weekly plans, photo albums, and check-in/check-out. Use whenever the user asks what is happening at school or daycare, what they have missed, whether anything needs a reply or has a deadline, what a child has been doing or whether they went on a trip, or asks about a specific child, teacher, class, event, or message. Also use for "aula", "skole", "børnehave", "SFO", "opslag", "ugeplan", "forældremøde", "billeder", "galleri", "tur", and for generating the daily "Aula AI oversigt" brief.
---

# Aula

Read-only CLI over Aula's internal API. The read commands print JSON by default;
add `--text` for a human-readable rendering. The commands that manage the
installation itself — `open`, `publish`, `calendars`, `remember`, `preferences`,
`forget`, `schedule`, `login`, `logout`, `refresh-stepup` — already print text
and reject `--text`.

{{AULA_CLI_LOCATION}}

```bash
aula <command>
```

## Hard rule: read-only

This tool can only read. Never attempt to send a message, reply, create a post,
answer a calendar invitation, or mark anything as read — the client refuses
those calls in its transport layer anyway. When something needs a reply, tell
the user what it is and let them answer in Aula themselves.

## Start here

If you don't yet know the family, run `whoami` once — it lists the children,
their institutions, and which vendor widgets the schools expose.

For almost any open question ("what have I missed?", "anything important?",
"what's happening this week?") run one command:

```bash
aula digest --days 14
```

`digest` returns threads (with full message bodies), posts, upcoming calendar
events, presence and weekly plans in a single payload. Widen with `--days 30`
when the user asks about a longer period or 14 days comes back thin.

The `attention` block pre-computes the signals Aula itself exposes
(`unreadThreads`, `importantPosts`, `eventsAwaitingResponse`, …). Use it as a
starting point, **not** as the answer — Aula's own flags are weak signals, and
ranking what actually matters to this family is your job.

## Commands

| Command | What it gives you |
| --- | --- |
| `digest --days 14` | Threads, posts, calendar, presence and weekly plans in one payload. Default choice. |
| `whoami` | Children, institutions, widgets, and the id sets the API needs |
| `messages --limit 20` | Thread list, newest first (bodies truncated) |
| `messages --full --since 30d` | Thread list with every message body |
| `thread <id>` | One thread, all messages, attachments |
| `posts --limit 20` | Posts/opslag from school and daycare |
| `galleries --since 30d` | Photo albums: title, date, photographer, group |
| `calendar --days 30` | Upcoming events, incl. ones awaiting a response |
| `presence` | Today's check-in/check-out per child |
| `pickup-times` | The recurring komme/gå plan (drop-off and pickup times) |
| `groups` | Which groups and classes each child belongs to |
| `contacts [--group id] [--role child\|guardian]` | Class contact list ("kontaktliste"); `--role guardian` carries each guardian's `address` when the family shared one |
| `birthdays` | Classmates' birthdays, soonest first |
| `notifications` | Unread badges Aula is currently showing |
| `attachments <threadId>` | List a thread's attachments, each with its `index` |
| `attachment <threadId> [index]` | Download one of a thread's attachments to disk |
| `post-attachment <postId> [index]` | Download one of a post's attachments to disk |
| `commonfiles` | "Fælles Filer": class timetables, holiday plans, policies |
| `commonfile <id\|title>` | Download one shared file |
| `new` | Generate the daily "Aula AI oversigt" and open it |
| `open [--web]` | Open the newest overview — the local page, or the hosted copy |
| `publish [--off]` | Keep a hosted copy of the overview (per installation; `--off` stops) |
| `calendars` | Which of the family's own calendars the overview reads |
| `calendars set <name> [<name> ...]` | Read exactly these displayed names; `set none` reads none |
| `remember "<ønske>"` | Record a standing wish about what this family wants highlighted |
| `preferences` / `forget <n>` | List those wishes / drop number n |
| `preferences reset` | Back to the list aula-cli ships with (says what it dropped) |
| `doctor --text` | Call every endpoint and report status + timing |
| `cache status` / `cache clear` | What is cached; drop it all |

`commonfiles` is where the **class timetable (skema)** often lives — it is not
in the calendar and not in the weekly plan. If the user asks what a child has
on a given day and `weekly-plan` is thin, look here for a "skema" PDF.
Downloading it gives a local path — read that with `pdftotext -layout`, not
with your file-reading tool:

```bash
pdftotext -layout skema.pdf -
```

A skema is a grid: days across, periods down. `-layout` is what keeps the grid,
and plain extraction returns the lessons as a flat list in which a Monday
lesson is indistinguishable from a Thursday one. The same holds for any
`attachment` or `commonfile` worth downloading, since a ugeplan is a table too,
and it is far cheaper either way: a page of PDF costs about 2,300 image tokens
against a few hundred as text.

**An attachment is a position, never a URL.** Wherever a message or a post
appears — `digest`, `thread`, `messages --full`, `posts` — its attachments look
like this:

```json
{ "index": 1, "id": 402, "name": "Pakkeliste.pdf", "kind": "file", "link": null }
```

Hand `index` to `attachment <threadId> <index>` (a thread's attachments are
numbered across all of its messages) or `post-attachment <postId> <index>`
(numbered within the post). Both save the file and print its `path`; then read
it, with `pdftotext -layout` if it is a PDF. Aula's download URLs are presigned
and deliberately absent from every payload: one mangled character in a
signature is a 403 that looks like an expired login, so they never pass through
you. `kind` is `file`, `media` or `link`; a `link` has no bytes — its address is
in `link`, and it is the only kind with one. `index` is `null` when you read one
`--page` of a thread, or when `messagesIncomplete` is true: the position cannot
be known until the whole thread is read, so re-read it before downloading.
`commonfiles` rows carry no URL either — `commonfile <id>` fetches one.

**`galleries` is not in `digest`** — run it separately. It reads album metadata
only, never the photos, and that metadata is often the best evidence of what a
day actually contained: an album titled after a trip, dated that day, says the
trip happened even when the weekly plan says nothing. Two caveats: the date is the
album's creation date (usually the day of the event, but it can lag a day), and
there is no photo count.

Weekly plans come from third-party vendor widgets rather than Aula itself —
`widgets` shows which vendor each school uses:

| Command | What it gives you |
| --- | --- |
| `weekly-plan [--week 2026-W33] [--next]` | Weekly plan (EasyIQ / Meebook / SkolePortal) |
| `weekly-letter` | Weekly letter (MinUddannelse) |
| `tasks` / `assignments` / `reminders` | Homework, per vendor |
| `homework` | All three homework sources in one call |

**Commands are English; the user is Danish.** Nothing in the CLI answers to a
Danish command name, so translate before you run anything. The words a parent
actually uses, and what to run for each:

| They say | Run |
| --- | --- |
| ugeplan, ugeskema, "hvad laver de i denne uge" | `weekly-plan` |
| ugebrev, "brevet fra skolen" | `weekly-letter` |
| lektier, opgaver, hjemmearbejde, huskelisten | `homework` (or `tasks` / `assignments` / `reminders` for one vendor) |
| opslag, nyheder fra skolen | `posts` |
| beskeder, samtaler | `messages` / `thread` |
| kalender, arrangementer, forældremøde | `calendar` |
| komme/gå, hentetider, afhentning | `pickup-times` / `presence` |
| billeder, galleri, album | `galleries` |
| skema | `commonfiles` (look for a "skema" PDF) |
| kontaktliste | `contacts` |
| fødselsdage | `birthdays` |
| Fælles Filer | `commonfiles` / `commonfile` |

`homework` is the safe default when they just say *lektier* — it reads all
three vendors, and which one a school uses is not something they know.

**A weekly plan carries a `status`, and you must read it.** The vendors fail
independently of Aula, and a failed fetch has the same shape as a quiet week:
`items: []`. `status` is what tells them apart:

- `ok` → the vendor answered for every child asked; `items` is the plan, and
  an empty one is a genuinely empty week. Say so plainly.
- `partial` → items are real, and `warnings` names the child that is missing.
  Report what you have *and* who is missing. Daycare children are left out of
  the vendors automatically (weekly plans are school products), so a warning
  naming a child is a real fetch problem for a school child — never dismiss it
  as "the little ones just don't have a plan".
- `failed` → nothing readable came back and `warnings` says why. This is never
  an empty week. Say so — "the weekly plan could not be fetched (the vendor
  answered HTTP 500), so I can't see whether anything is planned".
- `skipped` → the vendor was not asked, because no selected child attends a
  school. An answer: there is nothing to read.

`weekly-plan`, `weekly-letter`, `tasks`, `assignments`, `reminders` and
`homework` exit 1 with no body when nothing readable came back and a vendor
failed — the vendor's reason is on stderr, and a failed read is never cached,
so trying again in a few minutes is right. `digest` never exits for one part:
read `weeklyPlans[].status` there, and a plan whose `provider` is
`"unavailable"` is a capability that threw before any vendor answered.

### When the CLI does not cover it

Reach for this only when no command above answers the question — a wrapped
command resolves the id sets, pages to the end and reports a cut list, and a
hand-rolled call does none of that.

`aula --upstream` prints the whole bypass guide: Aula's URL grammar, every
method and vendor endpoint this tool knows, the response envelope, and the
traps that return a wrong answer rather than an error. Read it before the
first `raw` call; it needs no login and makes no request.

The short version: `raw <method> [k=v ...]` reaches any Aula *read* method
that has no wrapper, and `raw <method> --body '<json>'` reaches the reads Aula
models as a POST (the calendar is the one that comes up). Repeat a bare key for
an array — `childIds=11 childIds=22`, never `childIds[]=11`, which is sent
wrong and comes back as an empty list rather than an error.

Options — `aula <command> --help` says which a command takes, what each
defaults to, and what the JSON holds:

| Option | Meaning |
| --- | --- |
| `--text` | Human-readable text instead of JSON |
| `--limit <n>` | At most n rows; the payload says when this cut the list |
| `--since <7d\|3w\|2026-08-01>` | Rows on or after this; lifts the default cap |
| `--child <name\|shortName\|id>` | One child only |
| `--days <n>` | How many days (`digest`, `calendar`, `pickup-times`; calendar at most 50) |
| `--week <2026-W33>` / `--next` | Which ISO week a plan is read for (this week by default) |
| `--from <YYYY-MM-DD>` / `--to <YYYY-MM-DD>` | A window, for `pickup-times` and the plan commands |
| `--full` | Every message body, not only the preview Aula cuts short |
| `--unread` / `--important` | Unread threads only / posts Aula flags important only |
| `--page <n>` | One page of a thread instead of all of it (attachment `index` is then null) |
| `--group <id>` / `--role <child\|guardian>` | Which contact list: a group from `groups`, and which side of it |
| `--widget <id>` | Read one vendor widget directly, bypassing detection |
| `--out <path>` | Where a download is written |
| `--no-cache` / `--cache-ttl <seconds>` | Read from Aula regardless of the cache / how old a cached response may be (600) |

**A list says when it was cut, and you must read that.** Every command that
takes `--limit` — `messages`, `posts`, `galleries`, `commonfiles`, `birthdays` —
answers with its rows under their own name plus two fields:

```json
{ "threads": [ … ], "truncated": true, "limit": 20 }
```

The row keys are `threads`, `posts`, `albums`, `files` and `birthdays`.
`truncated: true` means more rows matched than you are holding: raise `--limit`
before you summarise, or say plainly that you are looking at the newest `limit`
only. Never report a truncated list as everything there is.

`messages`, `posts` and `galleries` return the newest 20 when you give neither
`--limit` nor `--since`. A `--since` window lifts that cap — `--since 30d`
returns every row in the month and `limit` comes back `null` — so prefer a
window to a guess at a big enough number. `digest` carries the same fact as
`collectionLimits.threads` / `.posts`, non-null only when its `--limit` cut
something.

Responses are cached for 10 minutes, and every answer says how old it is:
`digest` carries `fetchedAt` beside `generatedAt`, and each list envelope
carries `fetchedAt` — when the oldest response in it was actually read from
Aula. When the two are minutes apart, say so ("as of 08:12"). Add `--no-cache`
when the user asks whether something *just* arrived, or when an earlier answer
in this conversation may already be stale; `fetchedAt` is then now.

## Answering well

- **Answer in the language the user writes in.** The source material is Danish;
  translate rather than quoting Danish back at an English question.
- **Lead with what needs action** — deadlines, sign-ups, meetings to confirm,
  things to bring on a given day. Then what is merely informative.
- **Always attribute and date** a claim: sender, class, date. A summary the
  user can't trace back to a source is not useful.
- **Say which child** something concerns.
- **Cite thread/post ids** so the user can open them in Aula.
- **Don't inflate.** Daycare posts are often just "we played outside today".
  Say the week was quiet when it was quiet.
- **Distinguish a real deadline from a passing mention**, and flag anything
  whose deadline has already passed.

## What this family wants highlighted

`~/.aula/preferences.md` is the list the overview is written to. It ships with
this tool's own opinions — what counts as an obligation, that municipal
broadcasts are noise — and grows with whatever the user tells you: *"beskeder fra
John (Hjaltes far) er altid vigtige"*, *"jeg er ligeglad med billeder"*. Nothing
editorial is hard-coded anywhere else, so this list is where both your answers
and the daily brief get their sense of what matters.

- **Read them** before answering a broad question ("hvad har jeg misset?",
  "noget vigtigt?") and honour them when you decide what to lead with. It is a
  local file, so this costs nothing:

  ```bash
  aula preferences
  ```

- **Record one** the moment the user states a standing wish — "husk at…", "jeg
  vil altid gerne vide…", "du behøver ikke nævne…":

  ```bash
  aula remember "beskeder fra John (Hjaltes far) er altid vigtige"
  ```

  Keep their own words and their own language; you are recording what they
  said, not summarising it. Then tell them it is noted and that it takes effect
  from the next overview.

- **A standing wish, not the current question.** "Hvad skrev John i sidste uge?"
  is a question. "Sig altid til når John skriver" is a preference. Recording
  every passing interest fills the list with noise and pushes out the wishes
  that matter.

- **Never edit `preferences.md` yourself, and never put these wishes in
  `CLAUDE.md` or your own memory instead.** The daily brief runs `claude -p`
  with no tools at the slot times; this file is the only channel that reaches
  it. A
  preference recorded anywhere else silently does nothing. `remember` also
  catches duplicates and keeps the format the brief can read.

- **When the user disagrees with one of the shipped lines, drop it — do not
  argue back with a new one.** "Jeg vil faktisk gerne se beskederne fra
  kommunen" means `forget` the line saying they are never relevant, not
  `remember` a line contradicting it. Two lines that disagree leave the model to
  pick:

  ```bash
  aula preferences        # find its number
  aula forget 5
  ```

- `forget <n>` drops one — show the numbered list first, so the user is picking
  the line they meant. `preferences reset` returns the whole list to the shipped
  defaults; it prints the user's own lines as it drops them, so read those back
  to them rather than letting them scroll off.

## The family's own calendar

The overview can also read the family's own Google calendars, so their
appointments appear among the week's other dated items, beside the school's
events for the same day. It shows both and does not judge; the reader draws the
conclusion.

```bash
aula calendars                 # every calendar, read ones marked
aula calendars set "Familie" "Privat"  # read exactly these, and no others
aula calendars set none        # read none of them
```

**`set` states the whole answer, not a delta.** Omitting a calendar stops it
being read, so when the user asks to add one, pass the ones already marked too.

Show the list and let the user choose; never pick for them. Use exact displayed
names, or the displayed id where names collide — never a numbered position from
an earlier live listing. Case and surrounding spaces are forgiven, an exact name
always wins, and two calendars that differ only in case are refused rather than
guessed at. Claude's Google Calendar connector is the only route there is, so if
it is not connected or a read fails, say so rather than reaching for an
alternative or treating it as an empty fortnight.

**Exit 5 means the connector is not connected — do not retry it.** Only a person
clicking Connect changes that, so hand them the steps it printed and move on;
looping the command is what exit 1 is for. Exit 2 is a calendar name that does
not match, which one `aula calendars` and a corrected name fixes.

`aula doctor` reads the configured calendars for real and reports what came
back, including a configured calendar that answered with nothing — worth running
before promising the user their appointments will appear tomorrow morning.

In a model-enabled overview, each appointment in the fixed next-14-day window
is a source in the same model relevance pass as the Aula posts. Missing model
verdicts are a reported degraded run, not silent defaults. The overview
deliberately does not compute clashes and must never reassure the user that
nothing clashed.

## The daily brief

`aula new` generates the "Aula AI oversigt" — a self-contained HTML
page in `~/.aula/brief/` — and opens it (`--no-open` to skip). It calls
`claude` itself for extraction; a deterministic local renderer builds the
layout. `--no-llm` produces a rules-only page. `aula open` shows the
newest page without regenerating, and
`open --web` opens the hosted copy where one is configured — `aula
publish` sets that up (it publishes the newest page and saves the URL in
`~/.aula/config.json`; `publish --off` stops it). `aula schedule` generates
it automatically at 06:00 and 18:00, every day of the week (`--at HH:MM,HH:MM`
to change the slot times, `--remove` to stop; launchd on macOS, Task Scheduler
on Windows); a slot missed because the Mac was off or asleep is caught up
within minutes of the next wake. Offer both — don't install or publish
unasked.

## Session handling

Auth is a real MitID login; tokens live encrypted in `~/.aula/tokens.json` and
refresh themselves, so most of the time there is nothing to do.

**Exit code 5 means there is no usable session**, and no retry changes that.
Every read of Aula needs one. These still answer without one:

| Command | What it gives you |
| --- | --- |
| `aula open` | the newest overview, already on disk |
| `aula status` | what is stored, and what Aula last said about it — no request is made |
| `aula preferences` | what the overview is written to (`remember` / `forget` work too) |
| `aula --contract` | what this tool emits |

`status` answers from disk alone. `session` is Aula's last verdict on the
stored login — `{ state: "accepted" | "rejected", checkedAt, steppedUp }`, or
`null` when no command has reached Aula with it yet — and `tokens` says when
the current pair was issued and when the access token expires. An expired
access token is renewed silently by the next read and is never a reason to log
in; a `rejected` state, or an exit 5 from a read, is. Aula publishes no lifetime
for the refresh credential or for step-up, so `checkedAt` is the honest
substitute: how long ago the login was last known to work.

A new session is `aula login`. **Ask the user before starting it, and never
start one unprompted:** it opens a page on their machine and costs them an
approval in the MitID app on their phone, and an abandoned attempt leaves a
pending approval behind that makes the next one fail. Tell them what you could
not read and why, offer the login, and wait for a yes. The error line's `hint`
says the same thing.

Exit codes are the fleet's shared table — `aula` used to have its own, colliding
scheme, which meant an agent driving several of these tools could not branch on
a code without knowing which tool it came from:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | success | use the JSON on stdout |
| 1 | Aula or a vendor is down, or a bug in this client | retry later, unless the error line's code is `BUG` |
| 2 | usage error | fix the command line |
| 4 | resolved, but nothing to report | a real answer — the JSON is still on stdout; record it and move on |
| 5 | no usable session, or setup | never retry unchanged; ask the user before any `aula login` |

**On exits 1, 2 and 5 the last line of stderr is JSON** — read it instead of the
prose above it:

```json
{"error":{"code":"SETUP","message":"Not logged in — …","hint":"…"}}
```

`code` is `USAGE` (exit 2), `SETUP` (exit 5), or for exit 1 one of `NETWORK` (no
answer arrived — retry), `UPSTREAM` (Aula or a school vendor answered with an
error) and `BUG` (this tool's fault — report it, do not retry). `hint` is the
next action, or null. Nothing is on stdout on those exits, except `doctor`,
whose report is still there when a check failed.

JSON on stdout is a single line when you run it; pipe it through `jq` to query
or read it.

`aula --contract` prints what this tool emits, as JSON, with no login and no
request: `exit_codes` with each code's meaning and `body_on` for which of them
carry a body, the error line's shape and codes, and under `commands` every read
command's top-level keys, what is inside them (`nested`, by jq path), which are
nullable, what the exit-4 body looks like, and `notes` on reading them. Ask it
rather than guessing at a key. The output is the one frame every tool in this
fleet prints, down to the `tool` key naming which one answered, so reading it
once teaches you how to read any of them.

**Exit 4 is not a failure.** A read that worked and came back empty — no unread
threads, no albums in the window, a school with no weekly-letter widget — exits
4 with its usual JSON on stdout (`[]`, or `{ "threads": [], … }`). Say that there
was nothing; do not retry, and do not treat the non-zero code as an error.
`digest` never exits 4. A weekly plan whose `status` is `failed` is never 4
either: that is a fetch that failed, not an empty week, and it exits 1.

`raw` with a method name the read-only guard refuses, or one Aula does not have,
is exit 2 — fix the name rather than retrying.

`--json` is accepted and ignored: JSON is already the default, and the flag
exists so you do not have to remember which tool in the fleet wants it.

## Notes and limits

- **Sensitive threads** (`sensitive: true`) require a stepped-up session, which
  may expire before the login does. `whoami` reports `isSteppedUp`. When it is
  `false`, threads may be masked or missing; say so and suggest
  `aula refresh-stepup` before treating a quiet result as complete.
- Message bodies in `messages` (without `--full`) are truncated by Aula itself.
  Use `--full` or `thread <id>` before quoting or summarising in detail.
- The data is personal and about children — keep it in the conversation. Never
  publish it, write it to disk, or disclose it to anyone but the user. If a
  scratch file is truly unavoidable, it goes under `~/.aula/` — never the
  working directory, which is very often a repository the user commits from.

  One deliberate exception, because the rule as written forbade something the
  fleet's own instructions require: a guardian's address that the user asked
  about may be passed to the sibling public-register tools (`bolig`,
  `tinglysning`, `dgs`, `cvr`). Those are lookups against public records, not
  disclosures of Aula data. Nothing else crosses that line, and the address
  goes no further than those tools.

- **This tool is only ever called with a name the USER typed.** It reads the
  user's own children's school and daycare, so it can turn a parent they
  already know into an address — it is not a people search. A name discovered
  by another tool (an owner from `tinglysning`, a proprietor from a `cvr`
  c/o field) goes to `dgs` or `cvr`, never here. This is the one hard boundary
  in the fleet, and it is repeated here because a session that loads only this
  skill never reads the fleet-level AGENTS.md where it also lives.
