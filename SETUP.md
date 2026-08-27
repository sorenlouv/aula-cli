# Setting up aula-cli

You are setting this up for someone who is not a developer. When you are done
they have a daily overview of their children's school and daycare at a
claude.ai address they can bookmark — it refreshes itself every weekday
morning, so they never have to open Claude Code again to read it.

Work steps 0–8 in order, then offer the optional extras. In a normal run the
user is needed three times: their MitID username (step 2), their phone
approval (step 2), and the optional extras at the end. Everything else,
run without asking. When something fails, follow its section — a failure can
add a stop, such as a login the user has to run themselves.

Say in one sentence what you are about to do before each step, and report the
outcome after it. Speak plainly — the reader is a parent, not an engineer.
Do not delegate any of this to subagents; it is a linear install.

This document is the whole of the setup. `AGENTS.md` is for people changing
the code and has nothing you need here; the "From source" section at the end
is likewise not part of a normal install.

Most commands answer in seconds. Two take minutes — the login (step 2) and
the first overview (step 5) — and each says so where it is used.

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
  here and tell them: steps 5–7 cannot work, and the rest is not worth doing
  on its own.

`claude` also has to be logged in. If it is not, step 5 is where you find out;
see Debugging.

## 1. Install aula

Pick the file for this machine — `uname -sm` says which:

| `uname -sm`          | file                   |
| -------------------- | ---------------------- |
| `Darwin arm64`       | `aula-darwin-arm64`    |
| `Darwin x86_64`      | `aula-darwin-x64`      |
| `Linux x86_64`       | `aula-linux-x64`       |
| Windows              | `aula-windows-x64.exe` |

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/sorenlouv/aula-cli/releases/latest/download/aula-darwin-arm64 -o ~/.local/bin/aula
chmod +x ~/.local/bin/aula
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

## 2. Log in with MitID

Login needs a MitID username, and there is no terminal here to ask in — so ask
in the chat. This is one of the three expected stops.

1. Ask the user for their **MitID username** — what they type into MitID, not
   their name in Aula.
2. Run in the background, with a 10-minute timeout:
   `aula login --username "<username>"`
3. It prints a `http://127.0.0.1:…` link and opens it. Give the user the link
   as well, and tell them to leave the page open: it shows the MitID challenge,
   which they approve in the MitID app on their phone.
4. Watch for `Login successful`, or for a failure with its reason.

The login refreshes itself from then on.

**Never ask for their MitID password, and never type one.** The default login
does not use one. `--method CODE_TOKEN` (kodeviser) does, which is why you must
not use it: it stops at a password prompt that no agent can answer. If the user
only has a kodeviser, hand them the command and let them run it themselves in
their own terminal.

Two failures need a person, because the login asks a question mid-flight and
there is no flag for the answer:

- **More than one MitID identity** (common if the user also has a work
  identity). The login stops at a numbered list after the phone approval.
- Anything else that ends in `stdin is empty`.

In both cases, ask the user to open a terminal, run
`aula login --username "<name>"` themselves, and answer the question it asks.
Continue once they say it succeeded.

A **parallel session** error (CAP008) means an earlier attempt is still live on
MitID's side: reject any pending approval in the app, close aula.dk tabs, wait
a minute, then retry. The CLI explains this when it happens.

A failed login exits 2. Read what it says and fix that — do not simply retry,
because each abandoned attempt leaves another pending approval and makes
CAP008 more likely.

Verify with `aula status --text`.

## 3. Health check

```bash
aula doctor --text
```

Every endpoint gets called for real. Lines are `PASS`, `WARN`, `SKIP` or
`FAIL`. `SKIP` is normal — it means a school does not expose that widget.
`WARN` means the call worked but returned something ambiguous, usually an
empty feed; those are explained in API.md. The command exits 0 even with
warnings, and 1 only on a `FAIL`.

Act on `WARN` and `FAIL` lines: run the command if the line gives you one,
otherwise tell the user what it said before moving on.

## 4. Install the skill

This is what lets the user ask about Aula in plain language later. Re-running
overwrites it; the user needs a new session before it loads.

```bash
aula install-skill
```

For Codex instead of Claude, `aula install-skill codex`.

## 5. The first overview

```bash
aula new
```

**Give this a 10-minute timeout.** It reads 60 days of posts and messages and
calls `claude` to write the overview, then opens the page. This is the step
that fails if `claude` is missing or logged out — see Debugging.

## 6. Put it online

```bash
aula publish
```

This is the whole point of the setup: it publishes the overview as an artifact
on claude.ai and prints the URL on the last line of output. **Keep that URL —
step 8 needs it.**

The page is private to the user's own claude.ai account. Every later run,
including every scheduled one, redeploys to that same address, so a bookmark
never goes stale.

## 7. Have it run every morning

```bash
aula schedule
```

Weekdays at 06:30; `--at HH:MM` to change it, `--remove` to stop. On macOS
this installs a launchd agent, on Windows a Scheduled Task; on Linux it prints
cron lines to install by hand. A laptop asleep at 06:30 is the normal case, so
the job waits for a real wake and retries through the morning — the user does
not have to leave the machine on.

The schedule bakes in the `PATH` and the `AULA_BRIEF_MODEL`,
`AULA_BRIEF_EFFORT`, `AULA_TOOL_MODEL`, `AULA_TOOL_EFFORT`,
`AULA_BRIEF_REPAIR_MODEL`, `AULA_BRIEF_REPAIR_EFFORT` and `AULA_CACHE_TTL`
values from the shell it ran in. Re-run it if any of those change — and also
after a node version change, because `claude`'s plugin hooks shell out to
node, and a moved node costs the scheduled run its exit status.

## 8. Hand over

Lead with the address. Say something like this, in the language the user has
been speaking:

> Your overview is at **[the URL from step 6]**. Bookmark it — on your phone
> too. It updates itself every weekday morning at 06:30, so it is always
> current, and you never need to open Claude Code to read it. You will need to
> be signed in to claude.ai to see it; it is private to your account.

Then mention, briefly, that they can also ask about Aula in plain language in
a new session, and that the overview can be taught what matters to them:

```bash
aula remember "vis altid beskeder fra Johns far"
```

## Optional extra

Offer this now.

**Their own calendar.** Personal appointments then appear among the Aula
cards in the overview, ordered by day, each with its own summary and a reason
it is there.

```bash
aula calendars                         # every calendar, with the ones being read marked
aula calendars set "Familie" "Privat"  # read exactly these two, and no others
aula calendars set none                # read none of them
```

Needs Google Calendar connected in Claude; there is no API key or
calendar-link alternative, and `calendars` prints the few clicks when the
connector is missing.

Show the list and let the user pick. Set exactly the calendars they name, and
only when they name one — this writes to `~/.aula/config.json`, outside the
repository. Pass the exact displayed names (or the id shown when two
calendars share a name), never a list position, which may point at something
else on a later read. `set` states the whole answer: it reads what you name
and stops reading everything else, so pass every calendar that should be read,
not only a new one.

It reports how many appointments each newly added calendar holds in the
window the overview reads. Pass that back to the user, and say so if one comes
back empty when they expected otherwise.

Nothing is read until a calendar is named here, and this can be done at any
time — it is not tied to setup.

## Debugging

- **`Executable not found in $PATH: "claude"`** — the command-line Claude is
  missing (step 0). Install it, then re-run `schedule` so the new path is
  baked in.
- **Exit code 2 from a read command** — the login expired. Log in again
  (step 2).
- **Exit code 2 from `login` itself** — that attempt failed. Read the message
  and fix its cause; retrying blindly risks CAP008.
- **`stdin is empty`** — the login needed an answer to a question. Only the
  username has a flag (`--username`); a password prompt, kodeviser digits or
  an identity choice all need the user to run the login themselves in a
  terminal.
- **Sensitive threads missing** — `aula refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's vendor failed; it is
  not an empty week. The warning names the vendor.
- **Scheduled overview misbehaves** — read `~/.aula/brief/launchd.log`.
  `timed out`: the Mac slept mid-run, and the retries redo the morning.
  `Not logged in`: `claude` has no credentials outside a terminal — run
  `claude` once, log in, and try again. `command not found`: something is off
  launchd's bare PATH — re-run `schedule`.
- **An overview was slow or incomplete** — inspect the owner-only lifecycle
  log: `tail -n 20 ~/.aula/logs/brief.jsonl | jq '{at,event,revision,details}'`.
  It records phase times and model attempts, never the prompt or the source
  text.
- **The online copy is stale** — the same log's line beginning
  `Artifact blev ikke opdateret:` says why; `aula publish`
  redeploys immediately.
- **`aula: command not found` after installing** — `~/.local/bin` is not on
  `PATH` in this shell yet (step 1). Use the full `~/.local/bin/aula`, or open
  a new terminal.

## Updating

Re-run the curl from step 1; it overwrites the binary in place. Nothing else
changes — the login, preferences and hosted URL all live in `~/.aula`.

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
