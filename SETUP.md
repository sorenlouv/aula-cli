# Setting up aula-cli

You are setting this up for someone who is not a developer. When you are done
they have a daily overview of their children's school and daycare — a page on
this machine, and, if they want it, a claude.ai address they can bookmark that
refreshes itself every morning and every evening, so they never have to open
Claude Code again to read it.

Work steps 0–11 in order. Four of them are features the user chooses in step 2
— skip the ones they did not pick, and never turn on one nobody asked for. In a
normal run the user is needed twice: the question in step 2, and the login page
in step 3, where they type their MitID username and approve on their phone.
Everything else, run without asking. When something fails, follow its section —
a failure can add a stop, such as a login the user has to run themselves.

Say in one sentence what you are about to do before each step, and report the
outcome after it. **Speak Danish to them throughout** — every word the parent
reads is Danish, whatever language they opened with and whatever language this
document is in, and the Danish for the moments that matter is written out where
it is needed. Speak plainly — the reader is a parent, not an engineer. Do not
delegate any of this to subagents; it is a linear install.

This document is the whole of the setup. `AGENTS.md` is for people changing
the code and has nothing you need here; the "From source" section at the end
is likewise not part of a normal install.

Most commands answer in seconds. Two take minutes — the login (step 3) and
the first overview (step 7) — and each says so where it is used.

## 0. The one prerequisite

aula-cli itself is a single downloaded program — no git, no runtime, nothing to
build. It does need the command-line Claude, which it runs to write the
overview:

```bash
claude --version
```

If that prints a version, go to step 1. Otherwise install it:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

On Windows PowerShell that is `irm https://claude.ai/install.ps1 | iex`. Then
**check the version again as a separate command** — the installer edits the
shell profile, and only a new shell sees it.

Three things go wrong here, all of them silently:

- **The Claude desktop app is not this.** The user may be talking to you
  through the desktop app right now and still have no `claude` command — it is
  a separate install.
- It lands in `~/.local/bin`, which macOS leaves off `PATH`. If
  `claude --version` still fails after installing, add it:
  `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`, then check again
  in a new command.
- **Claude Code needs a paid plan** — Pro, Max, Team or Enterprise. The free
  claude.ai plan does not include it. If the user is on the free plan, stop
  here and tell them: steps 6–9 cannot work, and the rest is not worth doing
  on its own.

`claude` also has to be logged in. If it is not, step 7 is where you find out;
see Debugging.

## 1. Install aula

Pick the file for this machine — `uname -sm` says which:

| `uname -sm`          | file                   |
| -------------------- | ---------------------- |
| `Darwin arm64`       | `aula-darwin-arm64`    |
| `Darwin x86_64`      | `aula-darwin-x64`      |
| `Linux x86_64`       | `aula-linux-x64`       |
| Windows              | `aula-windows-x64.exe` |

Download beside the destination and rename into place, rather than writing
`aula` directly. macOS ties a binary's code signature to the file it validated,
so overwriting one in place — which is what re-running this to update does —
can leave a signed binary the kernel then refuses to start. The rename is
atomic and gives each install a fresh file.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/sorenlouv/aula-cli/releases/latest/download/aula-darwin-arm64 -o ~/.local/bin/aula.new
chmod +x ~/.local/bin/aula.new
mv ~/.local/bin/aula.new ~/.local/bin/aula
```

Then confirm it runs, in a separate command:

```bash
~/.local/bin/aula version
```

`~/.local/bin` is not on `PATH` on a fresh Mac. Put it there so the rest of
this document — and the user, later — can just say `aula`:

```bash
command -v aula || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

That takes effect in the next command, not this one. Until it does, use the
full `~/.local/bin/aula`.

## 2. Ask which features they want

Everything up to here was unavoidable. What follows is a choice, and it is the
only one in the setup: ask it once, now, before anything long-running, and then
run the rest without stopping again except for the login.

Ask it as a **single question with checkboxes** if your interface has a
multiple-choice control, so the user ticks what they want in one pass;
otherwise print the list and let them answer in prose.

**Ask in Danish, in the words below.** They are already written — do not
translate them into the language this document happens to be in, and do not
compose your own. This applies to every quoted block from here to the end: what
the parent reads is Danish, and the instructions around it are for you. Each
bold line is one option's label and the sentence under it is that option's
description; a control that takes both should be given both.

> **Hvilke funktioner vil du gerne have med?**
> Vælg lige den kombination, du vil — ingen af dem er nødvendige, og de kan
> alle slås til senere.
>
> **Privat link til din telefon** *(anbefalet)*
> Overblikket lægges på claude.ai på en privat adresse, som kun du kan se, og
> opdateres samme sted hver gang — så du kan gemme det som bogmærke og læse det
> på telefonen uden at åbne Claude Code.
>
> **Opdatering morgen og aften** *(anbefalet)*
> Et nyt overblik dannes automatisk kl. 06 og kl. 18 hver dag, også i weekenden.
> Er computeren slukket eller i dvale, bliver det dannet kort efter, du åbner
> den igen.
>
> **Jeres egen kalender**
> Aftaler fra Google Kalender vises sammen med skolens og børnehavens i
> overblikket. Kræver, at Google Kalender er forbundet i Claudes indstillinger.
>
> **Fortæl hvad der er vigtigt for jer**
> Bestemte afsendere eller emner bliver altid fremhævet, andre nedtonet. Jeg
> spørger, hvad der betyder noget for jer, og skriver det ned med jeres egne
> ord.

The first two carry *(anbefalet)* in the label — a checkbox control cannot
usually be handed to the user pre-ticked, and that word is what does the work
instead. They are recommended because they are what the tool is for: without
them the overview is a page on one machine that somebody has to remember to
regenerate. The other two ask something of the user — a connector, or a
sentence about their family — so they are offered, not assumed.

How to read the answer:

- "Alle" or "bare sæt det hele op" is all four.
- No answer, or an answer that only says "kom i gang", is the two recommended
  ones and nothing else. Never the calendar by default: it reads personal data
  nobody asked you to read.
- An explicit no to everything is an answer too. Honour it — the overview still
  works as a page on this machine, and step 11 tells them how to add the rest.

Write down what they picked. Steps 6, 8, 9 and 10 each run only if their
feature was chosen, and each says so in its heading. Do not raise them again as
you reach them; they were asked once, here.

## 3. Log in with MitID

The whole login happens on one page in the user's own browser. This is the
expected stop, and your only job is to hand over the link and wait.

1. Run in the background, with a 10-minute timeout: `aula login`
2. It prints a `http://127.0.0.1:…` link and opens it. Give the user the link
   as well, and tell them to leave the page open until it says they are logged
   in. The page asks for their MitID username, then shows the challenge they
   approve in the MitID app on their phone. Hand it over like this:

   > Åbn siden her og log ind med MitID: **[linket]**. Lad siden stå åben, til
   > den siger, at du er logget ind. Den spørger først om dit MitID-brugernavn
   > og viser derefter det, du skal godkende i MitID-appen på din telefon.
3. Watch for `Login successful`, or for a failure with its reason.

**Do not ask for the MitID username in the chat.** The page asks for it, and
nothing is sent to MitID until it arrives. That order is the whole point: a
login started before the user has found the link sits and ages while they go
looking for it, and an aged login is what causes the parallel-session error
below.

**Never ask for their MitID password, and never type one.** This login never
uses one — approving is a tap in the MitID app.

If the user has more than one MitID identity — common when they also have one
for work — the page asks which to use. Nothing is needed from you.

The login refreshes itself from then on.

Two failures need a person:

- **`Could not start the local login page`.** Both the username and the
  approval are collected there, so there is nothing to fall back to: this
  machine has to be able to open a page on itself. Ask the user to run
  `aula login` in their own terminal on this machine, and continue once they
  say it succeeded.
- **The identity question was never answered.** If the page asks which MitID
  identity to use and nobody picks one within two minutes, the command gives
  up — by then MitID's own session is expiring, and an answer arriving after it
  dies is worse than none. Nothing is broken and nothing was left behind; run
  `aula login` again when the user is ready to sit with it.

There is no such limit on the username: the page will wait for it as long as
the user needs, because nothing has been started on MitID's side yet. The
10-minute timeout on the command is the only clock running.

A **parallel session** error (CAP008) means an earlier attempt is still live on
MitID's side: reject any pending approval in the app, close aula.dk tabs, wait
a minute, then retry. The CLI explains this when it happens.

A failed login exits 2. Read what it says and fix that — do not simply retry,
because each abandoned attempt leaves another pending approval and makes
CAP008 more likely.

Verify with `aula status --text`.

## 4. Health check

```bash
aula doctor --text
```

Every endpoint gets called for real. Lines are `PASS`, `WARN`, `SKIP` or
`FAIL`. `SKIP` is normal — it means a school does not expose that widget.
`WARN` means the call worked but returned something ambiguous, usually an
empty feed — the line itself says which. The command exits 0 even with
warnings, and 1 only on a `FAIL`.

Act on `WARN` and `FAIL` lines: run the command if the line gives you one,
otherwise tell the user what it said before moving on.

## 5. Install the skill

This is what lets the user ask about Aula in plain language later. Re-running
overwrites it; the user needs a new session before it loads.

```bash
aula install-skill
```

For Codex instead of Claude, `aula install-skill codex`.

## 6. Their own calendar — only if they picked it

Skip this whole section if they did not. Nothing is read until a calendar is
named here: an installation where nobody named one reads nobody's calendar.

Personal appointments then appear among the Aula cards in the overview, ordered
by day, each with its own summary and a reason it is there. It is set up before
the first overview so that the first one they see already has them in it.

```bash
aula calendars                         # every calendar, with the ones being read marked
aula calendars set "Familie" "Privat"  # read exactly these two, and no others
aula calendars set none                # read none of them
```

Show the list and let the user pick — the calendar names are theirs, so show
them as they are and ask in Danish:

> Hvilke af dine kalendere skal med i overblikket?

Set exactly the calendars they name, and only when they name one — this writes
to `~/.aula/config.json`. Pass the exact displayed names (or the id shown when
two calendars share a name), never a list position, which may point at
something else on a later read. `set` states the whole answer: it reads what
you name and stops reading everything else, so pass every calendar that should
be read, not only a new one.

It reports how many appointments each newly added calendar holds in the
window the overview reads. Pass that back to the user, and say so if one comes
back empty when they expected otherwise.

**If it says Google Calendar is not connected**, it prints the few clicks —
Claude → Settings → Connectors → Google Calendar → Connect. Hand those to the
user and wait: there is no API key or calendar-link alternative. If they would
rather not do it now, move on. `aula calendars` works at any time, nothing else
in the setup depends on it, and step 11 reminds them.

## 7. The first overview

```bash
aula new
```

**Give this a 10-minute timeout.** It reads 60 days of posts and messages and
calls `claude` to write the overview, then opens the page. This is the step
that fails if `claude` is missing or logged out — see Debugging.

## 8. Put it online — only if they picked it

```bash
aula publish
```

This publishes the overview as an artifact on claude.ai and prints the URL on
the last line of output. **Keep that URL — step 11 needs it.**

The page is private to the user's own claude.ai account. Every later run,
including every scheduled one, redeploys to that same address, so a bookmark
never goes stale.

If they did not pick it, run nothing here. The overview stays a page on this
machine, `aula open` reopens it, and `aula publish` puts it online the day they
change their mind.

## 9. Have it run morning and evening — only if they picked it

```bash
aula schedule
```

Every day at 06:00 and 18:00, weekends included; `--at HH:MM,HH:MM` to change
the times, `--remove` to stop. On macOS this installs a launchd agent, on
Windows a Scheduled Task; on Linux it prints cron lines to install by hand.

**The machine does not have to be on.** A laptop asleep at 06:00 is the normal
case, not the exception. macOS starts a missed slot the next time the machine
wakes, and a machine that was switched off runs one when it is logged back in;
in both cases the job then waits for a real wake rather than burning its trigger
on a Power Nap, and retries through the slot. The user never has to remember to
leave it running.

On macOS the agent runs with a fixed `PATH` — launchd hands it no copy of
your shell's — so the schedule bakes in where `claude` lives, and whichever of
`AULA_BRIEF_MODEL`, `AULA_BRIEF_EFFORT`, `AULA_TOOL_MODEL`, `AULA_TOOL_EFFORT`,
`AULA_BRIEF_REPAIR_MODEL`, `AULA_BRIEF_REPAIR_EFFORT` and `AULA_CACHE_TTL` are
set when it runs. Re-run it if any of those change. The Windows task inherits
your user `PATH` and environment instead, and the printed cron lines carry a
`PATH` of their own — on both, set the `AULA_*` values where the job will see
them.

Without the hosted copy from step 8 a scheduled run still rebuilds the local
page, so `aula open` is current without anyone having to ask for it.

If they did not pick this, run nothing here, and say plainly what that means:
the overview is current as of now and stays that way until somebody runs
`aula new`.

## 10. What matters to them — only if they picked it

The overview can be told what to always highlight and what to leave out. Ask
them, in Danish:

> Hvad er vigtigt for jer i Aula? Det kan være en afsender, I aldrig vil gå
> glip af, et af børnene, et bestemt emne — eller noget, I er trætte af at se.

Then write each answer down as a sentence in their own words:

```bash
aula remember "vis altid beskeder fra Johns far"
```

One sentence per `remember`; `aula preferences` lists them and `aula forget <n>`
drops one. This is prose, not a syntax — record what they said, not a rule you
inferred from it.

It applies to the next overview. If they want to see the difference straight
away, run `aula new` once more: most of the reading is still cached, so it is
mainly the model call.

## 11. Hand over

Lead with where the overview is.

**If it is online (step 8),** lead with the address:

> Dit overblik ligger på **[adressen fra trin 8]**. Gem det som bogmærke — også
> på telefonen. Det opdaterer sig selv hver morgen kl. 06 og hver aften kl. 18,
> også i weekenden, så det altid er nyt, og du behøver aldrig åbne Claude Code
> for at læse det. Er computeren slukket eller i dvale på det tidspunkt, bliver
> det dannet kort efter, du åbner den igen. Du skal være logget ind på claude.ai
> for at se det; det er privat og kun synligt for dig.

Drop the two sentences about the times if they left the schedule off, and say
instead: *Et nyt overblik er ét `aula new` væk.*

**If it is not,** the overview is a page on this machine:

> Dit overblik ligger på denne computer. `aula open` åbner det nyeste, og
> `aula new` danner et nyt. [Hvis de slog opdateringen til: Det dannes
> automatisk hver morgen kl. 06 og hver aften kl. 18, også i weekenden, så det,
> `aula open` viser dig, altid er nyt.]

Then, either way, mention that they can ask about Aula in plain language in a
new session — and name what they left off in step 2, with the one command that
turns it on, so that "not now" is not a dead end. The left column is what you
say to them; the right is what you type:

| Left off — say this                | Turn it on later    |
| ---------------------------------- | ------------------- |
| Privat link til din telefon        | `aula publish`      |
| Opdatering morgen og aften         | `aula schedule`     |
| Jeres egen kalender                | `aula calendars`    |
| Fortæl hvad der er vigtigt for jer | `aula remember "…"` |

## Debugging

- **`Executable not found in $PATH: "claude"`** — the command-line Claude is
  missing (step 0). Install it, then re-run `schedule` so the new path is
  baked in.
- **Exit code 2 from a read command** — the login expired. Log in again
  (step 3).
- **Exit code 2 from `login` itself** — that attempt failed. Read the message
  and fix its cause; retrying blindly risks CAP008.
- **`Could not start the local login page`** — `login` has no other surface:
  the username is typed there and the approval is shown there. The user has to
  run `aula login` themselves on that machine (step 3).
- **The login gave up waiting** — nobody answered the page in time. Nothing
  reached MitID, so there is no session left over: run `aula login` again once
  the user is ready.
- **Sensitive threads missing** — `aula refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's vendor failed; it is
  not an empty week. The warning names the vendor.
- **Scheduled overview misbehaves** — read `~/.aula/brief/launchd.log`.
  `timed out`: the Mac slept mid-run, and the retries redo the slot.
  `Not logged in`: `claude` has no credentials outside a terminal — run
  `claude` once, log in, and try again. `command not found`: something is off
  launchd's bare PATH — re-run `aula schedule`.
- **An overview was slow or incomplete** — inspect the owner-only lifecycle
  log: `tail -n 20 ~/.aula/logs/brief.jsonl | jq '{at,event,details}'`.
  It records phase times and model attempts, never the prompt or the source
  text.
- **The online copy is stale** — the `Artifact blev ikke opdateret:` line in
  `~/.aula/brief/launchd.log` says why; `aula publish` redeploys immediately.
  (`brief.jsonl` records only whether the deploy succeeded, not why it did not.)
- **`aula: command not found` after installing** — `~/.local/bin` is not on
  `PATH` in this shell yet (step 1). Use the full `~/.local/bin/aula`, or open
  a new terminal.
- **`Killed: 9`, or a crash report naming "Code Signature Invalid"** — the
  binary's signature does not match its bytes, and macOS refuses to start it.
  Releases up to and including v0.3.1 shipped that way. Re-run step 1 to fetch
  a later release; `codesign --verify --strict ~/.local/bin/aula` should print
  nothing. Do not paper over it with `codesign --force --sign -` — that works,
  but it means the download is not what it should be, which is worth knowing.

## Updating

Re-run the commands from step 1. Use all four of them — the download-then-`mv`
is what keeps an update from overwriting a running binary in place, which macOS
can refuse to start afterwards. Nothing else changes: the login, preferences and
hosted URL all live in `~/.aula`.

## Uninstall

```bash
aula publish --off
aula schedule --remove
rm -rf ~/.claude/skills/aula ~/.agents/skills/aula ~/.local/bin/aula ~/.aula
```

That is everything: the binary, the skill, and `~/.aula`, which holds all the
tool ever stored.

## From source

Only for working on aula-cli itself — an end user never needs this. Requires
git and Bun ≥ 1.3:

```bash
git clone https://github.com/sorenlouv/aula-cli.git && cd aula-cli
bun install
bun src/cli.ts --help
```

Every `aula X` above is `bun src/cli.ts X` from that folder, and
`bun run build` compiles the release binaries into `dist/`. Contributors
should read `AGENTS.md`; nobody setting the tool up needs to.
