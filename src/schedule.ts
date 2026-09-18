/**
 * `aula schedule` — generate the overview automatically, morning and evening.
 *
 * Each platform gets its native "run this for the logged-in user" mechanism:
 * a launchd agent on macOS, a Task Scheduler task on Windows. Linux is cron,
 * systemd or neither depending on the distro, so rather than guessing wrong
 * quietly the command prints the cron lines that work everywhere.
 *
 * launchd starts jobs with a bare environment, so the one tool the run needs —
 * `claude` — has its directory baked into the agent's PATH at install time.
 * Windows tasks inherit the user's PATH from the registry, so nothing needs
 * baking there.
 *
 * What gets scheduled depends on how this CLI was installed: a compiled binary
 * schedules itself by absolute path, while a source checkout schedules the
 * interpreter that is running us plus an entry file. Both are absolute, so
 * neither needs its own directory on the agent's PATH. See `programs()` —
 * everything else here takes the argv it produces and does not care which
 * shape it got.
 *
 * **A laptop is asleep at 06:00.** That is the normal case. macOS Power Nap can
 * start a calendar job during a short battery DarkWake, where `caffeinate -s`
 * is not honoured. Starting Aula and Claude there consumes the trigger but
 * cannot finish the brief.
 *
 * The launchd job therefore starts the coordinator, a cheap process that waits
 * without a sleep assertion. It is suspended with the Mac and resumes on the
 * next wake; only a full wake or AC power starts the expensive child under
 * caffeinate.
 *
 * **Three triggers, and each covers what the others cannot.** `launchd.plist(5)`
 * is explicit about the difference, and it is the opposite way round from what
 * the names suggest:
 *
 * - `StartCalendarInterval` fires at the slot times, and — unlike cron — when
 *   the machine was asleep at one, launchd starts the job the next time it
 *   wakes, coalescing several missed firings into one. **This is the wake-up
 *   catch-up.** A laptop shut at 06:00 and opened at 14:00 gets its overview
 *   then, from this key alone.
 * - `RunAtLoad` covers the machine that was switched *off* rather than asleep.
 *   Nothing is loaded to be overdue in that case, so the agent runs once when
 *   it is bootstrapped at login.
 * - `StartInterval` is missed outright while the machine sleeps — the man page
 *   says so, blaming kqueue(3) — so it catches up nothing. What it does cover
 *   is the awake machine whose coordinator died: the slot's calendar firing is
 *   spent, the next is twelve hours away, and this brings it back within the
 *   quarter hour. It replaced a grid of retry entries that said the same thing
 *   at thirteen times the size.
 *
 * Firing often only works because arriving is cheap. Every scheduled
 * invocation passes `--catch-up`, and `slotIsSettled` answers from the state
 * file without opening a socket, so the overwhelmingly common firing — the one
 * where this slot's brief is already written — costs one file read and an exit.
 *
 * launchd runs one instance of a label at a time, so a firing that lands while
 * the coordinator is still retrying is dropped rather than doubled.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRIEF_DIR } from './brief/state.ts';
import { updateConfig } from './config.ts';
import { CliError, failWith, formatRemedy, UsageError } from './errors.ts';
import { claudeMissingRemedy } from './llm/claude.ts';
import { cliInvocation, cmd } from './runtime.ts';
import { clock, formatSlots, parseSlots, type Slot, SlotFormatError } from './slots.ts';

const LABEL = 'com.aula-cli.brief';
const TASK_NAME = 'aula-cli-brief';

/** The scheduled command. `--catch-up` is what makes the heartbeat below free. */
const RUN_ARGS = ['new', '--text', '--catch-up'];

/**
 * What the scheduler should run.
 *
 * Both shapes are the CLI invoking one of its own subcommands: `coordinator`
 * is the sleep-aware wrapper (macOS only), `direct` is the brief itself, for
 * schedulers that have no wrapper. Whether this process is a binary or a
 * checkout is already answered by `cliInvocation()`, and nothing else here
 * differs by mode.
 *
 * No working directory is set, in either mode. The scheduled job needs one
 * only if something resolves against it, and nothing does: `cliInvocation()`
 * names the entry file absolutely, imports resolve against the module rather
 * than the process, and every path the run reads or writes lives under
 * `~/.aula`. A checkout was given one for years on the theory that relative
 * imports needed it; they never did.
 */
export function programs(): {
  coordinator: string[];
  direct: string[];
} {
  const invocation = cliInvocation();
  return {
    coordinator: [...invocation, 'scheduled-run'],
    direct: [...invocation, ...RUN_ARGS],
  };
}

export const RETRY_EVERY_MINUTES = 15;
export const RETRY_FOR_MINUTES = 180;

/**
 * How often an awake machine re-asks whether the current slot still owes a
 * brief.
 *
 * The same fifteen minutes as the retry interval, and for the same reason: it
 * is the shortest wait that cannot overlap two model runs. It does not bound
 * how long a *sleeping* machine stays stale — `StartInterval` firings are
 * dropped during sleep, and it is `StartCalendarInterval` that fires on wake.
 */
export const HEARTBEAT_MINUTES = RETRY_EVERY_MINUTES;

export function parseAt(raw: string | undefined): Slot[] {
  try {
    return parseSlots(raw);
  } catch (err) {
    if (err instanceof SlotFormatError) {
      throw new UsageError(
        `--at wants 24h clock times like 06:00 or 06:00,18:00 (${err.message}).`,
      );
    }
    throw err;
  }
}

/**
 * The agent's PATH: where `claude` lives, then the standard trail.
 *
 * `claude` is the only thing the scheduled run has to find by name — the CLI
 * itself is started by absolute path either way — so it is the only directory
 * worth baking. Deduplicated, because the usual install location is already on
 * the standard trail.
 */
export function agentPath(claude: string): string {
  const dirs = [
    dirname(claude),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(dirs)].join(':');
}

const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The brief knobs travel into the agent the same way PATH does: launchd
 * starts with a bare environment, so an `export AULA_BRIEF_EFFORT=high` in a
 * shell profile would silently never reach the 06:00 run. Anything set when
 * `aula schedule` runs is baked in; re-run `aula schedule` to change it.
 * `AULA_TOKEN_KEY` is deliberately NOT baked — the plist is plaintext, and
 * writing the key there would undo the point of keeping it out of the
 * filesystem.
 */
const BAKED_ENV = [
  'AULA_BRIEF_MODEL',
  'AULA_BRIEF_EFFORT',
  'AULA_BRIEF_TIMEOUT',
  'AULA_BRIEF_REPAIR_MODEL',
  'AULA_BRIEF_REPAIR_EFFORT',
  'AULA_TOOL_MODEL',
  'AULA_TOOL_EFFORT',
  'AULA_CACHE_TTL',
];

/**
 * The launchd agent: every day, at each slot, plus the two catch-up triggers.
 * Exported for tests.
 *
 * A `StartCalendarInterval` dict with no `Weekday` key fires every day of the
 * week. The previous version wrote one dict per weekday per retry — sixty-five
 * of them, every single one carrying `Weekday` 1 through 5 — which is why
 * nothing was generated on a Saturday or a Sunday.
 */
export function buildPlist(opts: {
  slots: Slot[];
  /** Argv the agent runs — see `programs()`. */
  program: string[];
  path: string;
  logPath: string;
  env?: Record<string, string>;
}): string {
  const entry = (slot: Slot) =>
    `    <dict><key>Hour</key><integer>${slot.hour}</integer>` +
    `<key>Minute</key><integer>${slot.minute}</integer></dict>`;
  const program = opts.program;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${opts.path}</string>
    <key>HOME</key><string>${homedir()}</string>
${Object.entries(opts.env ?? {})
  .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
  .join('\n')}
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${opts.slots.map(entry).join('\n')}
  </array>
  <key>StartInterval</key><integer>${HEARTBEAT_MINUTES * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${opts.logPath}</string>
  <key>StandardErrorPath</key><string>${opts.logPath}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/**
 * The Task Scheduler creation arguments. Exported for tests.
 *
 * Task Scheduler has no equivalent of launchd's list of calendar times, so the
 * heartbeat is the whole schedule here: a daily task starting at the first slot
 * and repeating every `HEARTBEAT_MINUTES` for a full day. Which of those firings
 * does anything is decided the same way it is on macOS — by the slot the clock
 * is in and whether it already has a brief.
 */
export function schtasksCreateArgs(opts: { slots: Slot[]; program: string[] }): string[] {
  const first = opts.slots[0] ?? { hour: 6, minute: 0 };
  return [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/TN',
    TASK_NAME,
    '/TR',
    // The executable is always quoted (Windows paths contain spaces), and so
    // is any argument that contains one. Flags and subcommands stay bare, or
    // schtasks reads the whole string as one program name.
    opts.program
      .map((arg, index) => (index === 0 || arg.includes(' ') ? `"${arg}"` : arg))
      .join(' '),
    '/ST',
    clock(first),
    '/RI',
    String(HEARTBEAT_MINUTES),
    '/DU',
    '24:00',
  ];
}

/**
 * The cron equivalent: a `PATH` assignment, then the heartbeat. Exported for
 * tests.
 *
 * The `PATH=` line is not decoration. cron starts jobs with a PATH of roughly
 * `/usr/bin:/bin`, and the brief is written by spawning `claude` *by name*, so
 * without it every run gets as far as looking for `claude`, fails, and says so
 * only to the local mail spool. crontab reads leading `NAME=value` lines as
 * environment for the entries beneath them, so one line fixes it.
 *
 * `flock -n` is the other load-bearing part: cron, unlike launchd and Task
 * Scheduler, will happily start a second copy of a job while the first is still
 * running, and a heartbeat that fires every quarter of an hour into a brief
 * that occasionally takes longer than that would do exactly that.
 */
export function cronLines(slots: Slot[], claude: string): string[] {
  const { direct } = programs();
  const command = direct.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
  const lock = join(BRIEF_DIR, 'schedule.lock');
  return [
    `PATH=${agentPath(claude)}`,
    `# ${formatSlots(slots)} — the slot the clock is in decides whether a firing does anything`,
    `*/${HEARTBEAT_MINUTES} * * * * flock -n ${lock} ${command}`,
  ];
}

function sh(argv: string[]): { ok: boolean; err: string } {
  const result = Bun.spawnSync({ cmd: argv, stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, err: result.stderr.toString().trim() };
}

export function runSchedule(opts: { remove: boolean; at?: string }): number {
  const slots = parseAt(opts.at);
  switch (process.platform) {
    case 'darwin':
      return opts.remove ? removeDarwin() : installDarwin(slots);
    case 'win32':
      return opts.remove ? removeWindows() : installWindows(slots);
    default: {
      if (opts.remove) {
        rememberSlots(undefined);
        console.error(
          'No scheduler integration for this platform — remove the lines with: crontab -e',
        );
      } else {
        const claude = resolveClaude();
        if (!claude) return claudeMissing();
        rememberSlots(slots);
        console.error(
          'No scheduler integration for this platform. The cron equivalent (a quarter-hourly',
        );
        console.error('heartbeat that does nothing once the current slot has its overview):');
        for (const line of cronLines(slots, claude)) console.error(`  ${line}`);
      }
      return 0;
    }
  }
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/**
 * Put the times where every other process can read them.
 *
 * The scheduler bakes them into a plist, but a plist cannot be asked what it
 * says, and the run that a heartbeat starts has to know which slot it is in
 * before it can decide whether to do anything. Config is the only surface both
 * sides share.
 */
function rememberSlots(slots: Slot[] | undefined): void {
  updateConfig({ briefSchedule: slots?.map(clock) });
}

/**
 * Where `claude` is, or null after explaining why there is nowhere.
 *
 * Every scheduled run writes the brief with `claude`, so installing the job
 * without it buys the user a 06:00 alarm that dies on ENOENT and reports it
 * only to a log file nobody reads. The old code was quieter than that: it
 * dropped `claude` from the baked PATH and installed anyway, which looks
 * exactly like success. Better to refuse now, while somebody is watching.
 *
 * Returns the path rather than a boolean so the caller bakes the very location
 * it just checked, instead of resolving the name a second time.
 */
function resolveClaude(): string | null {
  const claude = Bun.which('claude');
  if (claude) return claude;
  // The same remedy the run itself raises, so a user who hits this at install
  // time and a user who hits it at 06:00 are told the same thing.
  console.error(formatRemedy(claudeMissingRemedy(cmd('schedule'))));
  return null;
}

/**
 * The exit for a machine with no `claude` on it, after {@link resolveClaude}
 * has printed the remedy. 5, as `calendars` already answers the same state: a
 * missing program is still missing on the next attempt. This was 1.
 */
function claudeMissing(): number {
  return failWith({
    code: 'SETUP',
    message: 'Claude Code is not installed, and the overview is written by running it.',
    hint: 'Install Claude Code, then run the command again.',
  });
}

function installDarwin(slots: Slot[]): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new CliError('BUG', 'Could not determine the user id.');
  }
  const claude = resolveClaude();
  if (!claude) return claudeMissing();
  const { coordinator } = programs();
  const plist = plistPath();
  const logPath = join(BRIEF_DIR, 'launchd.log');
  const env = Object.fromEntries(
    BAKED_ENV.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(BRIEF_DIR, { recursive: true });
  // Before the agent, so the run that `RunAtLoad` starts a moment from now
  // reads the times it was just installed with rather than the previous ones.
  rememberSlots(slots);
  writeFileSync(
    plist,
    buildPlist({
      slots,
      program: coordinator,
      logPath,
      path: agentPath(claude),
      env,
    }),
  );

  // Replace-if-present: bootout fails harmlessly when nothing was loaded.
  sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]);
  const loaded = sh(['launchctl', 'bootstrap', `gui/${uid}`, plist]);
  if (!loaded.ok) {
    // `SETUP`: launchd refused the agent on this machine, which no retry of the
    // same command changes.
    throw new CliError('SETUP', `launchctl bootstrap failed: ${loaded.err}`);
  }
  console.log(`Installed — every day at ${formatSlots(slots)}, ${retryNote()}.`);
  console.log('  Missed a slot because the Mac was off or asleep? It catches up on the next wake.');
  console.log(
    '  On macOS, model work waits for a full wake or AC power, then holds the Mac awake.',
  );
  if (Object.keys(env).length > 0) {
    console.log(
      `  baked:   ${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );
  }
  console.log(`  agent:   ${plist}`);
  console.log(`  log:     ${logPath}`);
  console.log(`  run now: launchctl kickstart -k gui/${uid}/${LABEL}`);
  console.log('  remove:  aula schedule --remove');
  console.log(`The location of \`claude\` is baked into the agent — re-run \`${cmd('schedule')}\``);
  console.log('if it ever moves.');
  return 0;
}

function retryNote(): string {
  return `retrying every ${RETRY_EVERY_MINUTES} min for up to ${RETRY_FOR_MINUTES / 60} h while a slot's overview is incomplete`;
}

function removeDarwin(): number {
  const uid = process.getuid?.();
  const wasLoaded = uid !== undefined && sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]).ok;
  const hadPlist = existsSync(plistPath());
  if (hadPlist) rmSync(plistPath());
  rememberSlots(undefined);
  console.log(wasLoaded || hadPlist ? 'The schedule is removed.' : 'No schedule was installed.');
  return 0;
}

function installWindows(slots: Slot[]): number {
  // Windows tasks inherit PATH from the registry, so `claude` does not need
  // baking — but a `claude` that is not installed at all still fails at 06:00.
  if (!resolveClaude()) return claudeMissing();
  // No coordinator on Windows: Task Scheduler has its own wake handling, so
  // the task runs the brief directly.
  const { direct } = programs();
  rememberSlots(slots);
  const created = sh(['schtasks', ...schtasksCreateArgs({ slots, program: direct })]);
  if (!created.ok) {
    throw new CliError('SETUP', `schtasks failed: ${created.err}`);
  }
  console.log(`Installed — every day at ${formatSlots(slots)}, as Scheduled Task "${TASK_NAME}".`);
  console.log(
    `  The task fires every ${HEARTBEAT_MINUTES} min and does nothing unless the current slot still owes an overview.`,
  );
  console.log(`  output: ${BRIEF_DIR}`);
  console.log('  remove: aula schedule --remove');
  console.log('The task runs while you are logged in; `claude` resolves from your user PATH.');
  return 0;
}

function removeWindows(): number {
  const removed = sh(['schtasks', '/Delete', '/TN', TASK_NAME, '/F']);
  rememberSlots(undefined);
  console.log(removed.ok ? 'The schedule is removed.' : 'No schedule was installed.');
  return 0;
}
