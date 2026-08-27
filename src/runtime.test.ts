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
import { cliInvocation, cmd, commandPrefix, isCompiled } from './runtime.ts';

describe('cmd', () => {
  test('every token that names a file is an absolute path', () => {
    const parts = cmd('login').split(' ');
    // The trailing argument is the subcommand; everything before it is the
    // invocation, and each piece of that has to resolve from any directory.
    const invocation = parts.slice(0, -1);
    expect(invocation.length).toBeGreaterThan(0);
    for (const part of invocation) {
      expect(isAbsolute(part)).toBe(true);
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

  test('is the full invocation this process would use to re-run itself', () => {
    expect(cmd('whoami')).toBe(`${cliInvocation().join(' ')} whoami`);
  });
});

describe('commandPrefix', () => {
  /**
   * Not a duplicate of `cmd`. The skill states the directory and tells the
   * agent to work from it, so the short relative spelling is correct there —
   * and it is what keeps sixteen command examples readable.
   */
  test('stays short for the skill, which supplies the directory', () => {
    expect(commandPrefix()).toBe(isCompiled() ? process.execPath : 'bun src/cli.ts');
  });
});
