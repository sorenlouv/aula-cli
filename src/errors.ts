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
