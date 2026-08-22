import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCommand } from './io.ts';

const CLI = join(import.meta.dir, 'cli.ts');

/** Runs `fn` as if on another platform. */
function asPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('openCommand', () => {
  const url = 'http://127.0.0.1:54321/2f4a-token';

  test('uses each platform\'s opener', () => {
    expect(asPlatform('darwin', () => openCommand(url))).toEqual(['open', url]);
    expect(asPlatform('linux', () => openCommand(url))).toEqual(['xdg-open', url]);
    // `start` is a cmd builtin whose first quoted argument is the window title.
    // Without the empty one it takes the URL as the title and opens nothing.
    expect(asPlatform('win32', () => openCommand(url))).toEqual(['cmd', '/c', 'start', '', url]);
  });

  test('never loses the target', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(asPlatform(platform, () => openCommand(url)).at(-1)).toBe(url);
    }
  });
});

describe('prompting with nothing attached', () => {
  // The regression this exists for: `readline.question()` on a stdin already at
  // EOF never settles. `login` then sat there until whatever was driving it
  // gave up — two silent minutes in an agent, and no clue what went wrong.
  test('fails immediately instead of waiting for an answer that cannot come', async () => {
    const proc = Bun.spawn(['bun', CLI, 'login'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AULA_DIR: mkdtempSync(join(tmpdir(), 'aula-io-')) },
    });

    const kill = setTimeout(() => proc.kill(), 10_000);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(kill);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('stdin is empty');
    // The whole value of failing here is saying what to do instead.
    expect(stderr).toContain('--username');
  }, 15_000);
});
