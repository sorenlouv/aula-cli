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
