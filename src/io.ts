/**
 * Interactive terminal helpers for the login flow.
 *
 * Everything here writes to **stderr**, never stdout. The CLI's stdout is a
 * data channel — JSON that gets piped and parsed — so prompts and progress must
 * not land in it.
 *
 * Adapted from aula-mcp's `apps/cli/src/io.ts` (MIT, Copyright (c) 2026 Casper
 * Juel); see src/vendor/aula-auth/LICENSE.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { UsageError } from './errors.ts';

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
 */
export function openInBrowser(target: string): void {
  Bun.spawn(openCommand(target));
}

/**
 * Asks, and gives up rather than waiting forever for an answer that cannot come.
 *
 * `rl.question()` on a stdin that is already at EOF never settles — it does not
 * throw, it does not return empty, it simply waits. That is how an agent
 * running `login` in a captured shell gets a two-minute silence and a killed
 * process instead of an error. Piped input is still perfectly good input, so
 * this cannot key off `isTTY`; it keys off the stream ending, which is the
 * actual difference between "nobody is there" and "the answer arrived early".
 *
 * `hint` is what the caller would have to be told to get past this without a
 * terminal — it is the whole value of failing here rather than hanging.
 */
export async function prompt(question: string, hint?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  const noInput = new AbortController();
  rl.once('close', () => noInput.abort());
  try {
    return (await rl.question(`${question} `, { signal: noInput.signal })).trim();
  } catch (err) {
    if (!noInput.signal.aborted) throw err;
    throw new UsageError(
      [
        `Needed an answer to "${question}" and stdin is empty.`,
        hint ?? 'Run this in a terminal, or pipe the answer in.',
      ].join(' '),
    );
  } finally {
    rl.close();
  }
}

/**
 * Reads a line without echoing it.
 *
 * Raw mode is the only way to stop the terminal echoing keystrokes, and it also
 * turns off the line editing and Ctrl-C handling we would otherwise get for
 * free — hence handling backspace and ETX by hand. The `finally` restoring
 * cooked mode matters: bailing out mid-prompt otherwise leaves the user's shell
 * with echo disabled.
 */
export async function promptSecret(question: string, hint?: string): Promise<string> {
  if (!stdin.isTTY) return prompt(question, hint);

  stderr.write(`${question} `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const done = (finish: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      finish();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case '\r':
          case '\n':
            return done(() => resolve(value));
          case '\x03': // Ctrl-C
            return done(() => reject(new Error('Cancelled.')));
          case '\x7f': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // Ignore the rest of the C0 range: arrow keys and friends arrive as
            // escape sequences and would otherwise be typed into the password.
            if (char >= ' ') value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** Numbered picker. Returns the 1-based index the caller's API expects. */
export async function selectFromList(question: string, options: string[]): Promise<number> {
  info(question);
  options.forEach((label, i) => info(`  ${fmt.bold(String(i + 1))}) ${label}`));

  for (;;) {
    const answer = await prompt(
      `Choose 1-${options.length}:`,
      'This MitID user has more than one identity, and picking one needs a terminal.',
    );
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) return choice;
    warn(`Enter a number between 1 and ${options.length}.`);
  }
}
