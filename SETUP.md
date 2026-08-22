# Setting up aula-cli

About ten minutes, most of it the MitID login. At the end you can ask your
agent "what did I miss in Aula?" in any session and it will know.

## For the agent doing this

Work through steps 1–7 in order, and say how each one went as you go.

**Do without asking** anything that only touches this folder or `~/.aula`.

**Ask first** before installing software (step 2), and before every write
outside this repository — the skill install in step 6 is one.

**Never** approve the MitID login yourself: that is the user's phone and the
user's identity. Never ask for or type their MitID password either — the
default login method does not use one.

**When steps 1–7 are done, offer all three extras at the bottom.** They are the
difference between a CLI that works and something the family actually uses, and
none of them is discoverable from the outside. Present all three, let the user
choose, and run only what they say yes to. Extra C publishes a page about the
user's children to the internet: quote its warning to them and get an explicit
yes before running it.

**Slow commands.** `new` reads a fortnight of school messages through a model
and takes 2–10 minutes. Give it a **10-minute timeout** — a two-minute default
kills it halfway through and tells you nothing useful. Everything else in this
guide answers in seconds.

## What you need

- macOS or Linux (the Windows paths exist, `schedule` included, but are
  untested)
- [git](https://git-scm.com). On a Mac that has never built anything, the first
  `git` command pops up an Xcode Command Line Tools installer and waits for it
  — let it finish, then carry on.
- [Claude Code](https://claude.com/claude-code) or Codex
- The MitID app on your phone — the same one you use for aula.dk today
- For the daily overview (`new`, and Extras B and C): the `claude` CLI on your
  PATH and logged in. This holds **whichever agent you use**: the overview
  shells out to `claude` to do the reading and the writing.

## 1. Get the code

```bash
git clone https://github.com/sorenlouv/aula-cli.git ~/aula-cli
cd ~/aula-cli
```

`~/aula-cli` unless the user says otherwise — somewhere they can find it again,
and not nested inside an unrelated project. If it is already cloned somewhere
else, stay there and read that path everywhere this guide says `~/aula-cli`.
**Every command below runs from the repository folder**, including the ones that
bake its path into a file.

## 2. Bun

The CLI runs on [Bun](https://bun.com) ≥ 1.3, with no build step. Check, and
install if it is missing:

```bash
bun --version || curl -fsSL https://bun.sh/install | bash
```

(Homebrew works too: `brew install oven-sh/bun/bun`.)

The installer edits the shell profile, not the shell it is running in. If `bun`
is still not found afterwards, it is at `~/.bun/bin/bun`; a new terminal picks
it up.

## 3. Install dependencies

```bash
bun install
```

That is the tool installed. Commands are written out as
`bun src/cli.ts <command>` throughout; where the prose just names one —
`doctor`, `publish` — it means the same thing. Extra A at the bottom turns all
of them into plain `aula <command>`.

## 4. Log in with MitID

This is the one step that needs the user's phone.

```bash
bun run login
```

It asks for the **MitID username** — what they type into MitID, not their Aula
name — and then shows whatever MitID asks for: a code to compare against the
app, or a pair of QR codes to scan with it. Tokens are encrypted into
`~/.aula/tokens.json` and refresh themselves, so this is a one-off.

**If you are an agent, that command will not work for you** — it has no
terminal to ask in. Do this instead:

1. Ask the user for their MitID username in the chat.
2. Run, in the background, with a 10-minute timeout:

   ```bash
   bun src/cli.ts login --username "<their username>"
   ```

3. It prints a `http://127.0.0.1:…` link and opens it on their screen. **Give
   them that link too**, and tell them to keep the page open: it shows whatever
   MitID is currently asking for and updates itself, including the QR pair that
   rotates every few seconds. They approve on their phone, as always.
4. Watch the command's output for `Login successful` or a failure with its
   reason.

`--no-browser` turns the page off and keeps everything in the terminal — for a
machine with no desktop to open it on. The code-comparison mode is readable in
the output either way; the QR mode is not.

Then verify:

```bash
bun src/cli.ts status --text
```

If MitID complains about a **parallel session** (CAP008): open the MitID app,
reject any pending approval, close aula.dk browser tabs, wait a minute, retry.
The login prints these exact instructions when it happens.

## 5. Health check

```bash
bun src/cli.ts doctor --text
```

`doctor` calls every endpoint and prints what came back. `WARN` lines are calls
that *succeeded* but returned a known symptom — read them:

- `not stepped up` — sensitive threads (the ones about one specific child) will
  read as empty. Fix: `bun src/cli.ts refresh-stepup`.
- A Meebook warning telling you to open the widget in aula.dk once — that is
  Meebook's one-time activation, done in the browser, not a bug here.

## 6. Teach the agent about Aula

### Claude Code

The repository ships a skill at `.claude/skills/aula/SKILL.md`, which already
works whenever Claude is opened in this folder. Installing it at user level is
what makes Aula questions work in **any** session (re-running overwrites a
previous install):

```bash
mkdir -p ~/.claude/skills/aula
sed "s|{{AULA_CLI_DIR}}|$(pwd)|" .claude/skills/aula/SKILL.md > ~/.claude/skills/aula/SKILL.md
```

`$(pwd)` is why this has to run from the repository root — it writes the path
into the copy. New Claude sessions pick it up; the current one does not.

### Codex

Codex has no skills, so the same pointer goes in its global instructions,
`~/.codex/AGENTS.md`. Append:

```markdown
## Aula (school and daycare)

For anything about the user's children at school or daycare — messages, posts,
weekly plans, calendar, photos, check-in/check-out — use the read-only CLI at
~/aula-cli (adjust if it was cloned elsewhere):

    cd ~/aula-cli && bun src/cli.ts digest --days 14

Read ~/aula-cli/.claude/skills/aula/SKILL.md first: it lists every command and
how to read what comes back. The tool cannot write to Aula, by design.
```

One warning for Codex users: this repository's own `AGENTS.md` is field notes
for people *working on the CLI*, not instructions for using it. Opening the repo
in Codex loads that file. It is not a usage guide, and nothing in it needs to be
followed to use the tool.

## 7. Try it

In a new session, ask things like:

- "What did I miss in Aula the last two weeks?"
- "Does anything need a reply or have a deadline?"
- "What does my daughter have on Thursday?"
- "Har børnene noget i denne uge, jeg skal huske?"

That is the whole tool working. The daily overview — one page saying what needs
action, what is coming and what merely happened — is Extra B below.

---

# The three extras

**Agents: offer all three now.** Say what each one does, let the user pick, and
run only what they agree to. None of them can be undone by deleting the repo
folder — each writes something outside it.

## A. `aula` from anywhere

Saves typing `bun src/cli.ts` and, more to the point, makes the tool usable from
any folder. Writes one file, `~/.local/bin/aula`:

```bash
mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$(pwd)" > ~/.local/bin/aula && chmod +x ~/.local/bin/aula
```

`~/.local/bin` is not on the PATH by default on macOS. Check, and fix it if
needed:

```bash
command -v aula || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

(That line takes effect in the next terminal.) From then on `aula <command>`
means `bun src/cli.ts <command>`, from anywhere. This guide keeps spelling out
the long form, because it works whether or not the user took this option.

## B. The overview, every morning

`new` generates the "Aula AI oversigt": a self-contained page ranking what needs
action, what is coming, and what merely happened. Generate one now to see it
(**10-minute timeout** — it calls `claude` for the reading and the layout):

```bash
bun src/cli.ts new
```

In the Claude Code desktop app, this project's **Preview** button shows the
newest one: `.claude/launch.json` starts a local-only server (port 4317) that
serves the pages in `~/.aula/brief` and nothing else.

To have it ready every weekday morning at 06:30:

```bash
bun src/cli.ts schedule
```

`--at 07:00` picks another time; `bun src/cli.ts schedule --remove` stops it. macOS gets a
launchd agent, Windows a Scheduled Task; on Linux the command prints the cron
lines to add.

A laptop is usually asleep at 06:30, and one trigger is not enough: macOS Power
Nap wakes it for three-minute maintenance windows, the job starts in one of
them, and the Mac sleeps again with `claude` mid-request. So the agent holds the
Mac awake for the few minutes the run takes (`caffeinate`, honoured on power)
and fires again every 15 minutes for three hours. Every trigger passes
`--catch-up`: do nothing if the day's overview is already complete, redo the
morning otherwise. Open the lid at 07:40 and the brief is there by 07:45.

Two things get baked into the agent at install time, because launchd starts with
a bare PATH and never sees a shell profile: the directories holding `bun`,
`claude` and `node`, and the model knobs `AULA_BRIEF_MODEL`, `AULA_BRIEF_EFFORT`
and `AULA_CACHE_TTL` as they are set in the shell that runs `schedule`.
**Re-run `bun src/cli.ts schedule` after changing node version or any of
those.**

Design and reasoning: [BRIEF.md](BRIEF.md).

## C. A link that works on a phone

By default the overview never leaves the machine. This publishes it:

```bash
bun src/cli.ts publish
```

**Think about this one before turning it on.** The page contains whatever the
school and daycare wrote about the user's children — for some families that
includes health information. It is published as an artifact, private to their
claude.ai account until they choose to share the link, but this is the only part
of the tool that sends anything anywhere. Agents: quote that paragraph and get
an explicit yes.

It saves the URL to `~/.aula/config.json`, and every run from then on redeploys
to that same URL, so the link always shows today's brief. `open --web` opens it
(and says so if it is stale); `publish --off` stops updating it and forgets the
URL; `--no-deploy` skips it for one run.

The preference lives outside the repository, which is the point: nobody who
clones this project inherits the URL, and nobody else can update the artifact —
the publish runs under *your* `claude` login.

---

# Living with it

The overview ranks what it believes a busy parent needs: that things to bring
and sign up for come first, that a message to the whole municipality is noise.
Those beliefs are not buried in the code — they are the first few lines of
`~/.aula/preferences.md`, in plain Danish, written the first time anything runs.

```bash
bun src/cli.ts preferences
```

Where they are wrong for your family, say so — to Claude, in your own words:

> Husk at beskeder fra John (Hjaltes far) altid er vigtige

or, just as validly:

> Jeg vil faktisk gerne se beskederne fra kommunen — drop den regel

Claude records that with `remember`, and it lands as one line in
`~/.aula/preferences.md`. Every overview from then on is written with your list
in front of the model, which reads every post and message against it and says
how much each one matters to you — and the page is built from those verdicts:
something you asked for is pulled up, something you said you never want is put
away in the folded list at the foot.

Two honest caveats. The overview is written by a model, so this is judgement
rather than a rule: on a morning where the model cannot run at all, the page is
built by the Danish date-and-obligation rules alone and your list is not applied
— nothing is hidden that day, which is the right way round for a tool whose
worst failure is a miss. And where a message you asked to be spared turns out to
ask something of *you* about *your child*, it is moved down rather than put
away: a message that every school in the municipality is shut on Monday still
shuts yours. Where nothing of the sort could be read out of it, your *never* is
taken at its word.

```bash
bun src/cli.ts preferences        # the whole list, numbered — defaults included
bun src/cli.ts forget 5           # drop number 5, shipped or your own
bun src/cli.ts preferences reset  # back to factory settings
```

`reset` prints the lines of your own that it drops, so nothing disappears
without you seeing it.

Every line is equal: the ones this tool started with can be reworded or deleted
like any other, and the code follows the list rather than the other way round —
delete the line about municipal messages and they start appearing. Wishes for
*less* work the same way ("jeg er ligeglad med billeder").

The file is one wish per line and nothing else — no header, no syntax to get
right — so editing it in any editor works as well as the commands do. It stays
on your machine with the rest of `~/.aula`: it names other people's children, so
it has no business in the repository.

## Troubleshooting

- **Exit code 2** — the login expired. `bun run login`, approve on the phone.
- **`Needed an answer to "MitID username:" and stdin is empty`** — the login was
  started with nothing attached to answer it. Pass `--username <name>` (see
  step 4).
- **Sensitive threads seem missing** — `bun src/cli.ts refresh-stepup`.
- **A weekly plan says COULD NOT BE READ** — the school's third-party vendor is
  down or misconfigured; that is not an empty week. `doctor --text` shows which
  vendor and why.
- **The brief runs but loses the model's wording** — check
  `~/.aula/brief/launchd.log`. `timed out` means the request never came back,
  which on a laptop means it slept mid-run; the scheduler's retries do the
  morning over, and the `Ufuldstændig kørsel` line marks which runs they will
  redo. `Not logged in` means `claude` has no credentials outside your terminal
  — run `claude` once interactively and log in. A `command not found` is a
  plugin hook missing its interpreter on launchd's bare PATH; re-run
  `bun src/cli.ts schedule` to bake the current directories back in.
- **The hosted link is stale while the local page is current** — the same log
  carries the reason on the `Artifact blev ikke opdateret:` line, and
  `open --web` says when the copy was last refreshed. `publish` redeploys the
  newest page right now. `claude` offers the Artifact tool only to sessions
  announcing themselves as the desktop app, which `deploy.ts` handles; if a
  `claude` update changes that, this is the line that will say so.

## Uninstall

```bash
bun src/cli.ts schedule --remove
rm -rf ~/.claude/skills/aula ~/.local/bin/aula ~/.aula
```

Codex users: also drop the Aula block from `~/.codex/AGENTS.md`. Then delete the
repository folder. `~/.aula` holds everything the tool ever stored: tokens,
cookies, cache, downloaded attachments and generated briefs.
