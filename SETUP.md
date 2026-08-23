# Setting up aula-cli

For the agent doing the install on a parent's machine. About ten minutes, most
of it the MitID login. Ask before installing software and before writing
outside this repository (the skill install does). Never perform the MitID
approval yourself. Report each step's outcome.

Steps 1–4 run without stopping. **Then offer all four extras** — none of them
is discoverable from the outside, and they are what makes this a tool the
family uses rather than one that merely works — and finish with the hand-over.
Run only what the user agrees to.

`new` reads a fortnight of school messages through a model: give it a
**10-minute timeout**, not the two minutes most tooling defaults to. Everything
else here answers in seconds.

Needs macOS or Linux (Windows code paths exist but are untested), git, the MitID
app on the user's phone, and — for the daily brief — the `claude` CLI on PATH,
whichever agent is driving.

## 1. Code and runtime

```bash
git clone https://github.com/sorenlouv/aula-cli.git ~/aula-cli && cd ~/aula-cli
bun --version || curl -fsSL https://bun.sh/install | bash   # Bun ≥ 1.3; `exec $SHELL` if still not found
bun install
```

Somewhere the user can find again, and not nested in an unrelated project; if
it is already cloned elsewhere, stay there. Everything runs as
`bun src/cli.ts <command>` from that folder, including the steps that bake its
path into a file. Extra A turns that into plain `aula <command>`.

## 2. Log in with MitID

```bash
bun run login
```

It asks for the **MitID username** (what they type into MitID, not their Aula
name), then shows one of: a code to approve in the MitID app, a QR code to scan
with it, or a list of identities to pick from. All normal. `--method CODE_TOKEN`
for a kodeviser; `--debug` writes a sanitised wire transcript to
`~/.aula/login-trace.jsonl`. Tokens are encrypted in `~/.aula/tokens.json` and
refresh themselves.

A *parallel session* error (CAP008) means an earlier attempt is still live on
MitID's side: reject any pending approval in the app, close aula.dk tabs, wait a
minute, retry. The CLI prints this when it happens.

**`bun run login` cannot be driven by an agent** — it has no terminal to ask
in, and it fails saying so. Instead:

1. Ask the user for their MitID username in the chat.
2. Run in the background, 10-minute timeout:
   `bun src/cli.ts login --username "<their username>"`
3. It prints a `http://127.0.0.1:…` link and opens it on their screen. **Give
   them the link too** and tell them to keep the page open: it shows whatever
   MitID is asking for and updates itself, including the QR pair that rotates
   every few seconds and cannot be relayed through a chat. They approve on
   their phone, as always.
4. Watch for `Login successful`, or a failure with its reason.

`--no-browser` keeps everything in the terminal, for a machine with no desktop
to open a page on. Never ask for or type their MitID password: the default
method has none.

Verify with `bun src/cli.ts status --text`.

## 3. Health check

```bash
bun src/cli.ts doctor --text
```

`WARN` is a call that succeeded but returned a known symptom. Two to act on:
`not stepped up` means sensitive threads read as empty — run
`bun src/cli.ts refresh-stepup`; a Meebook warning asking to open the widget in
aula.dk once is Meebook's one-time activation, which the user does in a browser.

## 4. Install the skill

`.claude/skills/aula/SKILL.md` already works when Claude is opened in this
folder. For every Claude session, install it at user level with the path filled
in (re-running overwrites):

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

`$(pwd)` is why this runs from the repository root. New Claude sessions pick it
up; the current one does not.

Codex has no skills, so the pointer goes in `~/.codex/AGENTS.md` instead:

```markdown
## Aula (school and daycare)

For anything about the user's children at school or daycare — messages, posts,
weekly plans, calendar, photos, check-in/check-out — use the read-only CLI:

    cd ~/aula-cli && bun src/cli.ts digest --days 14

Read ~/aula-cli/.claude/skills/aula/SKILL.md first: it lists every command and
how to read what comes back. The tool cannot write to Aula, by design.
```

This repository's own `AGENTS.md` is notes for people working *on* the CLI, not
a usage guide; Codex loads it when the repo is open, and nothing in it needs
following to use the tool.

## Offer these four

Say what each one does and let the user choose. Each writes something outside
this repository, so deleting the folder does not undo them.

### A. `aula` from anywhere

Saves typing, and makes the tool usable from any folder rather than only this
one. Needs `~/.local/bin` on PATH — it is not there by default on macOS.

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
command -v aula || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # next terminal picks it up
```

### B. The overview, every morning

```bash
bun src/cli.ts new          # writes the overview to ~/.aula/brief and opens it; 10-minute timeout, calls `claude`
bun src/cli.ts schedule     # every weekday 06:30; --at HH:MM to change, --remove to stop
```

Generate one first so they can see what they are scheduling. `schedule`
installs a launchd agent (macOS) or Scheduled Task (Windows); on Linux it
prints cron lines to add. It retries through the morning with `--catch-up`
because the laptop is usually asleep at 06:30. The agent bakes in PATH and
`AULA_BRIEF_MODEL` / `AULA_BRIEF_EFFORT` / `AULA_CACHE_TTL` from the shell it
was run in — re-run `schedule` after changing node version or those variables.

In Claude Code Desktop the project's Preview button (`.claude/launch.json`, port
4317, local only) shows the newest overview.

### C. A hosted copy, readable on a phone

```bash
bun src/cli.ts publish      # private artifact on the user's claude.ai account; URL kept in ~/.aula/config.json; --off to stop
```

Every later run redeploys to the same URL; `open --web` opens it. **This is the
only part of the tool that sends anything off the machine, and the page is
whatever the school wrote about their children — for some families that
includes health information.** Quote that to the user and get an explicit yes
before running it. It is private to their claude.ai account until they share
the link.

### D. Their own calendar

The overview knows the school's day, not that the dentist is at 13.30 on
Thursday. Point it at the user's own calendars and both land on the same page,
so they can see for themselves whether a day works.

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
every appointment through the same model relevance verdicts as every Aula
source, and reports a model or connector failure in *Datastatus*. It never
computes clashes or claims that a quiet-looking day has none.

## 5. Hand over

Tell the user it is ready and that they can now ask things like "what did I
miss in Aula?" or "har børnene noget i denne uge, jeg skal huske?". Standing
wishes about what to highlight are recorded with `aula remember`; the skill
covers when and how.

## When something is off

- **Exit code 2** — login expired. `bun run login`, approve on the phone.
- **`stdin is empty`** — the login was started with nothing attached to answer
  its prompt. Pass `--username <name>` (step 2).
- **Sensitive threads missing** — `bun src/cli.ts refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's vendor failed; that is
  not an empty week. `doctor --text` names the vendor.
- **Scheduled brief misbehaves** — read `~/.aula/brief/launchd.log`. `timed out`:
  the Mac slept mid-run and the retries redo the morning. `Not logged in`:
  `claude` has no credentials outside a terminal — run `claude` once and log in.
  `command not found`: a plugin hook off launchd's bare PATH — re-run `schedule`.
- **Hosted link stale** — the same log's `Artifact blev ikke opdateret:` line
  says why; `publish` redeploys now.

## Uninstall

```bash
bun src/cli.ts schedule --remove && rm -rf ~/.claude/skills/aula ~/.local/bin/aula ~/.aula
```

Then delete the folder, and the Aula block from `~/.codex/AGENTS.md` if it was
added. `~/.aula` holds everything the tool ever stored.
