import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliInvocation } from './runtime.ts';
import {
  agentPath,
  buildPlist,
  cronLines,
  HEARTBEAT_MINUTES,
  parseAt,
  programs,
  schtasksCreateArgs,
} from './schedule.ts';
import { DEFAULT_SLOTS } from './slots.ts';

describe('parseAt', () => {
  test('defaults to the morning and evening pair', () => {
    expect(parseAt(undefined)).toEqual(DEFAULT_SLOTS);
  });

  test('accepts one time or a list of them', () => {
    expect(parseAt('7:05')).toEqual([{ hour: 7, minute: 5 }]);
    expect(parseAt('19:00,06:00')).toEqual([
      { hour: 6, minute: 0 },
      { hour: 19, minute: 0 },
    ]);
  });

  // The format error is raised deep in the parser; what reaches the user has
  // to be a UsageError, or a mistyped flag prints a stack as if it were a bug.
  test('an unusable time is a usage error, not a crash', () => {
    for (const bad of ['25:00', '06:60', 'kl-syv', '6.30', '630']) {
      expect(() => parseAt(bad)).toThrow(/--at wants/);
    }
  });
});

describe('buildPlist', () => {
  const plist = buildPlist({
    slots: DEFAULT_SLOTS,
    program: ['/opt/homebrew/bin/bun', '/repo/src/cli.ts', 'scheduled-run'],
    path: '/opt/homebrew/bin:/usr/bin',
    logPath: '/tmp/launchd.log',
  });

  test('runs the wake-aware coordinator through bun', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('<string>scheduled-run</string>');
    // The coordinator holds no sleep assertion; only the child it starts does.
    expect(plist).not.toContain('<string>/usr/bin/caffeinate</string>');
  });

  /**
   * The regression this file exists to keep from coming back. Every one of the
   * sixty-five calendar entries the previous version wrote carried a `Weekday`
   * of 1 through 5, so the overview was simply never generated on a Saturday
   * or a Sunday, and the family's hosted page sat two days stale every single
   * weekend. A dict with no `Weekday` key fires every day.
   */
  test('one calendar entry per slot, every day of the week', () => {
    expect(plist).not.toContain('<key>Weekday</key>');
    expect(plist.match(/<key>Hour<\/key>/g)).toHaveLength(DEFAULT_SLOTS.length);
    expect(plist).toContain(
      '<key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer>',
    );
    expect(plist).toContain(
      '<key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer>',
    );
  });

  /**
   * The calendar entries alone cannot serve a laptop that was shut or shut
   * down over a slot: there is no trigger left until the next one. launchd
   * starts an overdue `StartInterval` as soon as the machine wakes, and
   * `RunAtLoad` covers the machine that was switched off entirely, so between
   * them every return to life is a chance to catch up.
   */
  test('carries the wake-up heartbeat as well as the exact times', () => {
    expect(plist).toContain(`<key>StartInterval</key><integer>${HEARTBEAT_MINUTES * 60}</integer>`);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
  });

  test('bakes brief knobs into the agent, XML-escaped', () => {
    const withEnv = buildPlist({
      slots: DEFAULT_SLOTS,
      program: ['/opt/homebrew/bin/bun', '/repo/src/cli.ts', 'scheduled-run'],
      path: '/usr/bin',
      logPath: '/tmp/launchd.log',
      env: {
        AULA_BRIEF_EFFORT: 'high',
        AULA_BRIEF_MODEL: 'a<b&c',
        AULA_BRIEF_REPAIR_MODEL: 'haiku',
        AULA_BRIEF_REPAIR_EFFORT: 'low',
        AULA_TOOL_MODEL: 'haiku',
        AULA_TOOL_EFFORT: 'low',
      },
    });
    expect(withEnv).toContain('<key>AULA_BRIEF_EFFORT</key><string>high</string>');
    expect(withEnv).toContain('<key>AULA_BRIEF_MODEL</key><string>a&lt;b&amp;c</string>');
    expect(withEnv).toContain('<key>AULA_BRIEF_REPAIR_MODEL</key><string>haiku</string>');
    expect(withEnv).toContain('<key>AULA_BRIEF_REPAIR_EFFORT</key><string>low</string>');
    expect(withEnv).toContain('<key>AULA_TOOL_MODEL</key><string>haiku</string>');
    expect(withEnv).toContain('<key>AULA_TOOL_EFFORT</key><string>low</string>');
  });

  test('bakes the PATH and the log destination into the agent', () => {
    expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<string>/tmp/launchd.log</string>');
    expect(plist).toContain('com.aula-cli.brief');
  });

  /**
   * Never, in either mode. Nothing the run touches resolves against the
   * working directory, and naming one that may since have been moved or
   * deleted is how a launchd job fails before it starts.
   */
  test('sets no working directory', () => {
    expect(plist).not.toContain('WorkingDirectory');
  });

  /** The compiled shape: one argv entry and a subcommand. */
  test('a binary runs itself, with no working directory and no interpreter', () => {
    const compiled = buildPlist({
      slots: DEFAULT_SLOTS,
      program: ['/Users/x/.local/bin/aula', 'scheduled-run'],
      path: '/Users/x/.local/bin:/usr/bin',
      logPath: '/tmp/launchd.log',
    });
    expect(compiled).toContain('<string>/Users/x/.local/bin/aula</string>');
    expect(compiled).toContain('<string>scheduled-run</string>');
    expect(compiled).not.toContain('WorkingDirectory');
    expect(compiled).not.toContain('.ts</string>');
  });
});

describe('agentPath', () => {
  test('leads with the directory claude was found in', () => {
    const dirs = agentPath('/somewhere/unusual/bin/claude').split(':');
    expect(dirs[0]).toBe('/somewhere/unusual/bin');
    expect(dirs).toContain('/usr/bin');
  });

  test('names the usual install location once, not twice', () => {
    const local = join(homedir(), '.local', 'bin');
    const dirs = agentPath(join(local, 'claude')).split(':');
    expect(dirs[0]).toBe(local);
    expect(dirs.filter((dir) => dir === local)).toHaveLength(1);
  });

  /**
   * The regression this whole shape exists to prevent. `aula schedule` runs
   * under a developer's PATH, which carries version managers, package manager
   * shims and toolchain directories the 06:30 run has no use for. None of them
   * may reach the agent: the scheduled run needs `claude`, and the CLI starts
   * by absolute path, so the result is fully determined by where claude is.
   */
  test('bakes claude and the standard trail, and nothing else', () => {
    expect(agentPath('/Users/x/.local/bin/claude').split(':')).toEqual([
      '/Users/x/.local/bin',
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]);
  });
});

describe('schtasksCreateArgs', () => {
  /**
   * Task Scheduler has no list of calendar times, so the heartbeat is the whole
   * schedule: a daily task from the first slot, repeating all day. Which
   * firings do anything is decided the same way it is on macOS — by the slot
   * the clock is in and whether it already has an overview.
   */
  test('a daily task that repeats through the whole day, every day', () => {
    const args = schtasksCreateArgs({
      slots: [
        { hour: 6, minute: 5 },
        { hour: 18, minute: 0 },
      ],
      program: ['C:\\bun\\bun.exe', 'C:\\repo\\src\\cli.ts', 'new', '--text', '--catch-up'],
    });
    expect(args[args.indexOf('/SC') + 1]).toBe('DAILY');
    expect(args).not.toContain('/D');
    expect(args[args.indexOf('/ST') + 1]).toBe('06:05');
    expect(args[args.indexOf('/RI') + 1]).toBe(String(HEARTBEAT_MINUTES));
    expect(args[args.indexOf('/DU') + 1]).toBe('24:00');
    const tr = args[args.indexOf('/TR') + 1] ?? '';
    expect(tr).toContain('"C:\\bun\\bun.exe"');
    expect(tr).toContain('new --text --catch-up');
  });

  // Paths are quoted because Windows puts spaces in them; bare flags must not
  // be, or schtasks reads the whole string as one program name.
  test('quotes the executable but not the flags', () => {
    const args = schtasksCreateArgs({
      slots: DEFAULT_SLOTS,
      program: ['C:\\Program Files\\aula.exe', 'new', '--text', '--catch-up'],
    });
    const tr = args[args.indexOf('/TR') + 1] ?? '';
    expect(tr).toBe('"C:\\Program Files\\aula.exe" new --text --catch-up');
  });
});

/**
 * Nothing here varies by install mode any more: the whole difference lives in
 * `cliInvocation()`, which has its own tests, and the working directory that
 * used to be the second difference turned out never to have been needed.
 */
describe('programs', () => {
  test('both shapes are this CLI running one of its own subcommands', () => {
    const { coordinator, direct } = programs();
    const invocation = cliInvocation();
    expect(coordinator).toEqual([...invocation, 'scheduled-run']);
    expect(direct.slice(0, invocation.length)).toEqual(invocation);
  });

  // The scheduled run must stay idempotent: --catch-up is what makes both the
  // retries and the quarter-hourly heartbeat free once this slot has already
  // succeeded. Without it the heartbeat would rebuild the page all day.
  test('every scheduled invocation passes --catch-up', () => {
    expect(programs().direct).toContain('--catch-up');
  });

  /**
   * launchd and cron both start jobs from a directory the user never chose, so
   * anything the run resolves relatively would break there. Nothing does — the
   * entry point is absolute, and every path the brief touches is under
   * `~/.aula` — which is why no working directory is set at all.
   */
  test('names its entry point absolutely, so no working directory is needed', () => {
    for (const arg of programs().coordinator.slice(0, -1)) {
      expect(arg.startsWith('/')).toBe(true);
    }
  });
});

describe('cronLines', () => {
  const CLAUDE = '/Users/x/.local/bin/claude';
  const heartbeat = () => cronLines(DEFAULT_SLOTS, CLAUDE).at(-1) ?? '';

  test('an every-day heartbeat, with --catch-up deciding whether it does anything', () => {
    const lines = cronLines(DEFAULT_SLOTS, CLAUDE);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('06:00, 18:00');
    expect(heartbeat()).toMatch(/^\*\/15 \* \* \* \* .* new --text --catch-up$/);
  });

  /**
   * cron, unlike launchd and Task Scheduler, starts a second copy of a job
   * while the first is still running. A quarter-hourly heartbeat into a brief
   * that occasionally takes longer than a quarter of an hour is exactly that
   * case, so the printed line holds a lock.
   */
  test('the heartbeat cannot overlap itself', () => {
    expect(heartbeat()).toContain('flock -n ');
  });

  /**
   * cron's own PATH is roughly `/usr/bin:/bin`, and the brief is written by
   * spawning `claude` by name. Without this line the job runs every day and
   * fails every day, reporting it only to the local mail spool.
   */
  test('leads with a PATH assignment that can find claude', () => {
    const [path = ''] = cronLines(DEFAULT_SLOTS, CLAUDE);
    expect(path.startsWith('PATH=')).toBe(true);
    expect(path).toContain('/Users/x/.local/bin');
  });

  /**
   * cron runs with a bare PATH, so a bare `bun` in the command resolves to
   * nothing and the line fails silently every day. Both the interpreter and the
   * entry point are absolute for that reason.
   */
  test('names its interpreter and entry point absolutely', () => {
    const command = heartbeat().replace(/^\S+ \S+ \S+ \S+ \S+ flock -n \S+ /, '');
    expect(command.startsWith('/')).toBe(true);
    expect(command).not.toMatch(/(^| )bun /);
  });
});
