import { describe, expect, test } from 'bun:test';
import { agentPath, buildPlist, parseAt, schtasksCreateArgs } from './schedule.ts';

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

describe('buildPlist', () => {
  const plist = buildPlist({
    at: { hour: 6, minute: 30 },
    bun: '/opt/homebrew/bin/bun',
    path: '/opt/homebrew/bin:/usr/bin',
    logPath: '/tmp/launchd.log',
  });

  test('runs `new --text` through bun, weekdays only', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('<string>new</string>');
    expect(plist).toContain('<string>--text</string>');
    // Weekdays 1-5, one calendar entry each — weekends stay quiet.
    expect(plist.match(/<key>Weekday<\/key>/g)).toHaveLength(5);
    expect(plist).toContain('<key>Hour</key><integer>6</integer>');
    expect(plist).toContain('<key>Minute</key><integer>30</integer>');
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
  test('a weekday-only task with a zero-padded start time', () => {
    const args = schtasksCreateArgs({ at: { hour: 6, minute: 5 }, bun: 'C:\\bun\\bun.exe' });
    expect(args).toContain('/SC');
    expect(args[args.indexOf('/SC') + 1]).toBe('WEEKLY');
    expect(args[args.indexOf('/D') + 1]).toBe('MON,TUE,WED,THU,FRI');
    expect(args[args.indexOf('/ST') + 1]).toBe('06:05');
    const tr = args[args.indexOf('/TR') + 1] ?? '';
    expect(tr).toContain('"C:\\bun\\bun.exe"');
    expect(tr).toContain('new --text');
  });
});
