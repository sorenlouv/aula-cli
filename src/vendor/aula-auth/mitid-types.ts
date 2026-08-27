/**
 * MitID JSON wire types. Names mirror the on-the-wire field names exactly so
 * spotting drift between the spec and our parsing is easy.
 *
 * MitID's API generally wraps every "primitive" value in `{ value: T }`, even
 * for scalar fields like `randomA`. We replicate that.
 */

/**
 * Aula's three "human" authenticator names. CODE_TOKEN is what Aula calls
 * "kodeviser" in Danish — the physical hardware code generator.
 *
 * This CLI drives only APP: a kodeviser login ends in a password prompt and a
 * six-digit code nobody is at the terminal to type. CODE_TOKEN and PASSWORD
 * stay in the union anyway, because this is a *wire* type — MitID nominates
 * whichever authenticator the account defaults to, so both names still arrive
 * on the very first `/next` for accounts we then refuse.
 */
export type MitidAuthenticatorType = 'APP' | 'CODE_TOKEN' | 'PASSWORD';

/**
 * The Python reference uses 'TOKEN' as the human alias for combination IDs S1.
 * Aula UI calls this "kodeviser". We use 'CODE_TOKEN' for clarity but keep a
 * mapping for combination IDs.
 */
export const COMBINATION_ID_TO_AUTHENTICATOR: Readonly<Record<string, MitidAuthenticatorType>> =
  Object.freeze({
    S4: 'APP', // App + MitID chip
    S3: 'APP',
    L2: 'APP',
    S1: 'CODE_TOKEN',
  });

export const AUTHENTICATOR_TO_COMBINATION_ID: Readonly<Record<MitidAuthenticatorType, string>> =
  Object.freeze({
    // Only the APP row is ever looked up now; the other two are here because
    // the record is keyed by the full wire union, and dropping them would say
    // those authenticators do not exist rather than that we do not drive them.
    APP: 'S3',
    CODE_TOKEN: 'S1',
    PASSWORD: '', // reached implicitly after CODE_TOKEN
  });

/**
 * Normalize the server's raw `authenticatorType` string into our human type.
 *
 * The MitID backend labels the hardware code generator ("kodeviser") as
 * `TOKEN`, while we call it `CODE_TOKEN` everywhere (matching Aula's UI and
 * the combination-id table above). This still matters even though the
 * kodeviser flow is gone: MitID nominates the account's default authenticator
 * before anyone has chosen one, so `TOKEN` reaches this function for every
 * kodeviser-first account. Refusing to name it here would turn "your MitID has
 * no app" into an unexplained parse error one line earlier.
 *
 * `APP` and `PASSWORD` pass through unchanged. Unknown values fail here, at
 * the wire boundary, rather than entering the client under a false union type.
 */
export function normalizeAuthenticatorType(raw: string): MitidAuthenticatorType {
  if (raw === 'TOKEN') return 'CODE_TOKEN';
  if (raw === 'APP' || raw === 'CODE_TOKEN' || raw === 'PASSWORD') return raw;
  throw new Error(`Unknown MitID authenticator type: ${raw}`);
}

/** Returned by `GET /authentication-sessions/{id}` on construction. */
export interface AuthenticationSessionResponse {
  brokerSecurityContext: string;
  serviceProviderName: string;
  referenceTextHeader: string;
  referenceTextBody: string;
}

/** Shape of `nextAuthenticator` — the only field we actually use from /next. */
export interface NextAuthenticator {
  authenticatorType: string;
  authenticatorSessionFlowKey: string;
  eafeHash: string;
  authenticatorSessionId: string;
}

/**
 * Raw response from `POST /next`. Errors shaped per Python parse path.
 *
 * The `| null` on the optional fields is not defensive typing — it is what
 * MitID sends. A `/next` that reports an error carries `"nextAuthenticator":
 * null` and `"nextSessionId": null` rather than omitting them, and treating
 * that as "absent" is what previously turned an ordinary CAP008 into a parse
 * failure. Anything optional here should be assumed nullable until the wire
 * says otherwise.
 */
export interface NextAuthenticatorResponse {
  nextAuthenticator?: NextAuthenticator | null;
  combinations?: ReadonlyArray<{
    id: string;
    combinationItems: ReadonlyArray<{ name: string }>;
  }> | null;
  errors?: ReadonlyArray<{
    errorCode?: string | null;
    message?: string | null;
    userMessage?: {
      text?: { text?: string | null } | null;
      supportErrorId?: string | null;
    } | null;
  }> | null;
  /** Set after PASSWORD prove; named differently because MitID. */
  nextSessionId?: string | null;
}

/** Returned by `POST /init-auth` (APP). Polled via `pollUrl`. */
export interface AppInitAuthResponse {
  pollUrl?: string | null;
  ticket?: string | null;
  errorCode?: string | null;
}

/** Single poll response shape. We discriminate on `status`. */
export interface AppPollResponse {
  status: string;
  channelBindingValue?: string | null;
  updateCount?: number | null;
  confirmation?: boolean | null;
  payload?: {
    response: string;
    responseSignature: string;
  } | null;
}

/** Common SRP init response (the APP authenticator's `init`). */
export interface SrpInitResponse {
  srpSalt: { value: string };
  randomB: { value: string };
}

/** Response from `PUT /finalization`. */
export interface FinalizationResponse {
  authorizationCode?: string | null;
}

/** What `identifyAsUser` returns to the caller — the available auth methods. */
export type AvailableAuthenticators = Partial<Record<MitidAuthenticatorType, string>>;
