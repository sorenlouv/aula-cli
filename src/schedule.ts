/**
 * `aula schedule` — generate the overview automatically every weekday morning.
 *
 * Each platform gets its native "run this for the logged-in user" mechanism:
 * a launchd agent on macOS, a Task Scheduler task on Windows. Linux is cron,
 * systemd or neither depending on the distro, so rather than guessing wrong
 * quietly the command prints the cron lines that work everywhere.
 *
 * launchd starts jobs with a bare environment, so every tool the run needs —
 * bun, and `claude` with the node its plugin hooks shell out to — has its
 * directory baked into the agent's PATH at install time. That is why "re-run
 * `aula schedule` after switching node versions" is real advice: a hook whose
 * node has moved can cost `claude` its exit status *after* the work is done.
 * Windows tasks inherit the user's PATH from the registry, so nothing needs
 * baking there.
 *
 * **A laptop is asleep at 06:30.** That is the normal case, and it is where a
 * single trigger fails: macOS Power Nap wakes the machine for 180-second
 * maintenance windows, launchd starts the job in one of them, and the Mac goes
 * back to sleep with `claude -p` mid-request. Measured on two consecutive
 * mornings — the transcripts show the prompt sent and nothing ever coming back.
 * Two defences, both here:
 *
 * - The job runs under `caffeinate -i -s`, which holds the Mac awake for the
 *   few minutes the run takes. Honoured on AC power; on battery macOS may still
 *   sleep through it.
 * - The agent fires again every 15 minutes for three hours, and every trigger
 *   passes `--catch-up`: do nothing when today's overview is already complete,
 *   otherwise do it over. A morning that went right costs the retries nothing
 *   but a state-file read; a morning that went wrong gets fixed as soon as the
 *   Mac is properly awake.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRIEF_DIR } from './brief/state.ts';
import { UsageError } from './errors.ts';

const LABEL = 'com.aula-cli.brief';
const TASK_NAME = 'aula-cli-brief';
const REPO = join(import.meta.dir, '..');
const ENTRY = join(REPO, 'src', 'cli.ts');
const CAFFEINATE = '/usr/bin/caffeinate';

/** The scheduled command. `--catch-up` is what makes the retries below free. */
const RUN_ARGS = ['new', '--text', '--catch-up'];

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
 * The agent's PATH: the directories of the tools the run actually uses, then
 * the standard trail. Deduplicated so a claude and a node from the same dir do
 * not repeat it.
 */
export function agentPath(tools: { bun: string; claude?: string; node?: string }): string {
  const dirs = [
    tools.claude && dirname(tools.claude),
    tools.node && dirname(tools.node),
    dirname(tools.bun),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter((dir): dir is string => Boolean(dir));
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
const BAKED_ENV = ['AULA_BRIEF_MODEL', 'AULA_BRIEF_EFFORT', 'AULA_CACHE_TTL'];

/** The launchd agent, weekdays only. Exported for tests. */
export function buildPlist(opts: {
  at: At;
  bun: string;
  path: string;
  logPath: string;
  env?: Record<string, string>;
}): string {
  const entry = (weekday: number, at: At) =>
    `    <dict><key>Weekday</key><integer>${weekday}</integer>` +
    `<key>Hour</key><integer>${at.hour}</integer>` +
    `<key>Minute</key><integer>${at.minute}</integer></dict>`;
  const times = scheduleTimes(opts.at);
  const program = [CAFFEINATE, '-i', '-s', opts.bun, ENTRY, ...RUN_ARGS];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
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
export function schtasksCreateArgs(opts: { at: At; bun: string }): string[] {
  const hours = Math.floor(RETRY_FOR_MINUTES / 60);
  const minutes = RETRY_FOR_MINUTES % 60;
  return [
    '/Create', '/F',
    '/SC', 'WEEKLY',
    '/D', 'MON,TUE,WED,THU,FRI',
    '/TN', TASK_NAME,
    '/TR', `"${opts.bun}" "${ENTRY}" ${RUN_ARGS.join(' ')}`,
    '/ST', clock(opts.at),
    '/RI', String(RETRY_EVERY_MINUTES),
    '/DU', `${pad(hours)}:${pad(minutes)}`,
  ];
}

/**
 * The cron equivalent: the run, then retries on the quarter hours through the
 * following three hours. Exported for tests.
 */
export function cronLines(at: At): string[] {
  const command = `cd ${REPO} && bun src/cli.ts ${RUN_ARGS.join(' ')}`;
  const from = at.hour + 1;
  const to = Math.min(23, at.hour + RETRY_FOR_MINUTES / 60);
  return [
    `${at.minute} ${at.hour} * * 1-5 ${command}`,
    ...(from <= to ? [`*/${RETRY_EVERY_MINUTES} ${from}-${to} * * 1-5 ${command}`] : []),
  ];
}

function sh(cmd: string[]): { ok: boolean; err: string } {
  const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
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
        console.error('No scheduler integration for this platform — remove the lines with: crontab -e');
      } else {
        console.error('No scheduler integration for this platform. The cron equivalent (the run, then');
        console.error('the retries that do nothing once the day is complete):');
        for (const line of cronLines(at)) console.error(`  ${line}`);
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

function installDarwin(at: At): number {
  const bun = Bun.which('bun');
  const claude = Bun.which('claude');
  const node = Bun.which('node');
  const uid = process.getuid?.();
  if (!bun || uid === undefined) {
    console.error(bun ? 'Could not determine the user id.' : 'Could not find bun on PATH.');
    return 1;
  }
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
      bun,
      logPath,
      path: agentPath({
        bun,
        ...(claude ? { claude } : {}),
        ...(node ? { node } : {}),
      }),
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
  console.log('  The run holds the Mac awake (caffeinate); a Mac asleep on battery is what the retries are for.');
  if (Object.keys(env).length > 0) {
    console.log(`  baked:   ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  console.log(`  agent:   ${plist}`);
  console.log(`  log:     ${logPath}`);
  console.log(`  run now: launchctl kickstart -k gui/${uid}/${LABEL}`);
  console.log('  remove:  aula schedule --remove');
  console.log('Tool locations are baked into the agent — re-run `aula schedule` after');
  console.log('moving bun, claude or node (a version manager switch counts).');
  return 0;
}

function removeDarwin(): number {
  const uid = process.getuid?.();
  const wasLoaded = uid !== undefined && sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]).ok;
  const hadPlist = existsSync(plistPath());
  if (hadPlist) rmSync(plistPath());
  console.log(wasLoaded || hadPlist ? 'The weekday schedule is removed.' : 'No schedule was installed.');
  return 0;
}

function installWindows(at: At): number {
  const bun = Bun.which('bun');
  if (!bun) {
    console.error('Could not find bun on PATH.');
    return 1;
  }
  const created = sh(['schtasks', ...schtasksCreateArgs({ at, bun })]);
  if (!created.ok) {
    console.error(`schtasks failed: ${created.err}`);
    return 1;
  }
  console.log(
    `Installed — every weekday at ${clock(at)}, ${retryNote(at)}, as Scheduled Task "${TASK_NAME}".`,
  );
  console.log(`  output: ${BRIEF_DIR}`);
  console.log('  remove: aula schedule --remove');
  console.log('The task runs while you are logged in; bun and claude resolve from your user PATH.');
  return 0;
}

function removeWindows(): number {
  const removed = sh(['schtasks', '/Delete', '/TN', TASK_NAME, '/F']);
  console.log(removed.ok ? 'The weekday schedule is removed.' : 'No schedule was installed.');
  return 0;
}
