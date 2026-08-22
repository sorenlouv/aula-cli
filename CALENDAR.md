# `aula calendars` — the family's own appointments, beside the school's

The overview answers *what does school want from us*. It has never known that
the dentist is at 13.30 on Thursday, so a parent still had to hold both the
school's week and their own in their head at once.

This closes that: the family's own appointments appear on the page among the
week's other dated items, beside the school's own events for the same day.

## What it does, and what it deliberately does not

It **shows**. It does not judge.

An earlier version of this computed collisions — an appointment against each
child's registered komme/gå hours, and against Aula's own calendar — and
promoted a clash into *Kræver handling*. That is gone, and the reasoning is
worth keeping so nobody rebuilds it:

- **It could not fire.** `presence.getPresenceTemplates` returned 33 rows for
  the family this was written for: **none with a date, one with a time**. There
  are no registered hours to collide with. And Aula's own calendar was empty in
  **7 of 13** generated briefs — the module already has a `HealthNote` saying
  so. Both inputs are usually absent.
- **It could only misfire.** A clash became an `action`, *Kræver handling* is
  capped at five, and overflow drops to *Kommende*. So the one thing a false
  clash could reliably do was push a real school deadline off the page.
- **The reader does it better.** Thursday's forældremøde and Thursday's dentist,
  one above the other on a date-ordered page, is the whole of the analysis — and
  the reader knows what the arithmetic never could: how far the dentist is, and
  whether a grandparent can fetch.

The page also never says *ingen sammenstød i denne uge*. A reassurance is a
claim; it would be made every quiet week, and it would train the reader to skim
exactly the section that matters on the week it is wrong.

## Why the connector is the only way in

Four routes were considered. **Claude's Google Calendar connector is the only
one supported**, and that is a decision about scope as much as about quality:
one way in is one thing to keep working, and every alternative costs a setup
step this feature exists to avoid.

| | Setup asked of the user | Works on | Verdict |
| --- | --- | --- | --- |
| **A. The Claude connector** | **Nothing — it is already connected** | Wherever `claude` is logged in | **The one supported route** |
| B. Calendar feed (ICS URL) | Copy a secret link out of calendar settings | Anything that publishes a feed | Rejected |
| C. Google Calendar API (OAuth) | A Google Cloud project, or a verified app | Google only | Rejected |
| D. The Mac's own Calendar (EventKit) | Nothing, if it is already in Calendar.app | macOS only | Rejected |

### A. The connector, measured

Three things checked rather than assumed (2026-08-22, `claude` 2.1.238):

- **It is reachable from a non-interactive `claude -p`**, including from a
  faithful reproduction of the launchd agent's environment. 8.5 s.
- **`claude` needs `$USER` to find its own credentials.** Bisected: with `HOME`
  and `PATH` alone it fails *Not logged in · Please run /login*; adding `USER`
  — and only `USER` — fixes it. The keychain item is `Claude Code-credentials`.
  launchd supplies `USER` itself, so the 06:30 job is fine; the trap is in
  *testing* this path, where `env -i` produces a failure indistinguishable from
  an expired login.
- **The raw tool result is readable off the wire.** With
  `--output-format stream-json --verbose`, both the `tool_use` block (the
  arguments the model chose) and the `tool_result` block (the connector's own
  JSON) are in the stream.

That last point is what makes this acceptable at all. **The model is not asked
what the calendar says; it is asked to place one call, and the connector's JSON
is read directly.** Its prose is discarded unread. So `connector.ts` is a
transport that happens to need a model to authenticate it, not a model
reporting on a calendar — and the difference is why calendar data is allowed
near a page whose worst failure is a quiet omission.

What is checked, because each is a way this could lie:

| Risk | Detection |
| --- | --- |
| Called with the wrong calendar or window | `tool_use.input` compared to what was asked |
| Never called at all | No `tool_use` block → error, not an empty week |
| Paginated, events silently missing | `nextPageToken` present → refuse |
| Connector disconnected or consent lapsed | `is_error`, or no result → `HealthNote` |
| `stream-json` changes in a `claude` update | Parse failure → `HealthNote` |

The last is a real coupling to a Claude Code implementation detail — the same
bet `deploy.ts` already makes on the Artifact tool, knowingly taken.

Two details that cost time:

- Server names are flattened into tool names: `claude.ai Google Calendar` →
  `mcp__claude_ai_Google_Calendar__list_events`. MCP tools are **deferred** in
  headless runs, so `ToolSearch` must be allowed alongside, or the call never
  happens.
- `deploy.ts` passes `--strict-mcp-config`; this must **not**. That flag drops
  the configured MCP servers, which here is the thing being called.

**Recurring series come back already expanded** into instances, each carrying
`recurringEventId` and `originalStartTime`, with no `recurrence` rule. So no
`RRULE`, no `EXDATE`, no DST arithmetic of our own — the single largest
implementation cost avoided.

**One trap.** An all-day event arrives as `start: { date: "2026-08-28T00:00:00Z" }`
— the key is `date`, not `dateTime`, and the `Z` is decoration on a date, not
an instant. Read it as UTC and it lands a day early anywhere behind UTC, the
same class of bug `localIsoDate` exists to prevent. Branch on which key is
present, never on the string. Copenhagen is ahead of UTC and would never catch
it, so the test that pins this flips to `America/New_York`. (`bun test` runs in
UTC; the calendar tests set `TZ=Europe/Copenhagen` explicitly, because a module
about Danish wall-clock time tested in UTC tests a program nobody runs.)

### C. Why the API loses

`calendar.readonly` is a **sensitive** scope, and every route through it is
blocked by something:

- **Unverified, publishing status *Testing*** — refresh tokens expire after
  **7 days**, cap of 100 test users. A credential that dies weekly is fatal for
  an unattended 06:30 job. This alone ends it.
- **Unverified, *Production*** — no 7-day expiry, but every user meets the
  *Google hasn't verified this app* screen, capped at 100 users total.
- **Verified** — homepage, privacy policy, scope justification, demo video,
  3–5 business days, re-review on change. It also makes the author the
  developer of record for other families' calendar data, and puts a client
  secret in a public repository.
- **Each user makes their own Cloud project** — a twenty-step console journey,
  the precise opposite of the brief this feature was given.

What the API buys over the connector: push notifications, sync tokens, attendee
state. For a page generated once a morning, none of it.

### B. Why not a calendar feed

A feed URL looks like the portable answer — one copy-paste, no Claude, and it
would cover iCloud, Outlook and every sports club in the country. Google even
serves it uncached (`cache-control: no-cache, no-store, must-revalidate` —
measured), so the 8–24-hour staleness ICS is known for is the *other*
direction: Google throttling how often it re-reads somebody else's feed.

It still loses, on the case that prompted this feature:

- **A calendar shared *with* you has no secret address at all.** Google offers
  *Secret address in iCal format* only for calendars you own. For a partner's
  calendar shared across a household, the URL has to come from *their* account
  — a second non-technical person, a second copy-paste, and a long-lived secret
  travelling by chat.
- **A Workspace admin can switch the option off entirely**, and many have.
- **Recurrence becomes ours.** `RRULE`, `EXDATE`, `RECURRENCE-ID`, `VTIMEZONE`
  and the DST arithmetic behind them — a day of work and a permanent source of
  off-by-one-hour bugs that the connector simply does not have, because it
  hands back resolved occurrences.

So it would be a second code path, a second set of failure modes and a second
support story, in exchange for reaching fewer of the calendars people actually
want. Not built, and not planned.

### D. Why not the Mac's own calendar

EventKit would need no setup at all where the calendar is already in
Calendar.app. But it is macOS-only while this tool promises macOS *or* Linux,
it needs a compiled Swift helper in a repository with no build step, and its
permission prompt attaches to the responsible process — so a launchd job at
06:30 has nobody to answer it.

## Architecture

```
src/calendar/connector.ts  claude -p → stream-json → raw tool_result
src/calendar/index.ts      the dispatcher, and connector JSON → PersonalEvent[]
src/calendar/types.ts      PersonalEvent, CalendarRef
```

A sibling of `src/integrations/`, for the same reason: a normalising boundary
over an external source that may be slow, wrong or absent without taking the
brief down. A calendar that cannot be read produces a `HealthNote` and an empty
list, never an exception — a failed fetch must never look like a free
fortnight.

Downstream, an appointment is an ordinary `SourceItem` with `kind: 'personal'`
and `audience: 'family'`, so it travels the road everything else does — ranked,
composed, `NY`-marked, tickable — instead of needing a section and rules of its
own. `signalsFromRules` gives it exactly one signal, always `kind: 'event'`:
`ACTIONABLE` excludes `event`, so nothing from a private calendar can reach
*Kræver handling* and contend for its cap of five.

`PersonalEvent.key` is `cal:<calendarId>:<series>:<occurrence-start>` — identity,
not state. `originalStartTime` is the occurrence's *scheduled* slot, so a moved
appointment keeps the key it had yesterday rather than arriving as a
cancellation plus a new thing.

Which child an appointment concerns is **not** inferred. Matching first names in
a title would be a regex over prose the family wrote — the mistake `rank.ts`
already made once, when matching sender names floored a teacher called Hjalte on
a wish about Hjalte's father.

### One landmine cleared first

`~/.aula/config.json` now holds two unrelated things written by two unrelated
commands. `deploy.ts` used to write it whole from the one field it knew about,
so adding `calendars` beside `artifactUrl` would have made `aula publish`
silently delete the family's calendars. `readConfig` now preserves keys it does
not understand and `updateConfig` merges; the test is named for the bug.

## Setup

```
aula calendars                   # every calendar, with the read ones marked
aula calendars set <n> [<n> ...]     # read exactly these, and no others
aula calendars set none              # read none of them
```

Where the connector is available there is no setup at all — the list is names,
never ids, and the user picks numbers off it.

**One list, and one declarative command.** The calendars being read and the ones
merely available were briefly separate listings behind separate commands, each
numbered from 1, so "2" meant a different calendar depending on which you had
last looked at. They are one list now, marked, and the selected ones come first.

`set` replaced `add` and `remove` because the caller is usually an agent, and
add-and-remove makes it compute a diff: read the list, compare against what is
already selected, work out which way each one has to move, then issue two
commands whose numbering shifts between them. That diff is work, it depends on
state that may already be stale, and it is where the mistakes were going to come
from. Stating the end state has none of it — idempotent, one command for any
target state, nothing to compare against.

`set` rather than `select` or `update`: assignment is the prior a reader already
has for the word, and assignment is the semantics. `update` was rejected for
reading as *refresh these calendars* — a real and different operation, and one
an agent could call expecting a sync while rewriting the configuration instead.

The cost is that it is destructive by omission, so the answer names what it
started *and* stopped reading; a calendar disappearing quietly is exactly the
failure this shape invites. And because the marked calendars are always 1..k of
the one list, narrowing a selection resolves from the configuration alone and
needs no connector — dropping a calendar still works on a morning it does not
answer, which is when you are most likely to want to.

Adding then proves itself, per calendar, because one silent empty calendar is
exactly what a single combined total would hide:

```
Now reading "Privat" and "Familien".
  Privat: 4 appointment(s) in the next 14 days
  Familien: 17 appointment(s) in the next 14 days
  · 2026-08-25  Fødselsdag hos naboen
  · 2026-08-26 10:00  Tandlæge
```

Only the newly set calendars are read back: re-reading one that already answers
every morning proves nothing and costs a round trip.

"Calendar added" would prove nothing. The count proves the whole chain —
connector, credentials, window, parsing — while the user is still paying
attention.

Where it is not available, the command says so and gives the few clicks that
connect it — which is also what `aula calendars` says to anybody who skipped
the question during setup and came back to it later.

Nothing is read until a calendar is named here.

## Where the appointments go

On the page, with their names on, like everything else. A design for a `--busy`
mode — times without titles — was dropped: this page already carries what the
school wrote about somebody's children, which for some families includes health
information. A calendar entry saying *tandlæge* is not a new category of secret,
and a redaction setting for it would have implied the rest of the page was safe.
One sensitivity level, applied consistently, and one less question between a
family and a working overview.

`llm.ts` still documents its stdin as *"Danish prose written by school staff"*.
A calendar carries events created by other people — anyone who has invited this
family to something — so that comment now claims a narrower source than it has.
The existing defence (preferences in the instructions, untrusted data on stdin)
covers the risk; the comment is what needs correcting.

## Open items

- **Whether the connector's consent lapses**, how it announces that in a
  headless run, and whether re-consent can be done anywhere but interactively.
  A calendar that silently stops answering at 06:30 is the worst outcome this
  feature has, so its `HealthNote` wants testing, not just writing.
- **`list_calendars` does not return `accessRole`** — it comes back from
  `list_events`, one calendar at a time. So the pick list cannot say which
  calendars are the user's own. `relation()` in `cli.ts` is written for the day
  it appears and prints nothing until then.
- **Non-Google calendars are not reachable**, and by this design will not be
  until the connector reaches them. A family on iCloud alone gets the rest of
  the overview and no appointments, which the *Datastatus* footer states
  plainly rather than leaving as a silent gap.
