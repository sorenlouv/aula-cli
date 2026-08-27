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

import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

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
 * One command, runnable as printed, from wherever the reader happens to be.
 *
 * Every "run this to fix it" string has to go through here, and the bar is
 * higher than just naming the right program. A binary user has no `bun` and no
 * checkout, so `bun run login` is an instruction they cannot carry out — but
 * `bun src/cli.ts login` is no better for someone running a checkout through a
 * wrapper on their PATH, because that path resolves against a directory they
 * are not in. Both fail at the same moment: when a session has just expired and
 * the message is the only thing they have to go on. Hence the full invocation,
 * absolute on both sides.
 */
export function cmd(args: string): string {
  const [executable = process.execPath, ...rest] = cliInvocation();
  return [shortestSpelling(executable), ...rest, args].join(' ');
}

/**
 * The shortest spelling of `executable` that still runs — its bare name when
 * PATH resolves that name back to this very file, and the absolute path
 * otherwise.
 *
 * SETUP.md installs the binary as `aula` and puts its directory on PATH, so
 * `aula login` is both what the user was taught to type and what they will
 * recognise. Handing them `/Users/x/.local/bin/aula login` instead is correct
 * but reads like a different program.
 *
 * The resolution has to compare files, not names. If some other `aula` sits
 * earlier on PATH, printing the bare name would point the user at a program
 * this process is not — so that case falls back to the unambiguous path.
 * `realpath` on both sides because an installed CLI is very often a symlink
 * into a versioned directory.
 *
 * `deps` is injected so both branches are testable without a PATH to arrange.
 */
export function shortestSpelling(
  executable: string,
  deps: {
    which: (name: string) => string | null;
    realpath: (path: string) => string;
  } = { which: (name) => Bun.which(name), realpath: realpathSync },
): string {
  const name = basename(executable);
  const found = deps.which(name);
  if (!found) return executable;
  try {
    return deps.realpath(found) === deps.realpath(executable) ? name : executable;
  } catch {
    // A path that cannot be resolved is a path we should not be shortening.
    return executable;
  }
}
