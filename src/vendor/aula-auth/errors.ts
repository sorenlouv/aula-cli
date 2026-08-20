/**
 * Base error for everything the auth package throws.
 * Subclass for distinct failure modes that callers should branch on.
 *
 * Named "flow" deliberately: `client.ts` has its own `AulaAuthError` meaning
 * "the stored credentials no longer authenticate", while this hierarchy means
 * "the MitID/SAML login flow itself failed". The CLI's top-level handler maps
 * both to exit code 2.
 */
export class AulaAuthFlowError extends Error {
  override readonly name: string = 'AulaAuthFlowError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

export class RedirectLoopError extends AulaAuthFlowError {
  override readonly name: string = 'RedirectLoopError';
  constructor(
    public readonly hops: number,
    public readonly lastUrl: string,
  ) {
    super(`Exceeded ${hops} redirect hops; stuck at ${lastUrl}`);
  }
}
