/**
 * How this process was started: a compiled binary, or `bun src/cli.ts`.
 *
 * The two differ in exactly one way that matters — how you spell "run this CLI
 * again". A source checkout needs `<bun> <path/to/cli.ts>`; a binary is a
 * single argv entry. Everything that writes a command into a file somebody
 * else will run later (the launchd plist, a Scheduled Task, cron lines, the
 * installed skill) has to know which it is, and nothing else does.
 *
 * `bun build --compile` serves the bundle from a virtual filesystem rooted at
 * `/$bunfs`, so `import.meta.dir` is a path that exists for the module loader
 * and nowhere else. That is the signal: it is a property of the bundle rather
 * than of the machine, so it cannot be faked by an unusual install location
 * the way an argv0 or an execPath check could.
 */

import { join } from 'node:path';

/**
 * Set by `--define` at compile time, absent everywhere else. Declared rather
 * than imported: there is no such binding when Bun runs the source directly,
 * so every read has to be `typeof`-guarded.
 */
declare const BUILD_VERSION: string | undefined;

/** The bundle's virtual root — see the module comment. */
const BUNFS_PREFIX = '/$bunfs';

export function isCompiled(): boolean {
  return import.meta.dir.startsWith(BUNFS_PREFIX);
}

/**
 * The release this binary was built from, or `dev` from a source checkout.
 *
 * `typeof` first: referencing an undeclared identifier throws, and this is
 * called from `version`, which must work in both modes.
 */
export function buildVersion(): string {
  return typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev';
}

/**
 * The argv prefix that re-invokes this CLI.
 *
 * Compiled, `process.execPath` is the binary itself. From source it is the
 * `bun` that is running us, which is what makes the source form work without
 * requiring `bun` on PATH at all — the scheduled run gets the absolute path to
 * the interpreter that was in use when `aula schedule` ran.
 */
export function cliInvocation(): string[] {
  if (isCompiled()) return [process.execPath];
  return [process.execPath, join(import.meta.dir, 'cli.ts')];
}

/**
 * How the skill and the docs should spell a command for this installation:
 * `aula` when there is a binary on PATH, `bun src/cli.ts` from a checkout.
 *
 * The binary form is the absolute path rather than the bare name, because
 * nothing guarantees the reader's PATH includes wherever it was installed.
 */
export function commandPrefix(): string {
  return isCompiled() ? process.execPath : 'bun src/cli.ts';
}
