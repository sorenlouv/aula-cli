/**
 * The fleet's shared exit-code table.
 *
 * These are the public contract, shared with `cvr`, `bolig`, `tinglysning` and
 * `dgs` and recorded in `../contract.json`; `contract.test.ts` asserts the two
 * agree. The codes used to be bare literals scattered through the catch chain
 * in `cli.ts`, which is why this repo was the only one with a contract entry
 * and no test for it — there was nothing stable to assert against.
 *
 * No 3. The shared table's exit 3 means "nothing, or too many things, matched —
 * refine using the candidates on stderr", and this tool is only ever called
 * with a name the user typed, so it has no candidate list to refine from.
 */
export const EXIT = {
  OK: 0,
  /** Aula is down or blocking, or a bug in this client. */
  ERROR: 1,
  /** Usage error: fix the command line. */
  USAGE: 2,
  /**
   * Resolved, but nothing to report: the read worked and came back empty. The
   * JSON body is still on stdout (`body_on: [0, 4]`), so a caller that only
   * parses it loses nothing.
   *
   * Declared here, in the skill and in the contract for as long as this table
   * has existed, and returned by nothing — `Object.values(EXIT)` was all that
   * kept the contract test green. Only ever on positive evidence of emptiness:
   * a read that failed, was cut, or came back partial is not "nothing".
   */
  NOTHING: 4,
  /** Credentials or setup — run `aula login`. Never fixed by retrying. */
  SETUP: 5,
} as const;

/**
 * The codes this tool can put on its error line — a subset of the contract's
 * `error_body.codes`, declared as `tools.aula.error_codes` and asserted against
 * it in both directions by `contract.test.ts`.
 *
 * No `BLOCKED`: Aula has no bot wall, waiting room or rate limit this client
 * has ever met. MitID's parallel-session detector is the nearest thing, and
 * that is a login that cannot proceed — `SETUP`.
 */
export const ERROR_CODES = ['USAGE', 'SETUP', 'NETWORK', 'UPSTREAM', 'BUG'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The exit each code leaves with. One direction only: an exit does not name a code. */
export const EXIT_FOR: Readonly<Record<ErrorCode, number>> = {
  USAGE: EXIT.USAGE,
  SETUP: EXIT.SETUP,
  NETWORK: EXIT.ERROR,
  UPSTREAM: EXIT.ERROR,
  BUG: EXIT.ERROR,
};

/** What the last line of stderr says on every exit that has no stdout body. */
export type ErrorLine = { code: ErrorCode; message: string; hint: string | null };

/**
 * An error that knows what its error line says.
 *
 * The code lives on the class rather than being worked out from the message
 * when it is printed. It used to be worked out from nothing at all: the catch
 * chain in `cli.ts` picked an exit by `instanceof`, and everything an agent
 * could branch on beyond that number was prose on stderr — including, for a
 * network failure, a raw stack that said "this is a bug" about a laptop with
 * no wifi.
 */
export class CliError extends Error {
  readonly errorCode: ErrorCode;
  /** The next action, in one line, or null when there is none to suggest. */
  readonly hint: string | null;

  constructor(errorCode: ErrorCode, message: string, hint: string | null = null) {
    super(message);
    this.name = 'CliError';
    this.errorCode = errorCode;
    this.hint = hint;
  }

  /** One sentence: the first line of the message, which every throw site writes to stand alone. */
  get headline(): string {
    return firstLineOf(this.message);
  }
}

/**
 * Raised when the *user* got the invocation wrong — an unknown child, an
 * unparseable date. These print as a plain message; a stack trace would only
 * bury the part they need to read.
 */
export class UsageError extends CliError {
  constructor(message: string, hint: string | null = null) {
    super('USAGE', message, hint);
    this.name = 'UsageError';
  }
}

/**
 * Raised when there are no usable credentials — no stored MitID login, or one
 * that cannot be decrypted. Exit code 5, so the skill can tell a missing
 * session from a bug.
 */
export class AulaSessionError extends CliError {
  constructor(message: string, hint: string | null = null) {
    super('SETUP', message, hint);
    this.name = 'AulaSessionError';
  }
}

/** The first line of a message: what an error line's one-sentence `message` holds. */
export function firstLineOf(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/**
 * The error line for anything that was thrown.
 *
 * A {@link CliError} answers for itself. Everything else is either the
 * vendored login flow's own hierarchy — which this repo does not edit, and
 * whose every failure is a credentials problem — or something nobody planned
 * for, which is what `BUG` means.
 */
export function errorLineFor(err: unknown, opts: { isAuthFlow?: boolean } = {}): ErrorLine {
  if (err instanceof CliError) {
    return { code: err.errorCode, message: err.headline, hint: err.hint };
  }
  const message = firstLineOf(err instanceof Error ? err.message : String(err));
  if (opts.isAuthFlow) return { code: 'SETUP', message, hint: null };
  return {
    code: 'BUG',
    message: message || 'aula-cli failed without saying why.',
    hint: 'This is a bug in aula-cli, not something you did; the stack above says where.',
  };
}

let errorLineWritten = false;

/**
 * Writes the error line: one line of compact JSON, the last thing on stderr.
 *
 * Every exit without a stdout body ends this way, TTY or not, so a caller can
 * take the last line of stderr and parse it instead of reading prose. It is on
 * stderr on purpose — an envelope on stdout would answer `jq '.threads|length'`
 * with 0, which is a failure reading as an answer.
 */
export function writeErrorLine(line: ErrorLine): void {
  errorLineWritten = true;
  console.error(JSON.stringify({ error: line }));
}

/** Prints the error line and returns the exit code that goes with it. */
export function failWith(line: ErrorLine): number {
  writeErrorLine(line);
  return EXIT_FOR[line.code];
}

/**
 * The last line of defence for the invariant above: a command that returned a
 * failing code without writing its line still ends with one.
 *
 * Every known site writes its own, with a message worth reading. This exists
 * because "always the last line" is what an agent is told to rely on, and a
 * forgotten `return 1` three commands from now must not be the exception.
 */
export function ensureErrorLine(exitCode: number): void {
  if (errorLineWritten || exitCode === EXIT.OK || exitCode === EXIT.NOTHING) return;
  const code: ErrorCode =
    exitCode === EXIT.USAGE ? 'USAGE' : exitCode === EXIT.SETUP ? 'SETUP' : 'UPSTREAM';
  writeErrorLine({ code, message: 'The command failed; the lines above say why.', hint: null });
}

/**
 * The shape of every error a user is meant to *act* on.
 *
 * An error message that only says what failed leaves the reader to work out
 * what to do about it, and the reader here is often Claude rather than a
 * person — so the fix travels with the failure rather than living in a README.
 *
 * `headline` is deliberately a standalone sentence: `doctor` reports only the
 * first line of an error, so that line has to be worth reading on its own.
 */
export type Remedy = {
  /** What went wrong, in the user's terms. One sentence, no jargon. */
  headline: string;
  /** Why it happened — only when knowing why changes what to do next. */
  detail?: string;
  /**
   * What to do next. Usually the line introducing {@link commands}, ending in a
   * colon, and then it sits directly on top of them with no blank line between,
   * because "Log in again:" and the command are one thought and reading them as
   * two costs the reader a beat. It stands alone when the fix is not a command
   * to run — "try again", "approve the prompt on your phone".
   */
  action?: string;
  /** Shell commands to try, in order. */
  commands?: string[];
  /** What to do when the commands do not help. */
  fallback?: string;
};

/**
 * A {@link Remedy}'s next action as the one line an error line's `hint` holds:
 * the action and the commands it introduces, or the fallback when there is
 * nothing to run.
 */
export function remedyHint(remedy: Remedy): string | null {
  if (remedy.commands?.length) {
    return `${remedy.action ?? 'Run:'} ${remedy.commands.join(' ; ')}`;
  }
  return remedy.action ?? remedy.fallback ?? null;
}

/**
 * Renders a {@link Remedy} as the plain multi-line text that becomes an
 * `Error.message`. No colour and no leading mark: those belong to whoever
 * prints it, and `message` also ends up in JSON output and in test assertions.
 */
export function formatRemedy(remedy: Remedy): string {
  const blocks: string[] = [remedy.headline];
  if (remedy.detail) blocks.push(wrap(remedy.detail));
  if (remedy.commands?.length) {
    const lines = remedy.commands.map((c) => `  ${c}`);
    blocks.push((remedy.action ? [remedy.action, ...lines] : lines).join('\n'));
  } else if (remedy.action) {
    // An action with nothing to run is still the thing the reader came for.
    // Dropping it silently — which this did until a code-20 remedy hit it —
    // leaves a failure whose whole point was "just try again" saying only that
    // something went wrong.
    blocks.push(wrap(remedy.action));
  }
  if (remedy.fallback) blocks.push(wrap(remedy.fallback));
  return blocks.join('\n\n');
}

/**
 * Greedy wrap at the terminal width, capped so the text stays readable on a
 * very wide window — prose set to 200 columns is worse than prose set to 76.
 * Lines the caller has already broken are preserved.
 */
export function wrap(text: string, width = wrapWidth()): string {
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

function wrapLine(line: string, width: number): string {
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  return out.join('\n');
}

function wrapWidth(): number {
  const columns = process.stderr.columns;
  if (typeof columns !== 'number' || columns < 20) return 76;
  return Math.min(columns - 4, 76);
}
