# Setting up aula-cli

A walkthrough from nothing to "just ask Claude about school". Takes about ten
minutes, most of it the MitID login.

**If you are Claude**, follow the steps in order. Ask before installing
software (step 1) and before writing anything outside this repository (steps 5
and 6). Never perform the MitID approval yourself — that is the user's phone
and the user's identity. Report each step's outcome as you go.

## What you need

- macOS or Linux (Windows is untested)
- [git](https://git-scm.com) and [Claude Code](https://claude.com/claude-code)
- The MitID app on your phone — the same one you use for aula.dk today
- For the optional daily brief: the `claude` CLI on your PATH, and Chrome if
  you ever want PDF/PNG output

## 1. Bun

The CLI runs on [Bun](https://bun.com) ≥ 1.3, no build step. Check, and
install if missing:

```bash
bun --version || curl -fsSL https://bun.sh/install | bash
```

(Homebrew works too: `brew install oven-sh/bun/bun`.)

## 2. Install dependencies

From the repository root:

```bash
bun install
```

Optional sanity check — the test suite needs no credentials and no network:

```bash
bun run test
```

### Optional: put `aula` on your PATH

This guide spells out `bun src/cli.ts …`; a one-line wrapper makes that just
`aula …` from any directory (the CLI never depends on the working directory):

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
```

Requires `~/.local/bin` on your PATH. `aula --help` lists the commands;
`aula open` shows the newest overview, `aula new` generates a fresh one.

## 3. Log in with MitID

Have your phone ready:

```bash
bun run login
```

It asks for your **MitID username** (what you type into MitID, not your Aula
name), then prints a code — approve it in the MitID app. Tokens are encrypted
into `~/.aula/tokens.json` and refresh themselves; you will not log in again
day-to-day. Verify:

```bash
bun src/cli.ts status --text
```

If MitID complains about a *parallel session* (CAP008): open the MitID app and
reject any pending approval, close aula.dk browser tabs, wait a minute, retry.
The login prints these exact instructions when it happens.

## 4. Health check

```bash
bun src/cli.ts doctor --text
```

`doctor` calls every endpoint and prints what came back. `WARN` lines are
calls that *succeeded* but returned a known symptom — read them:

- `not stepped up` — sensitive threads (the ones about one specific child)
  will read as empty. Fix: `bun src/cli.ts refresh-stepup`.
- A Meebook warning telling you to open the widget in aula.dk once — that is
  Meebook's one-time activation, done in the browser, not a bug here.

## 5. Install the skill

The repository ships a Claude skill at `.claude/skills/aula/SKILL.md`. It
already works whenever Claude is opened *in this folder*. To make Aula
questions work in **any** Claude session, install it at user level with the
repo path filled in:

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

New Claude sessions will now answer "what did I miss in Aula?" directly.

## 6. Optional: the daily brief

`aula new` generates the "Aula AI oversigt" — a self-contained HTML page
summarising what needs action, what is coming, and what merely happened — and
opens it. Try it once (it takes a couple of minutes; it calls `claude` for the
extraction and layout):

```bash
bun src/cli.ts new
```

In the Claude Code desktop app, this project's **Preview** button shows the
newest overview too: `.claude/launch.json` starts a small local-only server
(port 4317) that serves the pages in `~/.aula/brief` and nothing else.

If you want it every weekday morning (06:30 by default):

```bash
bun src/cli.ts schedule
```

`--at 07:00` picks another time; `aula schedule --remove` stops it. macOS gets
a launchd agent, Windows a Scheduled Task; on Linux the command prints the
cron line to add yourself.

On macOS the agent bakes in the directories holding `bun`, `claude` and
`node`, because launchd starts with a bare PATH. **Re-run `aula schedule`
after changing node version** — `claude` shells out to node for plugin hooks,
and a node it cannot find kills it with exit 143 after the work is done, which
costs the brief its model output.

Design and reasoning: [BRIEF.md](BRIEF.md).

## 7. Optional: publish the brief to a URL

By default the brief never leaves the machine. If you want to read it on a phone
or send the link, publish it once from a Claude session in this repository —
"publish ~/.aula/brief/artifact.html as an artifact" — then save the URL it
returns:

```bash
echo 'https://claude.ai/code/artifact/<uuid>' > ~/.aula/brief/artifact-url
```

From then on every run redeploys the page to that same URL, so the link always
shows today's brief. `--no-deploy` skips it once; deleting the file turns it off.
`AULA_ARTIFACT_URL` overrides the file for a single run.

Think about this one before turning it on. The page contains whatever the school
and daycare wrote about your children — for some families that includes health
information. Artifacts are private to your account until you choose to share the
link, but this is still the only part of the tool that sends anything anywhere.

## 8. Try it

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
  `~/.aula/brief/launchd.log` for `exited 143` and a `command not found`. A
  plugin hook could not find its interpreter on launchd's bare PATH; re-run
  `aula schedule` to bake the current directories back in.
- **The hosted link is stale while the local page is current** — the same log
  carries the reason on the `Artifact blev ikke opdateret:` line. `claude`
  offers the Artifact tool only to sessions announcing themselves as the
  desktop app, which `deploy.ts` handles; if a `claude` update changes that,
  this is the line that will say so.

## Uninstall

```bash
aula schedule --remove
rm -rf ~/.claude/skills/aula ~/.aula
```

…then delete the repository folder. `~/.aula` holds everything the tool ever
stored: tokens, cookies, cache, downloaded attachments and generated briefs.
