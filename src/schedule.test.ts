import { describe, expect, test } from 'bun:test';
import {
  agentPath,
  buildPlist,
  cronLines,
  parseAt,
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
    bun: '/opt/homebrew/bin/bun',
    path: '/opt/homebrew/bin:/usr/bin',
    logPath: '/tmp/launchd.log',
  });

  test('runs `new --text --catch-up` through bun, under caffeinate, weekdays only', () => {
    expect(plist).toContain('<string>/usr/bin/caffeinate</string>');
    expect(plist).toContain('<string>-s</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('<string>new</string>');
    expect(plist).toContain('<string>--text</string>');
    expect(plist).toContain('<string>--catch-up</string>');
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
      bun: '/opt/homebrew/bin/bun',
      path: '/usr/bin',
      logPath: '/tmp/launchd.log',
      env: {
        AULA_BRIEF_EFFORT: 'high',
        AULA_BRIEF_MODEL: 'a<b&c',
        AULA_TOOL_MODEL: 'haiku',
        AULA_TOOL_EFFORT: 'low',
      },
    });
    expect(withEnv).toContain('<key>AULA_BRIEF_EFFORT</key><string>high</string>');
    expect(withEnv).toContain('<key>AULA_BRIEF_MODEL</key><string>a&lt;b&amp;c</string>');
    expect(withEnv).toContain('<key>AULA_TOOL_MODEL</key><string>haiku</string>');
    expect(withEnv).toContain('<key>AULA_TOOL_EFFORT</key><string>low</string>');
  });

  test('bakes the PATH and the log destination into the agent', () => {
    expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<string>/tmp/launchd.log</string>');
    expect(plist).toContain('com.aula-cli.brief');
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
});

describe('schtasksCreateArgs', () => {
  test('a weekday-only task with a zero-padded start time, repeating through the retry window', () => {
    const args = schtasksCreateArgs({ at: { hour: 6, minute: 5 }, bun: 'C:\\bun\\bun.exe' });
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
});

describe('cronLines', () => {
  test('the run, then quarter-hour retries for three hours, weekdays only, all with --catch-up', () => {
    const lines = cronLines({ hour: 6, minute: 30 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^30 6 \* \* 1-5 cd .* && bun src\/cli\.ts new --text --catch-up$/);
    expect(lines[1]).toMatch(/^\*\/15 7-9 \* \* 1-5 .* --catch-up$/);
  });

  test('no retry line when the run is in the last hour of the day', () => {
    expect(cronLines({ hour: 23, minute: 30 })).toHaveLength(1);
  });
});
