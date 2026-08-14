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
bun test src/
```

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

`aula brief` generates the "Aula AI oversigt" — a self-contained HTML page
summarising what needs action, what is coming, and what merely happened. Try
it once (it takes a couple of minutes; it calls `claude` for the extraction
and layout):

```bash
bun src/cli.ts brief --open
```

If you want it every weekday morning (06:30 by default) on macOS:

```bash
scripts/install-brief-schedule.sh
```

`BRIEF_HOUR=7 BRIEF_MINUTE=0 scripts/install-brief-schedule.sh` changes the
time; the script prints how to run it now and how to uninstall. On Linux, a
cron line does the same job:

```cron
30 6 * * 1-5 cd /path/to/aula-cli && bun src/cli.ts brief --text
```

Design and reasoning: [BRIEF.md](BRIEF.md).

## 7. Try it

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
- **The login flow itself is broken** — there is a browser-cookie fallback;
  see [Cookie fallback](README.md#cookie-fallback) in the README.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.aula-cli.brief 2>/dev/null
rm -f ~/Library/LaunchAgents/com.aula-cli.brief.plist
rm -rf ~/.claude/skills/aula ~/.aula
```

…then delete the repository folder. `~/.aula` holds everything the tool ever
stored: tokens, cookies, cache, downloaded attachments and generated briefs.
