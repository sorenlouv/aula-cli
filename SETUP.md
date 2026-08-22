# Setting up aula-cli

For the agent doing the install on a parent's machine. About ten minutes, most
of it the MitID login. Ask before installing software and before writing
outside this repository (the PATH wrapper, the skill install and `schedule` all
do). Never perform the MitID approval yourself. Report each step's outcome.

Needs macOS or Linux (Windows code paths exist but are untested), git, the MitID
app on the user's phone, and — for the daily brief — the `claude` CLI on PATH.

## 1. Code and runtime

```bash
git clone https://github.com/sorenlouv/aula-cli.git && cd aula-cli
bun --version || curl -fsSL https://bun.sh/install | bash   # Bun ≥ 1.3; `exec $SHELL` if still not found
bun install
```

Everything runs as `bun src/cli.ts <command>` from this folder. Optional
wrapper so it is `aula <command>` from anywhere (needs `~/.local/bin` on PATH):

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
```

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

## 5. Optional: the daily brief

```bash
bun src/cli.ts new          # writes the overview to ~/.aula/brief and opens it; a few minutes, calls `claude`
bun src/cli.ts schedule     # every weekday 06:30; --at HH:MM to change, --remove to stop
```

`schedule` installs a launchd agent (macOS) or Scheduled Task (Windows); on
Linux it prints cron lines to add. It retries through the morning with
`--catch-up` because the laptop is usually asleep at 06:30. The agent bakes in
PATH and `AULA_BRIEF_MODEL` / `AULA_BRIEF_EFFORT` / `AULA_CACHE_TTL` from the
shell it was run in — re-run `schedule` after changing node version or those
variables.

In Claude Code Desktop the project's Preview button (`.claude/launch.json`, port
4317, local only) shows the newest overview.

## 6. Optional: a hosted copy

```bash
bun src/cli.ts publish      # private artifact on the user's claude.ai account; URL kept in ~/.aula/config.json; --off to stop
```

Every later run redeploys to the same URL; `open --web` opens it. This is the
only part of the tool that sends anything off the machine, and the page is
about their children — say so before turning it on.

## 7. Hand over

Tell the user it is ready and that they can now ask things like "what did I
miss in Aula?" or "har børnene noget i denne uge, jeg skal huske?". Standing
wishes about what to highlight are recorded with `aula remember`; the skill
covers when and how.

## When something is off

- **Exit code 2** — login expired. `bun run login`, approve on the phone.
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
aula schedule --remove && rm -rf ~/.claude/skills/aula ~/.aula
```

Then delete the folder. `~/.aula` holds everything the tool ever stored.
