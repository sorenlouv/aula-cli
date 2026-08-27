import { describe, expect, test } from 'bun:test';
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
    program: ['/opt/homebrew/bin/bun', '/repo/src/scheduled-brief.ts'],
    workdir: '/repo',
    path: '/opt/homebrew/bin:/usr/bin',
    logPath: '/tmp/launchd.log',
  });

  test('runs the wake-aware coordinator through bun, weekdays only', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('/src/scheduled-brief.ts</string>');
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
      program: ['/opt/homebrew/bin/bun', '/repo/src/scheduled-brief.ts'],
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

  test('a source checkout gets a working directory', () => {
    expect(plist).toContain('<key>WorkingDirectory</key><string>/repo</string>');
  });

  /**
   * The compiled shape: one argv entry and a subcommand. Omitting
   * WorkingDirectory is deliberate rather than an oversight — a binary reads
   * and writes only ~/.aula, and naming a directory that may since have been
   * deleted is how a launchd job fails before it starts.
   */
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
  test('leads with the tools the run needs, deduplicated', () => {
    const path = agentPath({
      bun: '/opt/homebrew/bin/bun',
      claude: '/Users/x/.local/bin/claude',
      node: '/Users/x/.nvm/versions/node/v22.0.0/bin/node',
    });
    const dirs = path.split(':');
    expect(dirs[0]).toBe('/Users/x/.local/bin');
    expect(dirs[1]).toBe('/Users/x/.nvm/versions/node/v22.0.0/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
    // .local/bin appears once even though claude lives there and it is also a default.
    expect(dirs.filter((d) => d === '/Users/x/.local/bin')).toHaveLength(1);
  });

  test('tolerates a machine without claude or node on PATH', () => {
    const path = agentPath({ bun: '/usr/local/bin/bun' });
    expect(path.startsWith('/usr/local/bin')).toBe(true);
  });

  // A binary has no interpreter to locate, so nothing bun-shaped is baked.
  test('needs no bun directory at all', () => {
    const path = agentPath({ claude: '/Users/x/.local/bin/claude' });
    expect(path.split(':')[0]).toBe('/Users/x/.local/bin');
    expect(path).toContain('/usr/bin');
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
 * The runtime is injected so both branches are reachable from a source
 * checkout. Without that, the compiled shape — the one every end user gets —
 * would be the one shape the suite could never assert on.
 */
describe('programs', () => {
  const compiled = { compiled: true, invocation: ['/Users/x/.local/bin/aula'] };
  const source = { compiled: false, invocation: ['/opt/homebrew/bin/bun', '/repo/src/cli.ts'] };

  test('a binary runs its own subcommand and needs no working directory', () => {
    const { coordinator, direct, workdir } = programs(compiled);
    expect(coordinator).toEqual(['/Users/x/.local/bin/aula', 'scheduled-run']);
    expect(direct).toEqual(['/Users/x/.local/bin/aula', 'new', '--text', '--catch-up']);
    expect(workdir).toBeUndefined();
  });

  test('a checkout runs the coordinator file through its own interpreter', () => {
    const { coordinator, direct, workdir } = programs(source);
    expect(coordinator[0]).toBe('/opt/homebrew/bin/bun');
    expect(coordinator[1]).toContain('scheduled-brief.ts');
    expect(direct.slice(0, 2)).toEqual(['/opt/homebrew/bin/bun', '/repo/src/cli.ts']);
    expect(workdir).toBeTruthy();
  });

  // Whatever the shape, the scheduled run must stay idempotent: --catch-up is
  // what makes the retry lines free once the morning has already succeeded.
  test('every scheduled invocation passes --catch-up', () => {
    for (const runtime of [compiled, source]) {
      expect(programs(runtime).direct).toContain('--catch-up');
    }
  });
});

describe('cronLines', () => {
  test('the run, then quarter-hour retries for three hours, weekdays only, all with --catch-up', () => {
    const lines = cronLines({ hour: 6, minute: 30 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^30 6 \* \* 1-5 .* new --text --catch-up$/);
    expect(lines[1]).toMatch(/^\*\/15 7-9 \* \* 1-5 .* --catch-up$/);
  });

  /**
   * cron runs with a bare PATH, so a bare `bun` in the command resolves to
   * nothing and the line fails silently every weekday. Both the interpreter
   * and the entry point are absolute for that reason.
   */
  test('names its interpreter and entry point absolutely', () => {
    const [run = ''] = cronLines({ hour: 6, minute: 30 });
    const command = run.replace(/^\S+ \S+ \S+ \S+ \S+ /, '');
    expect(command.startsWith('/') || command.startsWith('cd /')).toBe(true);
    expect(command).not.toMatch(/(^| )bun /);
  });

  test('no retry line when the run is in the last hour of the day', () => {
    expect(cronLines({ hour: 23, minute: 30 })).toHaveLength(1);
  });
});
