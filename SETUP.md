# Setting up aula-cli

A walkthrough from nothing to "just ask Claude about school". Takes about ten
minutes, most of it the MitID login.

**If you are Claude**, follow the steps in order. Ask before installing
software, and before any write outside this repository — the PATH wrapper, the
skill install and `schedule` all are. Never perform the MitID approval
yourself — that is the user's phone and the user's identity. Report each
step's outcome as you go.

## What you need

- macOS or Linux (the Windows code paths exist, `schedule` included, but are
  untested)
- [git](https://git-scm.com) and [Claude Code](https://claude.com/claude-code)
- The MitID app on your phone — the same one you use for aula.dk today
- For the optional daily brief: the `claude` CLI on your PATH, and Chrome if
  you ever want PDF/PNG output

## 1. Get the code

```bash
git clone https://github.com/sorenlouv/aula-cli.git
cd aula-cli
```

Every command below runs from this folder.

## 2. Bun

The CLI runs on [Bun](https://bun.com) ≥ 1.3, no build step. Check, and
install if missing:

```bash
bun --version || curl -fsSL https://bun.sh/install | bash
```

(Homebrew works too: `brew install oven-sh/bun/bun`.)

The installer edits your shell profile, not the shell you are in — if `bun` is
still not found afterwards, run `exec $SHELL` or open a new terminal.

## 3. Install dependencies

From the repository root:

```bash
bun install
```

### Optional: put `aula` on your PATH

This guide spells out `bun src/cli.ts …`; a one-line wrapper makes that just
`aula …` from any directory (the CLI never depends on the working directory):

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
```

Requires `~/.local/bin` on your PATH. `aula --help` lists the commands;
`aula open` shows the newest overview, `aula new` generates a fresh one.

## 4. Log in with MitID

Have your phone ready:

```bash
bun run login
```

It asks for your **MitID username** (what you type into MitID, not your Aula
name), then shows one of three things, all normal: a code to approve in the
MitID app, a QR code to scan with it, or — if your MitID holds more than one
identity — a list to pick from. `--method CODE_TOKEN` uses a kodeviser instead
of the app, and `--debug` writes a sanitised wire transcript to
`~/.aula/login-trace.jsonl` when something fails. Tokens are encrypted into
`~/.aula/tokens.json` and refresh themselves; you will not log in again
day-to-day. Verify:

```bash
bun src/cli.ts status --text
```

If MitID complains about a *parallel session* (CAP008): open the MitID app and
reject any pending approval, close aula.dk browser tabs, wait a minute, retry.
The login prints these exact instructions when it happens.

## 5. Health check

```bash
bun src/cli.ts doctor --text
```

`doctor` calls every endpoint and prints what came back. `WARN` lines are
calls that *succeeded* but returned a known symptom — read them:

- `not stepped up` — sensitive threads (the ones about one specific child)
  will read as empty. Fix: `bun src/cli.ts refresh-stepup`.
- A Meebook warning telling you to open the widget in aula.dk once — that is
  Meebook's one-time activation, done in the browser, not a bug here.

## 6. Install the skill

The repository ships a Claude skill at `.claude/skills/aula/SKILL.md`. It
already works whenever Claude is opened *in this folder*. To make Aula
questions work in **any** Claude session, install it at user level with the
repo path filled in (re-running overwrites a previous install):

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

New Claude sessions will now answer "what did I miss in Aula?" directly.

## 7. Optional: the daily brief

`aula new` generates the "Aula AI oversigt" — a self-contained HTML page
summarising what needs action, what is coming, and what merely happened — and
opens it. Try it once (it takes a couple of minutes; it calls `claude` for the
extraction and layout):

```bash
bun src/cli.ts new
```

In the Claude Code desktop app, this project's **Preview** button shows the
newest overview too: `.claude/launch.json` starts a small local-only server
(port 4317) that serves the pages in `~/.aula/brief` and nothing else. When no
overview exists yet, opening the preview generates one on the spot and shows
progress until it appears.

If you want it every weekday morning (06:30 by default):

```bash
bun src/cli.ts schedule
```

`--at 07:00` picks another time; `aula schedule --remove` stops it. macOS gets
a launchd agent, Windows a Scheduled Task; on Linux the command prints the
cron lines to add yourself.

A laptop is usually asleep at 06:30, and one trigger is not enough: macOS
Power Nap wakes it for three-minute maintenance windows, the job starts in one
of them, and the Mac sleeps again with `claude` mid-request. So the agent holds
the Mac awake for the few minutes the run takes (`caffeinate`, honoured on
power) and fires again every 15 minutes for three hours. Every trigger passes
`--catch-up`: do nothing once the day's overview is complete — the model ran
and, where configured, the hosted copy was refreshed — and do the morning over
otherwise. Open the lid at 07:40 and the brief is there by 07:45.

On macOS the agent bakes in the directories holding `bun`, `claude` and
`node`, because launchd starts with a bare PATH. **Re-run `aula schedule`
after changing node version** — `claude` shells out to node for plugin hooks,
and launchd's PATH is only ever what was baked in.

The same baking applies to the brief's model knobs: `AULA_BRIEF_MODEL`,
`AULA_BRIEF_EFFORT` and `AULA_CACHE_TTL` set in the shell where you run
`aula schedule` are written into the agent (a plain `export` in your profile
never reaches launchd). Change them by re-running `aula schedule`.

Design and reasoning: [BRIEF.md](BRIEF.md).

## 8. Optional: publish the brief to a URL

By default the brief never leaves the machine. If you want to read it on a phone
or send the link:

```bash
bun src/cli.ts publish
```

That publishes the newest overview as an artifact — private to your claude.ai
account — and saves its URL to `~/.aula/config.json`. From then on every run
redeploys the page to that same URL, so the link always shows today's brief,
and `aula open --web` opens it (and says so if it is stale). Running
`aula publish` again redeploys right away; `aula publish --off` stops updating
it and forgets the URL; `--no-deploy` skips it for one run.

The preference is per installation and lives outside the repository, which is
the point: nobody who clones this project inherits your URL, and nobody else
can update your artifact — the publish runs under *your* `claude` login.

Think about this one before turning it on. The page contains whatever the school
and daycare wrote about your children — for some families that includes health
information. Artifacts are private to your account until you choose to share the
link, but this is still the only part of the tool that sends anything anywhere.

## 9. Try it

Ask Claude things like:

- "What did I miss in Aula the last two weeks?"
- "Does anything need a reply or have a deadline?"
- "What does my daughter have on Thursday?"
- "Har børnene noget i denne uge, jeg skal huske?"

## Troubleshooting

- **Exit code 2** — the login expired. `bun run login`, approve on the phone.
- **Sensitive threads seem missing** — `bun src/cli.ts refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's third-party vendor
  is down or misconfigured; that is not an empty week. `doctor --text` shows
  which vendor and why.
- **The brief runs but loses the model's wording** — check
  `~/.aula/brief/launchd.log`. `timed out` means the request never came back,
  which on a laptop means it slept mid-run; the scheduler's retries do the
  morning over, and the `Ufuldstændig kørsel` line marks which runs they will
  redo. `Not logged in` means `claude` has no credentials outside your
  terminal — run `claude` once interactively and log in. A `command not found`
  is a plugin hook missing its interpreter on launchd's bare PATH; re-run
  `aula schedule` to bake the current directories back in.
- **The hosted link is stale while the local page is current** — the same log
  carries the reason on the `Artifact blev ikke opdateret:` line, and
  `aula open --web` says when the copy was last refreshed. `aula publish`
  redeploys the newest page right now. `claude` offers the Artifact tool only
  to sessions announcing themselves as the desktop app, which `deploy.ts`
  handles; if a `claude` update changes that, this is the line that will say so.

## Uninstall

```bash
aula schedule --remove
rm -rf ~/.claude/skills/aula ~/.aula
```

…then delete the repository folder. `~/.aula` holds everything the tool ever
stored: tokens, cookies, cache, downloaded attachments and generated briefs.
