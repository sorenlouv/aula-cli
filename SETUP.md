# Setting up aula-cli

Perform steps 1–4 without stopping. Then offer the optional steps.
`aula new` reads 60 days of posts and messages: give it a 10-minute timeout;
everything else should answer in seconds.

Needs git, the MitID app on the user's phone, and `claude` CLI on PATH.

## 1. Code and runtime

```bash
git clone https://github.com/sorenlouv/aula-cli.git ~/aula-cli && cd ~/aula-cli
bun --version || curl -fsSL https://bun.sh/install | bash   # Bun ≥ 1.3; `exec $SHELL` if still not found
bun install
```

If already cloned elsewhere, stay there. Everything runs as `bun src/cli.ts <command>` from that folder, including the
steps that bake its path into a file.

## 2. Log in with MitID

`bun run login` cannot be driven by an agent — it has no terminal to ask in, and
fails saying so. Instead:

1. Ask the user for their MitID username in the chat (what they type into
   MitID, not their Aula name).
2. Run in the background with a 10-minute timeout:
   `bun src/cli.ts login --username "<username>"`
3. It prints a `http://127.0.0.1:…` link and opens it. Give the user the link
   too and tell them to keep the page open: it the MitID QR code challenge which the user must handle and they approve on their phone.
4. Watch for `Login successful`, or a failure with its reason.

`--no-browser` keeps it in the terminal for a machine with no desktop;
`--method CODE_TOKEN` uses a numeric code instead of a QR code; `--debug` writes
a redacted, owner-only diagnostic trace to `~/.aula/login-trace.jsonl`. Never
ask for or type their MitID password; the default method has none. The login
refreshes automatically.

A _parallel session_ error (CAP008) means an earlier attempt is still live on
MitID's side: reject any pending approval in the app, close aula.dk tabs, wait a
minute, retry. The CLI says this when it happens.

Verify: `bun src/cli.ts status --text`.

## 3. Health check

```bash
bun src/cli.ts doctor --text
```

Read every `WARN` or `FAIL` line. Fix it when the output gives a command;
otherwise report it before continuing.

## 4. Install the skill

Install the skill for the user's agent of choice. Re-running overwrites it; open a new session afterwards.

Claude:

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

Codex:

```bash
mkdir -p ~/.agents/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.agents/skills/aula/SKILL.md
```

Do not read `AGENTS.md`. It is only for maintainers (code contributors), not end users of the CLI.

## Optional steps

Say what each does and let the user choose. Each writes outside this repository, so deleting the cloned repo folder does not undo it.

**A. `aula` from anywhere.** Needs `~/.local/bin` on PATH, which macOS does not have by default.

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
command -v aula || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # next terminal picks it up
```

**B. The overview, every morning.** Generate one first so they see what they
are scheduling.

```bash
bun src/cli.ts new          # writes ~/.aula/brief and opens it; 10-minute timeout, calls `claude`
bun src/cli.ts schedule     # weekdays 06:30; --at HH:MM to change, --remove to stop
```

`schedule` installs a launchd agent (macOS) or Scheduled Task (Windows); on
Linux it prints cron lines. On macOS a lightweight coordinator waits through
battery DarkWake and starts the brief after a full wake or AC connection; the
calendar retries remain as crash recovery. Every generation uses `--catch-up`,
and the schedule bakes in PATH plus
`AULA_BRIEF_MODEL`, `AULA_BRIEF_EFFORT`, `AULA_TOOL_MODEL`,
`AULA_TOOL_EFFORT`, `AULA_BRIEF_REPAIR_MODEL`, `AULA_BRIEF_REPAIR_EFFORT` and
`AULA_CACHE_TTL` from the shell it ran in — re-run it after changing node
version or those variables. Extraction uses the configured brief model; a
source-bounded date repair and deterministic calendar/publishing tool calls
default to Haiku at low effort to avoid paying extraction-model prices for
transport. In Claude Code Desktop the Preview button (`.claude/launch.json`,
port 4317, local only) shows the newest overview.

**C. A hosted copy, readable on a phone.**

```bash
bun src/cli.ts publish      # URL kept in ~/.aula/config.json; --off to stop
```

Every later run redeploys to the same URL; `open --web` opens it.

### D. Their own calendar

Integrate the user's personal calendars into the Aula overview. Appointments
appear as compact, individually collapsed cards directly among the Aula cards
under *Kommende*. Both shapes are ordered by day, and known calendar times are
ordered within the day. Opening a personal card shows its model-written summary
and relevance reason, location, calendar and link.

```bash
bun src/cli.ts calendars                 # every calendar Claude can see; the ones being read are marked
bun src/cli.ts calendars set "Familie" "Privat"  # read exactly these two, and no others
bun src/cli.ts calendars set none        # read none of them
```

Needs Google Calendar connected in Claude. That is the only supported route —
there is no API key or calendar-link alternative, and `calendars` prints the few
clicks when the connector is missing.

**Show the list and let the user pick.** Pass exact displayed names (or the id
shown when two calendars have the same name), never a list position that may
refer to something else on a later connector read. Never guess which calendars
matter and never set one unasked: this writes to `~/.aula/config.json`, outside
the repository. `set` states the whole answer — it reads exactly what you name
and stops reading the rest — so pass every calendar that should be read, not
only a new one. It reports how many appointments each newly set calendar holds
in the next fortnight; pass that back, and say so if one comes back empty when
they expected otherwise.

Nothing is read until a calendar is named here, and this can be done at any
time, not only during setup.

The model-enabled daily overview reads a fixed next-fortnight window, sends
every appointment through the same model pass as every Aula source, with one
explicit relevance, summary and reason verdict per appointment. Irrelevant
appointments stay in the muted hidden count; relevant ones remain visually
quieter than Aula cards and never consume the full-card cap. A model or
connector failure appears in _Datastatus_. The overview never computes clashes
or claims that a quiet-looking day has none; it puts the appointment beside the
school's day and lets the reader see it.

Personal appointments require positive evidence of child, school/day-care,
playdate, pickup/drop-off or child-activity context. Cryptic and adult-only
appointments default to hidden; their time or possible indirect effect on the
parents' availability does not make them relevant.

## 5. Hand over

Tell the user it is ready: they can now interact with Aula in natural language.
The user may want to tune which events are relevant to them specifically. You
can call `aula remember` to store their preferences, for example "Always show
events from other parents".

## Debugging

- **Exit code 2** — login expired. Log in again (step 2).
- **`stdin is empty`** — the login was started with nothing to answer its
  prompt. Pass `--username` (step 2).
- **Sensitive threads missing** — `bun src/cli.ts refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's vendor failed; not an
  empty week. The warning names the vendor.
- **Scheduled brief misbehaves** — read `~/.aula/brief/launchd.log`. `timed
out`: the Mac slept mid-run; the retries redo the morning. `Not logged in`:
  `claude` has no credentials outside a terminal — run `claude` once and log in.
  `command not found`: a plugin hook off launchd's bare PATH — re-run `schedule`.
- **A brief was slow or incomplete** — inspect the owner-only lifecycle log:
  `tail -n 20 ~/.aula/logs/brief.jsonl | jq '{at,event,revision,details}'`.
  It records phase times and model attempts, never the prompt or source payload.
- **Hosted link stale** — the same log's `Artifact blev ikke opdateret:` line
  says why; `publish` redeploys now.

## Uninstall

```bash
bun src/cli.ts schedule --remove && rm -rf ~/.claude/skills/aula ~/.agents/skills/aula ~/.local/bin/aula ~/.aula
```

Then delete the folder. `~/.aula` holds everything the tool ever stored.
