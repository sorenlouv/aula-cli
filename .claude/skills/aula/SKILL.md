---
name: aula
description: Query Aula (aula.dk), the Danish school and daycare platform, to answer questions about the user's kids — messages from teachers and other parents, posts/opslag from school and daycare, calendar events, weekly plans, photo albums, and check-in/check-out. Use whenever the user asks what is happening at school or daycare, what they have missed, whether anything needs a reply or has a deadline, what a child has been doing or whether they went on a trip, or asks about a specific child, teacher, class, event, or message. Also use for "aula", "skole", "børnehave", "SFO", "opslag", "ugeplan", "forældremøde", "billeder", "galleri", "tur", and for generating the daily "Aula AI oversigt" brief.
---

# Aula

Read-only CLI over Aula's internal API. Every command prints JSON by default;
add `--text` for a human-readable rendering.

**Where the CLI lives:** {{AULA_CLI_DIR}}. Run every command from that
directory. (If you are already working inside the aula-cli repository, that is
the directory.) No build step — Bun runs the TypeScript directly:

```bash
bun src/cli.ts <command>
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
bun src/cli.ts digest --days 14
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
| `contacts [--group id]` | Class contact list ("kontaktliste") |
| `birthdays` | Classmates' birthdays, soonest first |
| `notifications` | Unread badges Aula is currently showing |
| `attachments <threadId>` | List a thread's attachments |
| `attachment <threadId> <n>` | Download one to disk |
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
on a given day and `weekly-plan` is thin, look here for a "skema" PDF. Downloading
it gives a local path you can then read.

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

**A weekly plan carries a `warnings` array, and you must read it.** The vendors
fail independently of Aula, and a failed fetch has the same shape as a quiet
week: `items: []`. They are not the same thing and must never be reported the
same way:

- `items: []` **and no warnings** → the vendor answered; the week is genuinely
  empty. Say so plainly.
- `items: []` **with warnings** → the fetch failed. Say so — "the weekly plan
  could not be fetched (the vendor answered HTTP 500), so I can't see whether
  anything is planned" — and never claim the week is empty.
- **Items present with warnings** → partial. Report what you have *and* which
  child is missing. Daycare children are excluded from the vendors
  automatically (weekly plans are school products), so a warning naming a
  child is a real fetch problem for a school child — never dismiss it as "the
  little ones just don't have a plan".

The same applies to `digest`: read `weeklyPlans[].warnings`, and a plan whose
`provider` is `"unavailable"` means that whole capability threw.

`raw <method> [k=v ...]` reaches any Aula *read* method that has no wrapper.

Options: `--text`, `--limit <n>`, `--since <7d|3w|2026-08-01>`,
`--child <name|shortName|id>`, `--days <n>`, `--week`, `--next`, `--full`,
`--unread`, `--important`, `--group <id>`, `--out <path>`, `--no-cache`,
`--cache-ttl <seconds>`.

Responses are cached for 10 minutes. Add `--no-cache` when the user asks
whether something *just* arrived, or when an earlier answer in this
conversation may already be stale.

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
  bun src/cli.ts preferences
  ```

- **Record one** the moment the user states a standing wish — "husk at…", "jeg
  vil altid gerne vide…", "du behøver ikke nævne…":

  ```bash
  bun src/cli.ts remember "beskeder fra John (Hjaltes far) er altid vigtige"
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
  with no tools at 06:30; this file is the only channel that reaches it. A
  preference recorded anywhere else silently does nothing. `remember` also
  catches duplicates and keeps the format the brief can read.

- **When the user disagrees with one of the shipped lines, drop it — do not
  argue back with a new one.** "Jeg vil faktisk gerne se beskederne fra
  kommunen" means `forget` the line saying they are never relevant, not
  `remember` a line contradicting it. Two lines that disagree leave the model to
  pick:

  ```bash
  bun src/cli.ts preferences        # find its number
  bun src/cli.ts forget 5
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
bun src/cli.ts calendars                 # every calendar, read ones marked
bun src/cli.ts calendars set "Familie" "Privat"  # read exactly these, and no others
bun src/cli.ts calendars set none        # read none of them
```

**`set` states the whole answer, not a delta.** Omitting a calendar stops it
being read, so when the user asks to add one, pass the ones already marked too.

Show the list and let the user choose; never pick for them. Use exact displayed
names, or the displayed id where names collide — never a numbered position from
an earlier live listing. Claude's Google Calendar connector is the only route
there is, so if it is not connected or a read fails, say so rather than reaching
for an alternative or treating it as an empty fortnight.

In a model-enabled overview, each appointment in the fixed next-14-day window
is a source in the same model relevance pass as the Aula posts. Missing model
verdicts are a reported degraded run, not silent defaults. The overview
deliberately does not compute clashes and must never reassure the user that
nothing clashed.

## The daily brief

`bun src/cli.ts new` generates the "Aula AI oversigt" — a self-contained HTML
page in `~/.aula/brief/` — and opens it (`--no-open` to skip). It calls
`claude` itself for extraction; a deterministic local renderer builds the
layout. `--no-llm` produces a rules-only page. `bun src/cli.ts open` shows the
newest page without regenerating, and
`open --web` opens the hosted copy where one is configured — `bun src/cli.ts
publish` sets that up (it publishes the newest page and saves the URL in
`~/.aula/config.json`; `publish --off` stops it). A
weekday-morning schedule is installed with `bun src/cli.ts schedule` (06:30 by
default, `--at HH:MM` to change, `--remove` to stop; launchd on macOS, Task
Scheduler on Windows; it retries through the morning if the Mac was asleep).
Offer both — don't install or publish unasked.

## Session handling

Auth is a real MitID login; tokens live encrypted in `~/.aula/tokens.json` and
refresh themselves, so most of the time there is nothing to do.

**Exit code 2 means the credentials died.** The error text says which kind and
how to fix it — relay that rather than guessing. Do not retry the command, and
never attempt to log in yourself: MitID needs the user's phone. Tell them to
run `bun run login` in the aula-cli directory and approve in the MitID app.

`bun src/cli.ts status` reports whether they are logged in and for how long.
Other exit codes: `3` = API error (the message says what went wrong), `1` = bug.

## Notes and limits

- **Sensitive threads** (`sensitive: true`) require a stepped-up session, which
  may expire before the login does. `whoami` reports `isSteppedUp`. When it is
  `false`, threads may be masked or missing; say so and suggest
  `bun src/cli.ts refresh-stepup` before treating a quiet result as complete.
- Message bodies in `messages` (without `--full`) are truncated by Aula itself.
  Use `--full` or `thread <id>` before quoting or summarising in detail.
- The data is personal and about children — keep it in the conversation. Never
  send it anywhere or publish it. If something containing real family data has
  to be written to disk inside the repo (fixtures, notes, debug dumps), it goes
  in the gitignored `data/` folder — see `data/README.md`.
