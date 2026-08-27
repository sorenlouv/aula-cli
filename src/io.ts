/**
 * Terminal output helpers, and the one way this CLI opens a browser.
 *
 * Everything here writes to **stderr**, never stdout. The CLI's stdout is a
 * data channel — JSON that gets piped and parsed — so progress and diagnostics
 * must not land in it.
 *
 * Nothing here reads stdin. The login page asks the only questions this CLI
 * has, so there is no prompt left to answer at the terminal.
 *
 * Adapted from aula-mcp's `apps/cli/src/io.ts` (MIT, Copyright (c) 2026 Casper
 * Juel); see src/vendor/aula-auth/LICENSE.
 */

import { stderr } from 'node:process';
import { errorMessage } from './validation.ts';

const useColour = stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);

export const fmt = {
  bold: (s: string) => paint('1', s),
  dim: (s: string) => paint('2', s),
  green: (s: string) => paint('32', s),
  red: (s: string) => paint('31', s),
  yellow: (s: string) => paint('33', s),
};

export function info(message: string): void {
  stderr.write(`${message}\n`);
}
export function ok(message: string): void {
  stderr.write(`${fmt.green('✓')} ${message}\n`);
}
export function warn(message: string): void {
  stderr.write(`${fmt.yellow('!')} ${message}\n`);
}
export function fail(message: string): void {
  stderr.write(`${fmt.red('✗')} ${message}\n`);
}

/** The per-platform "open this the way the user would" command. */
export function openCommand(target: string): string[] {
  if (process.platform === 'darwin') return ['open', target];
  // `start` is a cmd builtin, not a program, and its first quoted argument is
  // the window title — omitting the empty one makes it swallow the URL.
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '', target];
  return ['xdg-open', target];
}

/**
 * Hands a path or URL to the desktop's default handler.
 *
 * Fire-and-forget on purpose: whether a browser actually came up is not
 * something this process can find out, and every caller has already printed
 * the target so a headless machine still has somewhere to go.
 *
 * Which is also why the spawn is caught. `Bun.spawn` throws *synchronously*
 * when the opener is not on PATH, and that is the ordinary state of the
 * machines this tool is built for — a headless Linux box or a container
 * without xdg-utils. Letting it escape would make `login` fatal on exactly
 * those hosts, and fatal after the loopback page is already listening: the
 * throw would skip `finish()`, and `Bun.serve` would then hold the event loop
 * open forever on a process that has already printed its stack.
 */
export function openInBrowser(target: string): void {
  try {
    Bun.spawn(openCommand(target));
  } catch (err) {
    warn(`Could not open a browser: ${errorMessage(err)}`);
    warn('Open the address above yourself.');
  }
}
