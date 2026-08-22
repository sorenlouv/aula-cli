/**
 * Raised when the *user* got the invocation wrong — an unknown child, an
 * unparseable date. These print as a plain message; a stack trace would only
 * bury the part they need to read.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Raised when there are no usable credentials — no stored MitID login, or one
 * that cannot be decrypted. Prints as a plain message with the fix (run
 * `login`); exit code 2, so the skill can tell "log in again" from a bug.
 */
export class AulaSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AulaSessionError';
  }
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
