/**
 * `aula schedule` — generate the overview automatically every weekday morning.
 *
 * Each platform gets its native "run this for the logged-in user" mechanism:
 * a launchd agent on macOS, a Task Scheduler task on Windows. Linux is cron,
 * systemd or neither depending on the distro, so rather than guessing wrong
 * quietly the command prints the one cron line that works everywhere.
 *
 * launchd starts jobs with a bare environment, so every tool the run needs —
 * bun, and `claude` with the node its plugin hooks shell out to — has its
 * directory baked into the agent's PATH at install time. That is why "re-run
 * `aula schedule` after switching node versions" is real advice: a hook whose
 * node has moved kills `claude` with exit 143 *after* the work is done, and
 * the brief silently loses its model output. Windows tasks inherit the user's
 * PATH from the registry, so nothing needs baking there.
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

/** The launchd agent, weekdays only. Exported for tests. */
export function buildPlist(opts: { at: At; bun: string; path: string; logPath: string }): string {
  const day = (weekday: number) =>
    `    <dict><key>Weekday</key><integer>${weekday}</integer>` +
    `<key>Hour</key><integer>${opts.at.hour}</integer>` +
    `<key>Minute</key><integer>${opts.at.minute}</integer></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bun}</string>
    <string>${ENTRY}</string>
    <string>new</string>
    <string>--text</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${opts.path}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${[1, 2, 3, 4, 5].map(day).join('\n')}
  </array>
  <key>StandardOutPath</key><string>${opts.logPath}</string>
  <key>StandardErrorPath</key><string>${opts.logPath}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/** The Task Scheduler creation arguments, weekdays only. Exported for tests. */
export function schtasksCreateArgs(opts: { at: At; bun: string }): string[] {
  return [
    '/Create', '/F',
    '/SC', 'WEEKLY',
    '/D', 'MON,TUE,WED,THU,FRI',
    '/TN', TASK_NAME,
    '/TR', `"${opts.bun}" "${ENTRY}" new --text`,
    '/ST', `${pad(opts.at.hour)}:${pad(opts.at.minute)}`,
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
        console.error('No scheduler integration for this platform — remove the line with: crontab -e');
      } else {
        console.error('No scheduler integration for this platform. The cron equivalent:');
        console.error(`  ${at.minute} ${at.hour} * * 1-5 cd ${REPO} && bun src/cli.ts new --text`);
      }
      return 1;
    }
  }
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function installDarwin(at: At): number {
  const bun = Bun.which('bun');
  const uid = process.getuid?.();
  if (!bun || uid === undefined) {
    console.error(bun ? 'Could not determine the user id.' : 'Could not find bun on PATH.');
    return 1;
  }
  const plist = plistPath();
  const logPath = join(BRIEF_DIR, 'launchd.log');
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
        ...(Bun.which('claude') ? { claude: Bun.which('claude') as string } : {}),
        ...(Bun.which('node') ? { node: Bun.which('node') as string } : {}),
      }),
    }),
  );

  // Replace-if-present: bootout fails harmlessly when nothing was loaded.
  sh(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]);
  const loaded = sh(['launchctl', 'bootstrap', `gui/${uid}`, plist]);
  if (!loaded.ok) {
    console.error(`launchctl bootstrap failed: ${loaded.err}`);
    return 1;
  }
  console.log(`Installed — every weekday at ${pad(at.hour)}:${pad(at.minute)}.`);
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
  console.log(`Installed — every weekday at ${pad(at.hour)}:${pad(at.minute)}, as Scheduled Task "${TASK_NAME}".`);
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
