/**
 * The one property that matters about a remedy command: the reader can paste
 * it and it runs.
 *
 * This has now been got wrong twice. First `bun run login`, which a binary user
 * has no bun for. Then `bun src/cli.ts login`, which is fine from the repo root
 * and useless through a wrapper on PATH — the shape a developer actually uses.
 * Both were only visible by reading the output from the wrong directory, so the
 * assertion here is about the string itself rather than about a call site.
 */

import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { cliInvocation, cmd, shortestSpelling } from './runtime.ts';

describe('cmd', () => {
  test('no token is a path that depends on the current directory', () => {
    const parts = cmd('login').split(' ');
    // The trailing argument is the subcommand; everything before it is the
    // invocation, and each piece has to resolve from any directory. Two ways
    // to satisfy that: an absolute path, or a bare name with no separator at
    // all — which `shortestSpelling` only emits after confirming PATH resolves
    // it to this very file. A relative path like `src/cli.ts` is neither.
    const invocation = parts.slice(0, -1);
    expect(invocation.length).toBeGreaterThan(0);
    for (const part of invocation) {
      expect(isAbsolute(part) || !part.includes('/')).toBe(true);
    }
    expect(parts.at(-1)).toBe('login');
  });

  test('never emits the repo-relative entry point', () => {
    // The exact string that shipped in v0.2.1 and could not be run from
    // anywhere but the checkout.
    expect(cmd('login')).not.toContain('bun src/cli.ts');
    expect(cmd('login')).not.toMatch(/(^| )src\/cli\.ts/);
  });

  test('never tells anyone to use a package script', () => {
    // `bun run login` only exists for someone standing in the repository with
    // its package.json — the original bug.
    expect(cmd('login')).not.toContain('bun run ');
  });

  test('carries its arguments through verbatim', () => {
    expect(cmd('doctor --text')).toEndWith(' doctor --text');
    expect(cmd('raw profiles.getProfilesByLogin')).toEndWith(' raw profiles.getProfilesByLogin');
  });

  test('keeps every argument of the invocation, shortening only the executable', () => {
    const invocation = cliInvocation();
    const parts = cmd('whoami').split(' ');
    // Whatever the executable is spelled as, the entry file (source mode) and
    // the subcommand must survive untouched — shortening must not drop an
    // argument the CLI needs to start.
    expect(parts.slice(1, -1)).toEqual(invocation.slice(1));
    expect(parts.at(-1)).toBe('whoami');
    expect(parts[0]).toBe(shortestSpelling(invocation[0] ?? process.execPath));
  });
});

describe('shortestSpelling', () => {
  const deps = (which: string | null, links: Record<string, string> = {}) => ({
    which: () => which,
    realpath: (p: string) => links[p] ?? p,
  });

  test('uses the bare name when PATH resolves it to this same file', () => {
    const exe = '/Users/x/.local/bin/aula';
    expect(shortestSpelling(exe, deps(exe))).toBe('aula');
  });

  test('resolves through symlinks before deciding they are the same file', () => {
    // The native installer puts a symlink on PATH pointing into a versioned
    // directory, so the two paths differ until both are resolved.
    const link = '/Users/x/.local/bin/aula';
    const real = '/Users/x/.local/share/aula/versions/0.2.2/aula';
    expect(shortestSpelling(real, deps(link, { [link]: real }))).toBe('aula');
  });

  test('keeps the absolute path when the name is not on PATH at all', () => {
    const exe = '/tmp/downloads/aula';
    expect(shortestSpelling(exe, deps(null))).toBe(exe);
  });

  /**
   * The case that makes the whole thing safe. Printing `aula login` when some
   * other `aula` shadows this one would send the user to a different program,
   * which is worse than a long path.
   */
  test('keeps the absolute path when a different file shadows the name', () => {
    const exe = '/tmp/downloads/aula';
    expect(shortestSpelling(exe, deps('/usr/local/bin/aula'))).toBe(exe);
  });

  test('keeps the absolute path when a path cannot be resolved', () => {
    const exe = '/tmp/gone/aula';
    const throwing = {
      which: () => exe,
      realpath: () => {
        throw new Error('ENOENT');
      },
    };
    expect(shortestSpelling(exe, throwing)).toBe(exe);
  });
});
