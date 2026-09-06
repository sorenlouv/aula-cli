/**
 * Where a `claude` subprocess is started, and what it is allowed to reach.
 *
 * `claude` treats its working directory as a project, so an inherited one is a
 * decision nobody made. Under launchd that decision was `/`, and macOS spent
 * the family's morning asking them to approve `aula` for their Photos and
 * Music libraries — for a tool that reads a school website.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeClaude } from '../testing/fake-claude.ts';
import { spawnClaude } from './claude.ts';

/**
 * The scratch `$AULA_DIR` comes from the `bunfig.toml` preload, which runs
 * before any module here loads — and it has to, because `auth.ts` resolves
 * `AULA_DIR` once at module load and `claude.ts` derives this directory from
 * it. Setting the variable in this file would be too late and, worse, would
 * depend on which test file `bun` happened to load first.
 */
const CLAUDE_CWD = join(process.env.AULA_DIR ?? '', 'cwd');
const ORIGINAL_PATH = process.env.PATH;
const dirs: string[] = [];

beforeAll(() => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'aula-fake-claude-'));
  dirs.push(fakeDir);
  process.env.PATH = installFakeClaude(fakeDir).path;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_CWD_LOG;
});

afterAll(() => {
  if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The expected answer, resolved through symlinks: the shell's `pwd` reports a
 * physical path, and on macOS every temp directory is reached through
 * `/var` -> `/private/var`.
 */
const expectedCwd = () => realpathSync(CLAUDE_CWD);

/** Runs the fake once and returns the directory it was started in. */
async function cwdOfOneCall(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aula-cwd-log-'));
  dirs.push(dir);
  const log = join(dir, 'cwd.log');
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_CWD_LOG = log;
  await spawnClaude(['-p', 'hej'], { timeoutMs: 20_000 });
  return readFileSync(log, 'utf8').trim();
}

describe('the working directory a claude subprocess is given', () => {
  /**
   * The regression. Nothing here resolves against the working directory, which
   * is why the launchd agent deliberately sets none — but `claude` does, and it
   * was inheriting launchd's `/`. Sixty-eight sessions rooted at the boot volume
   * had accumulated in `~/.claude/projects/-` before anyone noticed why macOS
   * kept asking for the Photos library.
   */
  test('is ours, not whatever the parent happened to be in', async () => {
    expect(await cwdOfOneCall()).toBe(expectedCwd());
    expect(CLAUDE_CWD).not.toBe(process.cwd());
  });

  /**
   * The other half of the same problem: run by hand from some unrelated
   * checkout, `aula new` used to root the session in *that* project.
   */
  test('does not follow the shell the user happened to start it from', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'aula-elsewhere-'));
    dirs.push(elsewhere);
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(await cwdOfOneCall()).toBe(expectedCwd());
    } finally {
      process.chdir(before);
    }
  });

  /**
   * A session looks around its project. The point of this directory is that
   * there is nothing to find — so if anything ever starts writing here, the
   * mitigation is gone and this should fail.
   */
  test('is empty, so a session rooted there has nothing to look at', async () => {
    await cwdOfOneCall();
    expect(readdirSync(CLAUDE_CWD)).toEqual([]);
  });

  /**
   * `cache clear` and a hand-tidied `~/.aula` both remove empty directories,
   * and a missing cwd fails the spawn with an ENOENT indistinguishable from a
   * missing `claude` — a confusing way to lose every morning's overview.
   */
  test('is recreated when something has removed it', async () => {
    rmSync(CLAUDE_CWD, { recursive: true, force: true });
    expect(existsSync(CLAUDE_CWD)).toBe(false);
    expect(await cwdOfOneCall()).toBe(expectedCwd());
  });
});
