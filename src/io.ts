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

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(`${question} `)).trim();
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
export async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return prompt(question);

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
    const answer = await prompt(`Choose 1-${options.length}:`);
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) return choice;
    warn(`Enter a number between 1 and ${options.length}.`);
  }
}
