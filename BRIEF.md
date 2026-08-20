# `aula new` — a daily overview that replaces checking Aula

> **Status: built and running.** `bun src/cli.ts new` produces an HTML page in
> `~/.aula/brief/`, and a launchd agent runs it weekdays at 06:30
> (`scripts/install-brief-schedule.sh`). What follows is the design and the
> reasoning behind it; the phase table at the end records what each stage cost.
>
> **HTML only.** PDF and PNG were dropped: they exist behind `--pdf` and `--png`
> for a one-off, and the scheduled run passes neither. The forwarding argument in
> [Delivery](#delivery-and-portability) is kept below as the reasoning that led
> there, but it no longer describes what runs.
>
> **The hosted copy is opt-in and off unless configured.** Where a URL is
> configured, the same run redeploys the page to it — see
> [The hosted copy](#the-hosted-copy).

Plan for a generated, self-contained HTML page covering Alma, Viggo and
Ida: what needs acting on, what is coming, and what merely happened.

The goal is not "Aula, but nicer". It is that not opening Aula stops costing
anything.

## What the data actually says

Measured against the live API on 2026-08-13, not assumed (names and
institutions fictionalised):

| Signal | Value |
| --- | --- |
| Posts in the last 14 days | 9 |
| Posts flagged `important` | **0** |
| Threads | 3 |
| Threads flagged `unread` / `sensitive` | **0 / 0** |
| Calendar events in the next 50 days | **0** |
| Events with `responseRequired` | **0** |
| Notifications | 159 — of which ~96% are `NewMedia` (photo uploads) |

So the entire `attention` block that `digest` computes is empty today. A UI
driven by Aula's own priority fields would render "nothing to see" — and it
would be wrong, because the same payload contains:

- **`Møde ang. Alma d. 18/9`** — a meeting, as a *message subject*. Not in
  the calendar. `important=false`, `unread=false`.
- **`Husk skiftetøj og badeting`** — same-day gear for Alma's first PE
  lesson, inside a weekly-plan item.
- **`Myretuens løbedag`** — a new recurring Monday commitment for Viggo,
  announced once, in prose, in a post that names no child.
- **`vi håber på endnu flere frivillige [til arbejdsdagen]`** — a soft ask,
  buried in the fourth paragraph of a daily narrative post, with no deadline
  attached.

**Every obligation in this dataset lives in free-text Danish. None of it is in a
structured field.** That single fact decides the architecture: the ranking layer
has to read prose, so a model is load-bearing rather than decorative.

Two smaller findings that shape the design:

- The weekly-plan vendor **returned HTTP 500 for Viggo and Ida** while
  succeeding for Alma. Partial failure is the normal case, not the edge case.
- `regarding[]` on threads maps cleanly to a child; posts map only to a group
  (`Børnehuset Eksemplet`). Per-child attribution is reliable for messages and
  weak for posts.

## Dynamic or static — the answer

**The model designs the page.** A week with one dominant thing should not look
like a week with twelve small ones, and a fixed renderer can only vary along
axes chosen in advance. Tailoring the layout to the content is the point.

The seam is not *renderer vs model*. It is **two model calls, and only the first
one may touch the source data**:

1. **Extract** reads the Aula payload and emits validated `Signal[]` — facts,
   with quotes checked against the source text.
2. **Compose** receives *only those validated signals* and writes the page.

Because compose never sees the raw payload, it cannot invent a deadline or
misquote a teacher: it can only arrange facts that already survived validation.
Layout freedom therefore costs nothing in trustworthiness — which is what makes
it safe to hand over.

What used to be guaranteed by a fixed renderer is now **machine-checked after
generation** instead. That is the real change, and it is the part that must not
be skipped:

| Invariant | Check |
| --- | --- |
| Nothing required was dropped | every `must_show` signal id appears as `data-signal-id` |
| Every claim is attributable | each claim block has `data-source-id` and a link |
| Failures are visible | the datastatus block exists and names every failed fetch |
| Noise stays down | no municipality-wide signal in the action region |
| Portable | HTML parses; zero external resource references |
| Legible | colours come from the token set; contrast ratios pass |
| Print-safe | `<details>` are forced open in print, so nothing hides in the PDF |

A failed check is fed back for one retry; a second failure ships the previous
day's layout with today's content, and says so in the footer.

### Freedom within a design system

Compose is given `brief.css` — the tokens and tested components (cards, chips,
week strip, child cards, quote blocks) — and may add a `<style>` block for
one-off arrangement. It may **not** redefine colours, fonts or spacing. So it
can invent a timeline, a comparison grid across the three kids, or a single hero
card when one thing dominates, without being able to produce grey-on-white.

One constraint worth keeping: **the topline and the must-act region stay in the
same place at the top.** Everything below is free. This is a glanceable artifact
read in twenty seconds over breakfast, and knowing where the urgent thing lives
is worth more than the variety gained by moving it. It is one line to remove if
it proves too rigid.

## The page

Sections render only when they have content, but never change order.

**1 · Topline** — date, and one Danish sentence covering the state of the
family. The part that works when read in four seconds on a phone.

**2 · Kræver handling** — the only tier with deadlines. Hard cap of **five
items**; overflow drops to *Denne uge*. Each row: what to do, which child, by
when (`om 3 dage`, `i dag`, `overskredet`), and the verbatim source phrase it
came from.

**3 · Denne uge** — a seven-day strip merging calendar, weekly plans, recurring
commitments and planned drop-off/pickup times. Where *husk badetøj på torsdag*
lives.

**4 · Per barn** — one card each for Alma, Viggo and Ida: today's
check-in state and planned pickup, what is new about them, their week. Cards
ordered by how much is going on, so a quiet child stops taking up space.

**5 · Godt at vide** — collapsed. The daily narrative posts, one line each,
expandable.

**6 · Billeder** — the `NewMedia` flood turned into `12 nye billeder fra
Myretuen`, linked, at the bottom where it belongs.

**7 · Datastatus** — what was fetched, **what failed**, when it was generated,
step-up state, next scheduled run.

### The rules that make it trustworthy

These are the whole point, and each becomes a test:

- **Nothing is ever silently dropped.** Anything not promoted still appears in
  *Godt at vide*. The brief may reorder; it may not hide.
- **A missing section and a failed fetch look different.** Today's EasyIQ 500
  must read as *"ugeplan for Viggo og Ida kunne ikke hentes"*, never as a
  quiet empty week. Confusing the two is how a brief starts lying.
- **Every model-derived claim carries its source** — id, link, and the exact
  quote it was drawn from. A deadline is shown next to
  «Ansøgningsfristen er tirsdag den 1. september 2026», so it can be believed
  without opening Aula.
- **A confident empty state.** When nothing needs action, the page says so
  plainly rather than showing an empty box. That is what makes it safe to skim.
- **`NY` markers since the last brief**, so checking twice a week means reading
  only the delta.

## Architecture

```
aula new [--days 14] [--no-open] [--pdf] [--no-llm] [--explain] [--out <path>]

  collect   →  BriefInput    reuse buildDigest + galleries + notifications
  extract   →  Signal[]      deterministic rules ∪ model call #1, validated
  rank      →  RankedBrief   score → tiers → caps → must_show flags
  compose   →  HTML          model call #2, given signals + brief.css
  validate  →  HTML          invariant checks, one retry, fallback layout
  publish   →  files         HTML + PDF (+ PNG), open, update state
```

| File | Responsibility |
| --- | --- |
| `src/brief/collect.ts` | Assemble and token-trim `BriefInput` from `buildDigest` |
| `src/brief/signals.ts` | The `Signal` type and its validators |
| `src/brief/rules.ts` | Danish date/obligation extractors |
| `src/brief/llm.ts` | `claude -p` transport, retry, content-hash cache |
| `src/brief/rank.ts` | Scoring, tiering, caps, `must_show` |
| `src/brief/compose.ts` | Prompt and design brief for the page-writing call |
| `src/brief/validate.ts` | The invariant table above, run against the generated HTML |
| `src/brief/brief.css` | Tokens and components — the constraint compose designs within |
| `src/brief/publish.ts` | PDF/PNG rendering, file layout, `--open` |
| `src/brief/state.ts` | `~/.aula/brief/state.json` — seen ids, last run, last layout |

Wired into `src/cli.ts` as `case 'new'`, following the existing
`emit(value, asText, render)` convention so `--out` and `--no-cache` behave as
they do everywhere else.

### Extraction: rules first, model second

The deterministic pass is not a stopgap — it is the fallback *and* the test
oracle for the model. It handles the forms Danish school communication actually
uses: `d. 18/9`, `tirsdag den 1. september 2026`, `uge 34`, `senest fredag`, and
the trigger words `husk`, `frist`, `tilmelding`, `medbring`, `forældremøde`,
`afleveres`.

The model pass then covers what regex cannot: whether something is an
obligation for *this* family, one-line summaries, and the topline.

### The model contract

`claude -p` receives compact JSON (ids, dates, authors, child mapping, trimmed
text — today's payload is ~20 KB, so one call is cheap) plus family context and
preferences, and must return:

```jsonc
{
  "topline": "…",
  "signals": [{
    "kind": "action|deadline|event|bring|info|social",
    "title": "…",            // Danish; imperative for actions
    "child": "Alma|Viggo|Ida|all",
    "dueAt": "2026-09-01" | null,
    "urgency": "now|week|later|fyi",
    "sourceType": "post|thread|plan|event|presence",
    "sourceId": 13311009,
    "quote": "Ansøgningsfristen er tirsdag den 1. september 2026",
    "why": "…"
  }],
  "childSummaries": { "Alma": "…" }
}
```

Validation before anything is rendered:

1. `sourceId` must exist in the input — no inventing items.
2. **`quote` must be a literal substring of that source's text.** Cheap to
   check, and it is the strongest anti-fabrication guard available here.
3. `dueAt` must parse, and must not be in the past relative to its source.

Failures are fed back for exactly one retry; a second failure falls through to
rules-only output and the page is marked degraded in *Datastatus*. Extraction is
cached against a hash of the input, so a re-run on unchanged data costs nothing.

### Ranking stays deterministic

The model proposes urgency; `rank.ts` decides placement. `--explain` prints the
breakdown, which is what makes tuning possible rather than superstitious.

**Audience breadth is the primary axis, and it is computed, not judged.** How
specifically a message addresses one of these three children predicts relevance
better than its topic does, and `groups[]` gives it away for free:

| Audience | Example | Treatment |
| --- | --- | --- |
| Thread `regarding` a child | *Møde ang. Alma d. 18/9* | Highest |
| The child's own class or stue | `2E`, `Myretuen` | High |
| Weekly plan for their class | *Husk skiftetøj og badeting* | High |
| Their actual school or daycare | `Eksempelskolen …`, `Børnehuset Eksemplet` | Depends on content |
| Across institutions | `Alle forældre alle skoler` | Suppressed unless it concerns the child |

**Breadth is a prior, not a veto. The content decides.** School photo day and a
parenting course are both addressed to the whole school; one needs doing and one
does not, and no amount of looking at `groups[]` separates them. So every signal
carries `concernsChild`: does this ask something of us *about our own child*, or
is it something we may opt into? The tell is who is addressed —
*"tilmeld jeres barn"* against *"kurset er målrettet forældre til børn, der …"*.

That single field does the real work:

- School-wide **and** concerns the child → normal ranking. *Tilmeld Alma til
  skolefoto* reaches *Kræver handling*.
- School-wide **and** an offer → folded into *Godt at vide*.
- Municipality-wide **and** an offer → the muted line at the foot.
- Municipality-wide **but** concerns the child → shown. Every school being shut
  on Friday still shuts ours.

**Topic relevance is not a promotion signal.** A municipal offer whose subject
happens to match something going on with a child is still a municipal offer.
Got wrong in the first mockup, corrected.

## Testing

`bun test src/` stays credential-free. Fixtures cut from real payloads live in
the **gitignored `data/` folder**, since real threads contain sensitive
personal information that must not enter git history. A synthetic fixture with
the same *shape* gets committed for CI.

- `rules.test.ts` — every Danish date form above, plus the negative cases
- `rank.test.ts` — tier ordering, cap overflow, tie-breaking
- `llm.test.ts` — validator rejects bad `sourceId`, a non-substring quote, an
  unparseable date; the degraded path renders
- `render.test.ts` — snapshots for three states: busy, quiet, partially-failed
- `doctor` gains a brief check, since only a live call proves the pipeline

## Delivery and portability

Generated into `~/.aula/brief/`, dated, plus a `latest.html` copy so a missed day
is recoverable. A `launchd` agent runs it each weekday morning; `--open` opens
it.

**The scheduled run writes HTML and nothing else.** What follows is the argument
for also producing a PDF, which was built and then deliberately turned off; it is
kept because the reasoning still holds if forwarding ever becomes a requirement
again. `--pdf` and `--png` still work on demand.

| Output | Built by | For |
| --- | --- | --- |
| `brief-YYYY-MM-DD.html` | compose | Reading on the Mac. The full thing, and the only one the schedule produces. |
| `brief-YYYY-MM-DD.pdf` | Chrome `--headless --print-to-pdf`, `--pdf` only | Forwarding. Email attachment, Messenger file. |
| `brief-YYYY-MM-DD.png` | Chrome screenshot of the top region, `--png` only | Messenger inline preview |

Chrome is already installed, so the PDF costs no new dependency.

**Do not try to send the HTML as an email body.** Gmail and Outlook strip or
mangle exactly what this design uses — CSS grid, custom properties, and
`<details>`, which most clients do not support at all. A collapsed section in an
email client is a section that silently disappears. The PDF sidesteps every one
of those, renders identically for both parents, and is the one format Messenger
and email both accept. That is why the invariant table forces `<details>` open
in print: whatever is collapsed on screen must still be *in* the PDF.

So compose designs for two media, and the print stylesheet is part of the brief
it is given: light palette regardless of system theme, no page-break inside a
card, and every collapsible expanded.

**Sending stays manual by default.** The run produces the files and can open a
pre-filled draft; it does not send anything on its own. Forwarding to the other
parent means the content — including the thread about Alma — passes through
Gmail or Meta, which is a different exposure from the local-only default chosen
earlier. The other parent being the author of half those messages makes that
unremarkable, but it is a deliberate change rather than a silent one.

## The hosted copy

Local files answer "what do I need to know this morning" on the Mac. They do not
answer it on a phone, and a `file://` link is not something you can send. So
where a target URL is configured, the run also redeploys `artifact.html` to it,
and the shared link shows today's brief instead of the day it was first
published.

**Off unless asked for.** Nothing leaves the machine until a URL exists in
`AULA_ARTIFACT_URL` or `~/.aula/brief/artifact-url`. This is the one part of the
pipeline that contradicts the local-only default chosen at the start — the page
can carry sensitive information about a child, health details included — so it
is a deliberate act of
configuration, never something a clone of this repository inherits. `--no-deploy`
skips it for a single run.

Four things about this leg are not obvious:

**It has to go through `claude -p`.** The Artifact publisher is a Claude tool,
not an HTTP endpoint. A launchd job cannot call it directly; it can only spawn
`claude` and let it make the call. That is also why `deploy.ts` is separate from
`publish.ts`: writing files always works, while this needs the network, a model
and claude.ai credentials, and must degrade to a note rather than fail the run.

**And that tool is not offered to every session.** `claude` exposes it only to a
session announcing `CLAUDE_CODE_ENTRYPOINT=claude-desktop`. This was measured,
not assumed: strip the environment to nothing but that variable and the tool is
there; leave a session otherwise complete — logged in, every model call working
— and remove it, and the tool reports as missing. It cost a full scheduled run
to find, because the interactive test that "verified" the approach was a child
of a desktop session and had inherited the marker; the first launchd run failed
where the identical command by hand had just succeeded. `deploy.ts` therefore
sets it on that one subprocess rather than on the agent, so the extraction and
layout calls keep the environment they already had.

This is an undocumented lever and may stop working on any `claude` update. The
failure mode is loud and harmless — the deploy reports the tool as unavailable,
the note lands in the run's output, and the local brief is untouched.

**No Aula text reaches that subprocess.** The page is assembled from posts and
messages written by other people. If any of it were interpolated into the prompt
— or readable by an agent holding a publishing tool — a sentence in a school post
would be in a position to steer what gets published. So the prompt carries only a
path and a URL this project produced itself, `Artifact` is the only tool granted,
and a test asserts the prompt contains no Danish characters outside the values it
interpolated.

**It publishes with `force`, on purpose.** The publisher treats a version
conflict as something to merge, which is right when two people edit one page and
wrong here: the brief is generated whole each morning and wholly replaces the day
before, nothing else writes to the URL, and there is no edit to preserve. The
conflict is also not an exception but the steady state — every run is a *fresh*
session that has by definition never seen the version it replaces, so without
`force` the deploy would fail every single day rather than occasionally.

The reply from that subprocess is treated as a report, not as proof: the deploy
counts as successful only if the target URL comes back with no error beside it.
The exit code deliberately gets no veto, because `claude` runs plugin hooks after
the turn is over and a hook that cannot start kills the process long after the
publish has landed.

## Phasing

| Phase | Scope | Est. |
| --- | --- | --- |
| P0 | `brief` skeleton, `BriefInput`, fixtures, state file | ½ day |
| P1 | `Signal` model, Danish rules, ranking incl. audience breadth, `--explain` | 1 day |
| P2 | `claude -p` extraction, quote/source validation, cache, fallback | 1 day |
| P3 | `brief.css` design system + compose prompt — **first generated page** | 1 day |
| P4 | `validate.ts` invariants, retry, fallback layout | ½ day |
| P5 | PDF/PNG publish, print stylesheet, launchd, `NY` markers | ½ day |
| P6 | `preferences.json`, muting, tuning against real weeks | ongoing |

P3 and P4 are deliberately separate: the interesting failure is not "the page
looks odd", it is "the page looks fine and quietly omitted the meeting". The
invariants are what catch that, and they are worth their own pass.

P1 is independently useful: rules-only already catches `d. 18/9` and
`Ansøgningsfristen`, which is most of today's value.

## Risks

- **A miss is worse than the status quo.** If the brief is trusted and drops
  something, the situation is worse than not having it. Mitigated by never
  hiding items, the explicit data-status footer, and a weekly section listing
  everything that did not make the cut.
- **Model variance on Danish prose.** Mitigated by the substring check, the
  rules fallback, and `--explain`.
- **A generated layout can regress silently.** The page that looks fine and
  omitted the meeting is the dangerous one, not the ugly page. This is why the
  invariants are machine-checked rather than requested in the prompt, and why
  the composer is handed validated signals instead of raw Aula data.
- **Vendor flakiness is routine** — EasyIQ 500s today. Surfaced, never hidden.
- **Notification counts are worthless as priority** — 159 badges, ~96% photos.
  They feed the photo section and nothing else.

## Open items to verify during P3

- Aula deep-link URL patterns for a post, a thread and an album, so cards link
  back. Fallback: link the module root.
- Whether `galleries` gives a usable album thumbnail without fetching photos.
