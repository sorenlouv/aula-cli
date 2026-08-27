import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliInvocation } from './runtime.ts';
import {
  agentPath,
  buildPlist,
  cronLines,
  parseAt,
  programs,
  RETRY_EVERY_MINUTES,
  RETRY_FOR_MINUTES,
  scheduleTimes,
  schtasksCreateArgs,
} from './schedule.ts';

describe('parseAt', () => {
  test('defaults to the 06:30 weekday-morning slot', () => {
    expect(parseAt(undefined)).toEqual({ hour: 6, minute: 30 });
  });

  test('accepts a 24h time, with or without a leading zero', () => {
    expect(parseAt('7:05')).toEqual({ hour: 7, minute: 5 });
    expect(parseAt('19:00')).toEqual({ hour: 19, minute: 0 });
  });

  test('rejects what a clock cannot show', () => {
    for (const bad of ['25:00', '06:60', 'kl-syv', '6.30', '630']) {
      expect(() => parseAt(bad)).toThrow(/--at wants/);
    }
  });
});

describe('scheduleTimes', () => {
  test('the run, then a retry every 15 minutes for three hours', () => {
    const times = scheduleTimes({ hour: 6, minute: 30 });
    expect(times[0]).toEqual({ hour: 6, minute: 30 });
    expect(times[1]).toEqual({ hour: 6, minute: 45 });
    expect(times.at(-1)).toEqual({ hour: 9, minute: 30 });
    expect(times).toHaveLength(1 + RETRY_FOR_MINUTES / RETRY_EVERY_MINUTES);
  });

  test('stops at midnight rather than wrapping into another weekday', () => {
    const times = scheduleTimes({ hour: 23, minute: 30 });
    expect(times.map((t) => `${t.hour}:${t.minute}`)).toEqual(['23:30', '23:45']);
  });
});

describe('buildPlist', () => {
  const plist = buildPlist({
    at: { hour: 6, minute: 30 },
    program: ['/opt/homebrew/bin/bun', '/repo/src/cli.ts', 'scheduled-run'],
    path: '/opt/homebrew/bin:/usr/bin',
    logPath: '/tmp/launchd.log',
  });

  test('runs the wake-aware coordinator through bun, weekdays only', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('<string>scheduled-run</string>');
    // The coordinator holds no sleep assertion; only the child it starts does.
    expect(plist).not.toContain('<string>/usr/bin/caffeinate</string>');
    // Weekdays 1-5, one calendar entry per weekday per time — weekends stay quiet.
    const times = scheduleTimes({ hour: 6, minute: 30 }).length;
    expect(plist.match(/<key>Weekday<\/key>/g)).toHaveLength(5 * times);
    expect(plist).not.toContain('<key>Weekday</key><integer>0</integer>');
    expect(plist).not.toContain('<key>Weekday</key><integer>6</integer>');
    expect(plist).toContain(
      '<key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer>',
    );
    expect(plist).toContain(
      '<key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer>',
    );
  });

  test('bakes brief knobs into the agent, XML-escaped', () => {
    const withEnv = buildPlist({
      at: { hour: 6, minute: 30 },
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
      at: { hour: 6, minute: 30 },
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
  test('a weekday-only task with a zero-padded start time, repeating through the retry window', () => {
    const args = schtasksCreateArgs({
      at: { hour: 6, minute: 5 },
      program: ['C:\\bun\\bun.exe', 'C:\\repo\\src\\cli.ts', 'new', '--text', '--catch-up'],
    });
    expect(args).toContain('/SC');
    expect(args[args.indexOf('/SC') + 1]).toBe('WEEKLY');
    expect(args[args.indexOf('/D') + 1]).toBe('MON,TUE,WED,THU,FRI');
    expect(args[args.indexOf('/ST') + 1]).toBe('06:05');
    expect(args[args.indexOf('/RI') + 1]).toBe(String(RETRY_EVERY_MINUTES));
    expect(args[args.indexOf('/DU') + 1]).toBe('03:00');
    const tr = args[args.indexOf('/TR') + 1] ?? '';
    expect(tr).toContain('"C:\\bun\\bun.exe"');
    expect(tr).toContain('new --text --catch-up');
  });

  // Paths are quoted because Windows puts spaces in them; bare flags must not
  // be, or schtasks reads the whole string as one program name.
  test('quotes the executable but not the flags', () => {
    const args = schtasksCreateArgs({
      at: { hour: 6, minute: 30 },
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

  // The scheduled run must stay idempotent: --catch-up is what makes the retry
  // lines free once the morning has already succeeded.
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

  test('the run, then quarter-hour retries for three hours, weekdays only, all with --catch-up', () => {
    const lines = cronLines({ hour: 6, minute: 30 }, CLAUDE);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^30 6 \* \* 1-5 .* new --text --catch-up$/);
    expect(lines[2]).toMatch(/^\*\/15 7-9 \* \* 1-5 .* --catch-up$/);
  });

  /**
   * cron's own PATH is roughly `/usr/bin:/bin`, and the brief is written by
   * spawning `claude` by name. Without this line the job runs every weekday
   * and fails every weekday, reporting it only to the local mail spool.
   */
  test('leads with a PATH assignment that can find claude', () => {
    const [path = ''] = cronLines({ hour: 6, minute: 30 }, CLAUDE);
    expect(path.startsWith('PATH=')).toBe(true);
    expect(path).toContain('/Users/x/.local/bin');
  });

  /**
   * cron runs with a bare PATH, so a bare `bun` in the command resolves to
   * nothing and the line fails silently every weekday. Both the interpreter
   * and the entry point are absolute for that reason.
   */
  test('names its interpreter and entry point absolutely', () => {
    const [, run = ''] = cronLines({ hour: 6, minute: 30 }, CLAUDE);
    const command = run.replace(/^\S+ \S+ \S+ \S+ \S+ /, '');
    expect(command.startsWith('/') || command.startsWith('cd /')).toBe(true);
    expect(command).not.toMatch(/(^| )bun /);
  });

  test('no retry line when the run is in the last hour of the day', () => {
    // PATH plus the single run.
    expect(cronLines({ hour: 23, minute: 30 }, CLAUDE)).toHaveLength(2);
  });
});
