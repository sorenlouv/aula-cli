# Setting up aula-cli

For the agent installing on a parent's machine; about ten minutes, most of it
the MitID login. Ask before installing software or writing outside this
repository. Never perform the MitID approval yourself. Report each step's
outcome.

Steps 1–4 run without stopping. Then offer the three extras — none is
discoverable from outside — and run only what the user agrees to. `new` reads a
fortnight of messages through a model: give it a 10-minute timeout; everything
else answers in seconds.

Needs macOS or Linux (Windows paths exist, untested), git, the MitID app on the
user's phone, and for the brief the `claude` CLI on PATH.

## 1. Code and runtime

```bash
git clone https://github.com/sorenlouv/aula-cli.git ~/aula-cli && cd ~/aula-cli
bun --version || curl -fsSL https://bun.sh/install | bash   # Bun ≥ 1.3; `exec $SHELL` if still not found
bun install
```

Somewhere the user can find again; if already cloned elsewhere, stay there.
Everything runs as `bun src/cli.ts <command>` from that folder, including the
steps that bake its path into a file.

## 2. Log in with MitID

`bun run login` cannot be driven by an agent — it has no terminal to ask in, and
fails saying so. Instead:

1. Ask the user for their MitID username in the chat (what they type into
   MitID, not their Aula name).
2. Run in the background with a 10-minute timeout:
   `bun src/cli.ts login --username "<username>"`
3. It prints a `http://127.0.0.1:…` link and opens it. Give the user the link
   too and tell them to keep the page open: it shows whatever MitID asks — a
   code to approve in the app, a QR pair that rotates every few seconds, or a
   list of identities — and they approve on their phone.
4. Watch for `Login successful`, or a failure with its reason.

`--no-browser` keeps it in the terminal for a machine with no desktop;
`--method CODE_TOKEN` for a kodeviser; `--debug` writes a sanitised wire
transcript to `~/.aula/login-trace.jsonl`. Never ask for or type their MitID
password; the default method has none. Tokens are encrypted in
`~/.aula/tokens.json` and refresh themselves.

A *parallel session* error (CAP008) means an earlier attempt is still live on
MitID's side: reject any pending approval in the app, close aula.dk tabs, wait a
minute, retry. The CLI says this when it happens.

Verify: `bun src/cli.ts status --text`.

## 3. Health check

```bash
bun src/cli.ts doctor --text
```

`WARN` is a call that succeeded but returned a known symptom. Act on two:
`not stepped up` (sensitive threads read as empty — `bun src/cli.ts
refresh-stepup`), and a Meebook warning asking to open the widget in aula.dk
once, which the user does in a browser.

## 4. Install the skill

`.claude/skills/aula/SKILL.md` already works when Claude is opened in this
folder. For every Claude session, install it at user level with the path filled
in (re-running overwrites; new sessions pick it up, the current one does not):

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

Codex has no skills; put this in `~/.codex/AGENTS.md` instead:

```markdown
## Aula (school and daycare)

For anything about the user's children at school or daycare — messages, posts,
weekly plans, calendar, photos, check-in/check-out — use the read-only CLI:

    cd ~/aula-cli && bun src/cli.ts digest --days 14

Read ~/aula-cli/.claude/skills/aula/SKILL.md first: it lists every command and
how to read what comes back. The tool cannot write to Aula, by design.
```

(This repository's own `AGENTS.md` is notes for working *on* the CLI, not a
usage guide.)

## Offer these three

Say what each does and let the user choose. Each writes outside this
repository, so deleting the folder does not undo it.

**A. `aula` from anywhere.** Needs `~/.local/bin` on PATH, which macOS does not
have by default.

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
Linux it prints cron lines. It retries through the morning with `--catch-up`
because the laptop is usually asleep at 06:30, and it bakes in PATH plus
`AULA_BRIEF_MODEL` / `AULA_BRIEF_EFFORT` / `AULA_CACHE_TTL` from the shell it
ran in — re-run it after changing node version or those variables. In Claude
Code Desktop the Preview button (`.claude/launch.json`, port 4317, local only)
shows the newest overview.

**C. A hosted copy, readable on a phone.**

```bash
bun src/cli.ts publish      # private artifact on the user's claude.ai account; URL kept in ~/.aula/config.json; --off to stop
```

Every later run redeploys to the same URL; `open --web` opens it. **This is the
only part of the tool that sends anything off the machine, and the page is
whatever the school wrote about their children — for some families that
includes health information.** Quote that to the user and get an explicit yes
first. It stays private to their claude.ai account until they share the link.

## 5. Hand over

Tell the user it is ready: they can ask "what did I miss in Aula?" or "har
børnene noget i denne uge, jeg skal huske?". Standing wishes about what to
highlight are recorded with `aula remember`; the skill covers when and how.

## When something is off

- **Exit code 2** — login expired. Log in again (step 2).
- **`stdin is empty`** — the login was started with nothing to answer its
  prompt. Pass `--username` (step 2).
- **Sensitive threads missing** — `bun src/cli.ts refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's vendor failed; not an
  empty week. `doctor --text` names the vendor.
- **Scheduled brief misbehaves** — read `~/.aula/brief/launchd.log`. `timed
  out`: the Mac slept mid-run; the retries redo the morning. `Not logged in`:
  `claude` has no credentials outside a terminal — run `claude` once and log in.
  `command not found`: a plugin hook off launchd's bare PATH — re-run `schedule`.
- **Hosted link stale** — the same log's `Artifact blev ikke opdateret:` line
  says why; `publish` redeploys now.

## Uninstall

```bash
bun src/cli.ts schedule --remove && rm -rf ~/.claude/skills/aula ~/.local/bin/aula ~/.aula
```

Then delete the folder, and the Aula block from `~/.codex/AGENTS.md` if added.
`~/.aula` holds everything the tool ever stored.
