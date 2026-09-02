/**
 * `aula schedule` — generate the overview automatically every weekday morning.
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
 * **A laptop is asleep at 06:30.** That is the normal case. macOS Power Nap can
 * start a calendar job during a short battery DarkWake, where `caffeinate -s`
 * is not honoured. Starting Aula and Claude there consumes the trigger but
 * cannot finish the brief.
 *
 * The launchd job therefore starts the coordinator, a cheap process that waits
 * without a sleep assertion. It is suspended with the Mac and resumes on the
 * next wake; only a full wake or AC power starts the expensive child under
 * caffeinate. Calendar retries remain as crash recovery.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRIEF_DIR } from './brief/state.ts';
import { formatRemedy, UsageError } from './errors.ts';
import { claudeMissingRemedy } from './llm/claude.ts';
import { cliInvocation, cmd } from './runtime.ts';

const LABEL = 'com.aula-cli.brief';
const TASK_NAME = 'aula-cli-brief';

/** The scheduled command. `--catch-up` is what makes the retries below free. */
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

export type At = { hour: number; minute: number };

export function parseAt(raw: string | undefined): At {
  const value = raw ?? '06:30';
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new UsageError(`--at wants a 24h clock time like 06:30 (got "${value}").`);
  }
  return { hour, minute };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (at: At) => `${pad(at.hour)}:${pad(at.minute)}`;

/**
 * The main time plus the retries that follow it, stopping at midnight rather
 * than wrapping into a different weekday. Exported for tests.
 */
export function scheduleTimes(at: At): At[] {
  const times: At[] = [];
  for (let offset = 0; offset <= RETRY_FOR_MINUTES; offset += RETRY_EVERY_MINUTES) {
    const total = at.hour * 60 + at.minute + offset;
    if (total >= 24 * 60) break;
    times.push({ hour: Math.floor(total / 60), minute: total % 60 });
  }
  return times;
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
 * shell profile would silently never reach the 06:30 run. Anything set when
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

/** The launchd agent, weekdays only. Exported for tests. */
export function buildPlist(opts: {
  at: At;
  /** Argv the agent runs — see `programs()`. */
  program: string[];
  path: string;
  logPath: string;
  env?: Record<string, string>;
}): string {
  const entry = (weekday: number, at: At) =>
    `    <dict><key>Weekday</key><integer>${weekday}</integer>` +
    `<key>Hour</key><integer>${at.hour}</integer>` +
    `<key>Minute</key><integer>${at.minute}</integer></dict>`;
  const times = scheduleTimes(opts.at);
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
${[1, 2, 3, 4, 5].flatMap((weekday) => times.map((at) => entry(weekday, at))).join('\n')}
  </array>
  <key>StandardOutPath</key><string>${opts.logPath}</string>
  <key>StandardErrorPath</key><string>${opts.logPath}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/**
 * The Task Scheduler creation arguments, weekdays only, repeating through the
 * same retry window (`/RI` every N minutes, `/DU` for how long). Exported for
 * tests.
 */
export function schtasksCreateArgs(opts: { at: At; program: string[] }): string[] {
  const hours = Math.floor(RETRY_FOR_MINUTES / 60);
  const minutes = RETRY_FOR_MINUTES % 60;
  return [
    '/Create',
    '/F',
    '/SC',
    'WEEKLY',
    '/D',
    'MON,TUE,WED,THU,FRI',
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
    clock(opts.at),
    '/RI',
    String(RETRY_EVERY_MINUTES),
    '/DU',
    `${pad(hours)}:${pad(minutes)}`,
  ];
}

/**
 * The cron equivalent: a `PATH` assignment, the run, then retries on the
 * quarter hours through the following three hours. Exported for tests.
 *
 * The `PATH=` line is not decoration. cron starts jobs with a PATH of roughly
 * `/usr/bin:/bin`, and the brief is written by spawning `claude` *by name*, so
 * without it every weekday run gets as far as looking for `claude`, fails, and
 * says so only to the local mail spool. crontab reads leading `NAME=value`
 * lines as environment for the entries beneath them, so one line fixes it.
 */
export function cronLines(at: At, claude: string): string[] {
  const { direct } = programs();
  const command = direct.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
  const from = at.hour + 1;
  const to = Math.min(23, at.hour + RETRY_FOR_MINUTES / 60);
  return [
    `PATH=${agentPath(claude)}`,
    `${at.minute} ${at.hour} * * 1-5 ${command}`,
    ...(from <= to ? [`*/${RETRY_EVERY_MINUTES} ${from}-${to} * * 1-5 ${command}`] : []),
  ];
}

function sh(argv: string[]): { ok: boolean; err: string } {
  const result = Bun.spawnSync({ cmd: argv, stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, err: result.stderr.toString().trim() };
}

export function runSchedule(opts: { remove: boolean; at?: string }): number {
  const at = parseAt(opts.at);
  switch (process.platform) {
    case 'darwin':
      return opts.remove ? removeDarwin() : installDarwin(at);
    case 'win32':
      return opts.remove ? removeWindows() : installWindows(at);
    default: {
      if (opts.remove) {
        console.error(
          'No scheduler integration for this platform — remove the lines with: crontab -e',
        );
      } else {
        const claude = resolveClaude();
        if (!claude) return 1;
        console.error(
          'No scheduler integration for this platform. The cron equivalent (the run, then',
        );
        console.error('the retries that do nothing once the day is complete):');
        for (const line of cronLines(at, claude)) console.error(`  ${line}`);
      }
      return 0;
    }
  }
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function retryNote(at: At): string {
  const last = scheduleTimes(at).at(-1) ?? at;
  return `retrying every ${RETRY_EVERY_MINUTES} min until ${clock(last)} while the day's overview is incomplete`;
}

/**
 * Where `claude` is, or null after explaining why there is nowhere.
 *
 * Every scheduled run writes the brief with `claude`, so installing the job
 * without it buys the user a 06:30 alarm that dies on ENOENT and reports it
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
  // time and a user who hits it at 06:30 are told the same thing.
  console.error(formatRemedy(claudeMissingRemedy(cmd('schedule'))));
  return null;
}

function installDarwin(at: At): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    console.error('Could not determine the user id.');
    return 1;
  }
  const claude = resolveClaude();
  if (!claude) return 1;
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
  writeFileSync(
    plist,
    buildPlist({
      at,
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
    console.error(`launchctl bootstrap failed: ${loaded.err}`);
    return 1;
  }
  console.log(`Installed — every weekday at ${clock(at)}, ${retryNote(at)}.`);
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

function removeDarwin(): number {
  const uid = process.getuid?.();
  const wasLoaded = uid !== undefined && sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]).ok;
  const hadPlist = existsSync(plistPath());
  if (hadPlist) rmSync(plistPath());
  console.log(
    wasLoaded || hadPlist ? 'The weekday schedule is removed.' : 'No schedule was installed.',
  );
  return 0;
}

function installWindows(at: At): number {
  // Windows tasks inherit PATH from the registry, so `claude` does not need
  // baking — but a `claude` that is not installed at all still fails at 06:30.
  if (!resolveClaude()) return 1;
  // No coordinator on Windows: Task Scheduler has its own wake handling, so
  // the task runs the brief directly.
  const { direct } = programs();
  const created = sh(['schtasks', ...schtasksCreateArgs({ at, program: direct })]);
  if (!created.ok) {
    console.error(`schtasks failed: ${created.err}`);
    return 1;
  }
  console.log(
    `Installed — every weekday at ${clock(at)}, ${retryNote(at)}, as Scheduled Task "${TASK_NAME}".`,
  );
  console.log(`  output: ${BRIEF_DIR}`);
  console.log('  remove: aula schedule --remove');
  console.log('The task runs while you are logged in; `claude` resolves from your user PATH.');
  return 0;
}

function removeWindows(): number {
  const removed = sh(['schtasks', '/Delete', '/TN', TASK_NAME, '/F']);
  console.log(removed.ok ? 'The weekday schedule is removed.' : 'No schedule was installed.');
  return 0;
}
