/**
 * MitID core-client port. Equivalent to Python's `BrowserClient`.
 *
 * APP completion uses the `/init → /prove → /verify → /next` dance — the
 * exact same sequence the Python reference does. We previously had a
 * speculative `/complete` path here, but it 404'd against real accounts and
 * appeared to corrupt server-side state when followed by the legacy fallback.
 * Removed; do not re-add without a clear positive signal that an account
 * actually needs it.
 *
 * The class is stateful: `identifyAsUser` selects an authenticator, then one
 * of the `authenticateWith*` methods drives that authenticator to completion,
 * then `finalize` returns the OAuth authorization code.
 *
 * Testing strategy: pure helpers (parseAuxResponse, password derivations) have
 * unit tests in mitid-client.test.ts; the HTTP-driven methods are exercised
 * only by a real login.
 */

import { Buffer } from 'node:buffer';
import {
  describeShape,
  errorMessage,
  isArrayOf,
  isNumber,
  isOptional,
  isRecord,
  isString,
} from '../../validation.ts';
import { sha256 } from './crypto.ts';
import { AulaAuthFlowError } from './errors.ts';
import type { AulaHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import {
  buildFlowProofMessage,
  type FlowProofContext,
  signFlowValueProof,
} from './mitid-flow-proof.ts';
import type { MitidPollResult } from './mitid-poll-machine.ts';
import { interpretPollResponse } from './mitid-poll-machine.ts';
import type {
  AppInitAuthResponse,
  AppPollResponse,
  AuthenticationSessionResponse,
  AvailableAuthenticators,
  FinalizationResponse,
  MitidAuthenticatorType,
  NextAuthenticator,
  NextAuthenticatorResponse,
  SrpInitResponse,
} from './mitid-types.ts';
import {
  AUTHENTICATOR_TO_COMBINATION_ID,
  COMBINATION_ID_TO_AUTHENTICATOR,
  normalizeAuthenticatorType,
} from './mitid-types.ts';
import { mitidUrls } from './mitid-urls.ts';
import { CustomSrp } from './srp.ts';

export class MitidError extends AulaAuthFlowError {
  override readonly name: string = 'MitidError';
}

export class MitidIdentityNotFoundError extends MitidError {
  override readonly name: string = 'MitidIdentityNotFoundError';
}

export class MitidParallelSessionError extends MitidError {
  override readonly name: string = 'MitidParallelSessionError';
}

export class MitidAuthenticatorUnavailableError extends MitidError {
  override readonly name: string = 'MitidAuthenticatorUnavailableError';
}

export interface MitidAuxData {
  /** Hex of the base64-decoded aux.coreClient.checksum. */
  clientHash: string;
  /** UUID for the MitID core authentication session. */
  authenticationSessionId: string;
}

/**
 * Parse the body of the `/login/mitid/initialize` response.
 *
 * The response has *two* layers of JSON encoding:
 *
 *   1. The HTTP body is a JSON-encoded **string** (it starts with `"` and
 *      ends with `"`, with `\"` escapes inside). One JSON.parse turns that
 *      into a regular JSON object string; we have to parse a second time
 *      to get the actual object. The Python reference handles this with
 *      `if isinstance(resp_init_json, str): json.loads(resp_init_json)`.
 *   2. Then the `Aux` field is itself base64-encoded JSON describing the
 *      MitID core client (checksum + authenticationSessionId).
 */
export function parseAuxResponse(rawBody: string | { Aux?: string }): MitidAuxData {
  let outer: unknown;
  if (typeof rawBody === 'string') {
    let parsed = parseJsonValue(rawBody, 'initialize response');
    // Layer 1: nemlog-in.mitid.dk returns the JSON object as a JSON string,
    // so the first parse hands back a string. Re-parse to get the object.
    if (typeof parsed === 'string') {
      parsed = parseJsonValue(parsed, 'double-encoded initialize response');
    }
    outer = parsed;
  } else {
    outer = rawBody;
  }
  if (!isRecord(outer) || typeof outer.Aux !== 'string' || !outer.Aux) {
    throw new MitidError('initialize response is missing `Aux` field');
  }

  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(outer.Aux, 'base64').toString('utf8'));
  } catch (e) {
    throw new MitidError('initialize response Aux is not valid base64-encoded JSON', { cause: e });
  }

  const coreClient = isRecord(inner) && isRecord(inner.coreClient) ? inner.coreClient : null;
  const parameters = isRecord(inner) && isRecord(inner.parameters) ? inner.parameters : null;
  const checksumB64 =
    coreClient && typeof coreClient.checksum === 'string' ? coreClient.checksum : undefined;
  const sessionId =
    parameters && typeof parameters.authenticationSessionId === 'string'
      ? parameters.authenticationSessionId
      : undefined;
  if (!checksumB64 || !sessionId) {
    throw new MitidError(
      'initialize response Aux is missing coreClient.checksum or authenticationSessionId',
    );
  }

  return {
    clientHash: Buffer.from(checksumB64, 'base64').toString('hex'),
    authenticationSessionId: sessionId,
  };
}

export interface AppAuthCallbacks {
  onOtp?: (otp: string) => void | Promise<void>;
  /** Called every time a new pair of QR JSON payloads is received. */
  onQr?: (qr: { qr1Json: string; qr2Json: string; updateCount: number }) => void | Promise<void>;
  onVerified?: () => void | Promise<void>;
  /** Called for every poll, even waiting/error — useful for verbose logs. */
  onPoll?: (result: MitidPollResult) => void | Promise<void>;
}

export interface MitidClientOptions {
  http: AulaHttpClient;
  aux: MitidAuxData;
  logger?: Logger;
}

export class MitidClient {
  readonly clientHash: string;
  readonly authenticationSessionId: string;

  private readonly http: AulaHttpClient;
  private readonly logger: Logger;

  // Populated by init():
  private brokerSecurityContext = '';
  private serviceProviderName = '';
  private referenceTextHeader = '';
  private referenceTextBody = '';

  // Populated by identifyAsUser / select-authenticator:
  private currentAuthenticatorType?: MitidAuthenticatorType;
  private currentAuthenticatorSessionFlowKey?: string;
  private currentAuthenticatorEafeHash?: string;
  private currentAuthenticatorSessionId?: string;

  // APP poll state:
  private pollUrl?: string;
  private ticket?: string;
  private authResponse?: string;
  /** Used by /verify to encrypt-sign the response with the SRP shared key. */
  private authResponseSignature?: string;

  // After authentication:
  private finalizationSessionId?: string;

  private constructor(opts: MitidClientOptions) {
    this.http = opts.http;
    this.logger = opts.logger ?? silentLogger;
    this.clientHash = opts.aux.clientHash;
    this.authenticationSessionId = opts.aux.authenticationSessionId;
  }

  /** Async constructor — fetches the session info immediately. */
  static async create(opts: MitidClientOptions): Promise<MitidClient> {
    const client = new MitidClient(opts);
    await client.init();
    return client;
  }

  private async init(): Promise<void> {
    const url = mitidUrls.authenticationSession(this.authenticationSessionId);
    const res = await this.http.request(url, { method: 'GET' });
    if (res.status !== 200) {
      throw new MitidError(`Failed to fetch authentication session (status ${res.status})`);
    }
    const session = parseAuthenticationSessionResponse(res.body);
    this.brokerSecurityContext = session.brokerSecurityContext;
    this.serviceProviderName = session.serviceProviderName;
    this.referenceTextHeader = session.referenceTextHeader;
    this.referenceTextBody = session.referenceTextBody;
    this.logger.info('mitid.session_loaded', {
      serviceProviderName: this.serviceProviderName,
    });
  }

  /** Step: PUT identityClaim, POST /next, return available authenticators. */
  async identifyAsUser(userId: string): Promise<AvailableAuthenticators> {
    const idClaimRes = await this.postJson(
      mitidUrls.authenticationSession(this.authenticationSessionId),
      {
        identityClaim: userId,
      },
      'PUT',
    );
    if (idClaimRes.status !== 200) {
      const errCode = safeJson(idClaimRes.body)?.errorCode;
      if (idClaimRes.status === 400 && errCode === 'control.identity_not_found') {
        throw new MitidIdentityNotFoundError(`MitID user "${userId}" does not exist`);
      }
      if (idClaimRes.status === 400 && errCode === 'control.authentication_session_not_found') {
        throw new MitidError('MitID authentication session not found');
      }
      throw new MitidError(
        `identifyAsUser failed (status ${idClaimRes.status}): ${idClaimRes.body.slice(0, 300)}`,
      );
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);
    if (!next.nextAuthenticator) throw new MitidError('identifyAsUser: missing nextAuthenticator');

    this.applyNextAuthenticator(next.nextAuthenticator);

    const available: AvailableAuthenticators = {};
    for (const combo of next.combinations ?? []) {
      const human = COMBINATION_ID_TO_AUTHENTICATOR[combo.id];
      if (!human) continue;
      available[human] = combo.combinationItems[0]?.name ?? '';
    }
    this.logger.info('mitid.authenticators_available', { available });
    return available;
  }

  // ============ APP authenticator ============================================

  private async startAppAuth(): Promise<{ pollUrl: string; ticket: string }> {
    await this.selectAuthenticator('APP');
    if (!this.currentAuthenticatorSessionId) {
      throw new MitidError('startAppAuth: no current authenticator session id');
    }

    const res = await this.postJson(mitidUrls.appInitAuth(this.currentAuthenticatorSessionId), {});
    if (res.status !== 200) {
      throw new MitidError(`startAppAuth failed (status ${res.status})`);
    }
    const json = parseAppInitAuthResponse(res.body);
    if (json.errorCode === 'auth.codeapp.authentication.parallel_sessions_detected') {
      throw new MitidParallelSessionError(
        'MitID detected a parallel app session. Wait a few minutes and try again.',
      );
    }
    if (json.errorCode) throw new MitidError(`MitID APP startup failed: ${json.errorCode}`);
    if (!json.pollUrl || !json.ticket) {
      throw new MitidError('startAppAuth response missing pollUrl or ticket');
    }
    this.pollUrl = json.pollUrl;
    this.ticket = json.ticket;
    return { pollUrl: json.pollUrl, ticket: json.ticket };
  }

  /** Single poll. Caller decides cadence. */
  private async pollAppAuth(): Promise<MitidPollResult> {
    if (!this.pollUrl || !this.ticket) {
      throw new MitidError('pollAppAuth called before startAppAuth');
    }
    const res = await this.postJson(this.pollUrl, { ticket: this.ticket });
    if (res.status !== 200) {
      return { kind: 'error', message: `Poll request failed (status ${res.status})` };
    }
    const interpreted = interpretPollResponse(parseAppPollResponse(res.body));
    if (interpreted.kind === 'completed') {
      this.authResponse = interpreted.response;
      this.authResponseSignature = interpreted.responseSignature;
    }
    return interpreted;
  }

  /**
   * Finish the APP flow via `/init → /prove → /verify → /next`.
   *
   *   • Derive SRP shared key K against the authenticator session.
   *   • POST /prove with M1 + a HEX-encoded flowValueProof; server returns M2
   *     which we verify via SRP stage 5.
   *   • PKCS#7-pad and AES-GCM-encrypt the responseSignature with K, POST
   *     to /verify (204 on success).
   *   • POST /next to advance the outer authenticationSession.
   *
   * `frontEndProcessingTime` is the wall-clock ms spent on cryptographic
   * work between /init and /verify. The Python reference sums per-stage
   * timers; we measure the same span as one elapsed value. Empty/zero
   * timings have been observed to upset the server-side bot heuristics, so
   * we send a real number.
   */
  private async completeAppAuth(): Promise<void> {
    if (
      !this.authResponse ||
      !this.authResponseSignature ||
      !this.currentAuthenticatorSessionId ||
      !this.currentAuthenticatorSessionFlowKey
    ) {
      throw new MitidError('completeAppAuth called before APP poll completed');
    }

    const sessionId = this.currentAuthenticatorSessionId;
    const flowKey = this.currentAuthenticatorSessionFlowKey;

    const cryptoStartMs = Date.now();

    const srp = new CustomSrp();
    const aHex = srp.stage1();

    const initRes = await this.postJson(mitidUrls.appInit(sessionId), {
      randomA: { value: aHex },
    });
    if (initRes.status !== 200) {
      throw new MitidError(`appInit failed (status ${initRes.status})`);
    }
    const init = parseSrpInitResponse(initRes.body);

    // SRP password input = SHA256(decoded(authResponse) || flowKey.utf8).hex
    const passwordHex = sha256(
      Buffer.concat([Buffer.from(this.authResponse, 'base64'), Buffer.from(flowKey, 'utf8')]),
    ).toString('hex');

    const { m1Hex, K } = srp.stage3({
      srpSaltHex: init.srpSalt.value,
      randomBHex: init.randomB.value,
      passwordHex,
      authSessionId: sessionId,
    });

    const flowProofMessage = buildFlowProofMessage(this.flowProofContext());
    const flowValueProofHex = signFlowValueProof(flowProofMessage, K, 'flowValues');

    const proveRes = await this.postJson(mitidUrls.appProve(sessionId), {
      m1: { value: m1Hex },
      flowValueProof: { value: flowValueProofHex },
    });
    if (proveRes.status !== 200) {
      throw new MitidError(
        `appProve failed (status ${proveRes.status}): ${proveRes.body.slice(0, 300)}`,
      );
    }
    const m2 = parseM2Response(proveRes.body);
    if (!m2 || !srp.stage5(m2)) {
      throw new MitidError('appProve: server M2 verification failed');
    }

    // The signature goes into AES-GCM *unpadded*. Python's reference
    // appends PKCS#7-style chars to the **base64 string**, then b64decodes
    // the result; b64decode silently discards those non-alphabet chars, so
    // the pad call is effectively a no-op there. GCM is a stream cipher and
    // doesn't need block padding — sending padded bytes makes the server
    // reject the auth on the next /next call ("Try again", no errorCode).
    const sigBytes = Buffer.from(this.authResponseSignature, 'base64');
    const encAuth = srp.authEnc(sigBytes).toString('base64');

    const frontEndProcessingTime = Date.now() - cryptoStartMs;

    const verifyRes = await this.postJson(mitidUrls.appVerify(sessionId), {
      encAuth,
      frontEndProcessingTime,
    });
    if (verifyRes.status !== 204) {
      throw new MitidError(
        `appVerify failed (status ${verifyRes.status}): ${verifyRes.body.slice(0, 300)}`,
      );
    }

    const next = await this.postNext('');
    this.assertNoFatalErrors(next);
    if (!next.nextSessionId) {
      throw new MitidError('appVerify succeeded but /next missing nextSessionId');
    }
    this.finalizationSessionId = next.nextSessionId;
    this.logger.info('mitid.app_authenticated', { frontEndProcessingTime });
  }

  /** Convenience: drive the APP authenticator end-to-end with UI callbacks.
   *  Polls every second (matching the Python reference) for up to 10 minutes. */
  async authenticateWithApp(callbacks: AppAuthCallbacks = {}): Promise<void> {
    const pollIntervalMs = 1_000;
    const deadline = Date.now() + 10 * 60 * 1_000;

    await this.startAppAuth();

    while (true) {
      if (Date.now() > deadline) throw new MitidError('APP poll timed out');

      const result = await this.pollAppAuth();
      await callbacks.onPoll?.(result);

      switch (result.kind) {
        case 'waiting':
          break;
        case 'otp':
          await callbacks.onOtp?.(result.otpCode);
          break;
        case 'qr':
          await callbacks.onQr?.({
            qr1Json: result.qr1Json,
            qr2Json: result.qr2Json,
            updateCount: result.updateCount,
          });
          break;
        case 'verified':
          await callbacks.onVerified?.();
          break;
        case 'completed':
          await this.completeAppAuth();
          return;
        case 'error':
          throw new MitidError(`APP poll error: ${result.message}`);
      }
      await sleep(pollIntervalMs);
    }
  }

  // ============ Finalization =================================================

  async finalize(): Promise<string> {
    if (!this.finalizationSessionId) {
      throw new MitidError('finalize called before authenticator completed');
    }
    const res = await this.http.request(mitidUrls.finalization(this.finalizationSessionId), {
      method: 'PUT',
    });
    if (res.status !== 200) {
      throw new MitidError(`finalize failed (status ${res.status})`);
    }
    const json = parseFinalizationResponse(res.body);
    if (!json.authorizationCode) {
      throw new MitidError('finalize response missing authorizationCode');
    }
    this.logger.info('mitid.finalized');
    return json.authorizationCode;
  }

  // ============ Internals ====================================================

  private async selectAuthenticator(target: MitidAuthenticatorType): Promise<void> {
    if (this.currentAuthenticatorType === target) return;
    const combinationId = AUTHENTICATOR_TO_COMBINATION_ID[target];
    if (!combinationId) {
      throw new MitidError(`Cannot select authenticator type ${target}`);
    }

    const next = await this.postNext(combinationId);
    this.assertNoFatalErrors(next);
    if (!next.nextAuthenticator) {
      throw new MitidError(`selectAuthenticator(${target}) missing nextAuthenticator`);
    }
    this.applyNextAuthenticator(next.nextAuthenticator);
    if (this.currentAuthenticatorType !== target) {
      throw new MitidAuthenticatorUnavailableError(
        `Asked for ${target} but server returned ${this.currentAuthenticatorType ?? 'none'}`,
      );
    }
  }

  private async postNext(combinationId: string): Promise<NextAuthenticatorResponse> {
    const res = await this.postJson(
      mitidUrls.authenticationSessionNext(this.authenticationSessionId),
      { combinationId },
    );
    if (res.status !== 200) {
      throw new MitidError(`POST /next failed (status ${res.status}): ${res.body.slice(0, 300)}`);
    }
    return parseNextAuthenticatorResponse(res.body);
  }

  private applyNextAuthenticator(next: NextAuthenticator): void {
    // The server may use a different label than our human type — notably it
    // returns `TOKEN` for the hardware kodeviser, which we call `CODE_TOKEN`.
    // This CLI never drives that authenticator, but MitID still nominates it:
    // on an account whose default is the kodeviser, `TOKEN` arrives here on the
    // very first `/next`. Normalising it is what turns that into "APP is not
    // available for this account" instead of a parse failure.
    let human: MitidAuthenticatorType;
    try {
      human = normalizeAuthenticatorType(next.authenticatorType);
    } catch (cause) {
      throw new MitidError(errorMessage(cause), { cause });
    }
    this.currentAuthenticatorType = human;
    this.currentAuthenticatorSessionFlowKey = next.authenticatorSessionFlowKey;
    this.currentAuthenticatorEafeHash = next.eafeHash;
    this.currentAuthenticatorSessionId = next.authenticatorSessionId;
  }

  private assertNoFatalErrors(next: NextAuthenticatorResponse): void {
    const err = next.errors?.[0];
    if (!err) return;
    const text =
      err.userMessage?.text?.text ?? err.message ?? err.errorCode ?? 'unknown MitID error';
    const supportId = err.userMessage?.supportErrorId;

    // CAP008 — MitID's parallel-sessions detector ("user ID in two places at
    // the same time"). Comes through as control.authenticator_cannot_be_started
    // with this specific supportErrorId. Surfaces as a dedicated typed error
    // so the CLI can show a friendly "wait 60 s, close other tabs" hint.
    if (
      supportId === 'CAP008' ||
      /two places at the same time/i.test(text) ||
      /parallel/i.test(text)
    ) {
      throw new MitidParallelSessionError(
        'MitID detected a parallel session: your account is in use elsewhere ' +
          '(another browser tab logging into Aula, a previous failed login that ' +
          "didn't fully tear down, etc.). Wait ~60 seconds, close other Aula " +
          'tabs / sessions, then retry.',
      );
    }

    // Specific error code → typed subclass so callers can branch on it.
    if (err.errorCode === 'control.authenticator_cannot_be_started') {
      throw new MitidAuthenticatorUnavailableError(text);
    }
    // Everything else still surfaces — Python treats any non-empty errors[]
    // as fatal (BrowserClient.py:551, :291). Don't drop them silently.
    throw new MitidError(`MitID /next error${err.errorCode ? ` (${err.errorCode})` : ''}: ${text}`);
  }

  private flowProofContext(): FlowProofContext {
    if (
      !this.currentAuthenticatorSessionId ||
      !this.currentAuthenticatorSessionFlowKey ||
      !this.currentAuthenticatorEafeHash
    ) {
      throw new MitidError('flow-proof context requested before authenticator selected');
    }
    return {
      authenticatorSessionId: this.currentAuthenticatorSessionId,
      authenticatorSessionFlowKey: this.currentAuthenticatorSessionFlowKey,
      clientHash: this.clientHash,
      authenticatorEafeHash: this.currentAuthenticatorEafeHash,
      brokerSecurityContext: this.brokerSecurityContext,
      referenceTextHeader: this.referenceTextHeader,
      referenceTextBody: this.referenceTextBody,
      serviceProviderName: this.serviceProviderName,
    };
  }

  /** JSON POST/PUT helper. Returns AulaResponse-like shape. */
  private async postJson(
    url: string,
    body: unknown,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<{ status: number; body: string }> {
    const res = await this.http.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: res.body };
  }
}

function parseJsonValue(text: string, description: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new MitidError(`${description} is not valid JSON`, { cause });
  }
}

function parseResponse<T>(
  body: string,
  predicate: (value: unknown) => value is T,
  description: string,
): T {
  const value = parseJsonValue(body, description);
  if (!predicate(value)) {
    // The shape, not just the verdict. "Unexpected shape" on its own sends the
    // reader to a REPL to find out which field it meant; MitID sends thirty-key
    // payloads and the answer is usually one of them being null.
    throw new MitidError(
      `${description} has an unexpected JSON shape — MitID sent ${describeShape(value)}`,
    );
  }
  return value;
}

function isAuthenticationSessionResponse(value: unknown): value is AuthenticationSessionResponse {
  return (
    isRecord(value) &&
    isString(value.brokerSecurityContext) &&
    isString(value.serviceProviderName) &&
    isString(value.referenceTextHeader) &&
    isString(value.referenceTextBody)
  );
}

export function parseAuthenticationSessionResponse(body: string): AuthenticationSessionResponse {
  return parseResponse(body, isAuthenticationSessionResponse, 'authentication-session response');
}

function isAppInitAuthResponse(value: unknown): value is AppInitAuthResponse {
  return (
    isRecord(value) &&
    isOptional(value.pollUrl, isString) &&
    isOptional(value.ticket, isString) &&
    isOptional(value.errorCode, isString)
  );
}

export function parseAppInitAuthResponse(body: string): AppInitAuthResponse {
  return parseResponse(body, isAppInitAuthResponse, 'APP init-auth response');
}

function isAppPollResponse(value: unknown): value is AppPollResponse {
  const isPayload = (candidate: unknown): candidate is NonNullable<AppPollResponse['payload']> =>
    isRecord(candidate) && isString(candidate.response) && isString(candidate.responseSignature);
  return (
    isRecord(value) &&
    isString(value.status) &&
    isOptional(value.channelBindingValue, isString) &&
    isOptional(
      value.updateCount,
      (candidate): candidate is number =>
        isNumber(candidate) && Number.isSafeInteger(candidate) && candidate >= 0,
    ) &&
    isOptional(
      value.confirmation,
      (candidate): candidate is boolean => typeof candidate === 'boolean',
    ) &&
    isOptional(value.payload, isPayload)
  );
}

export function parseAppPollResponse(body: string): AppPollResponse {
  return parseResponse(body, isAppPollResponse, 'APP poll response');
}

type StringValue = { value: string };

function isStringValue(value: unknown): value is StringValue {
  return isRecord(value) && isString(value.value);
}

function isSrpInitResponse(value: unknown): value is SrpInitResponse {
  return isRecord(value) && isStringValue(value.srpSalt) && isStringValue(value.randomB);
}

export function parseSrpInitResponse(body: string): SrpInitResponse {
  return parseResponse(body, isSrpInitResponse, 'SRP init response');
}

type M2Response = { m2?: StringValue };

function isM2Response(value: unknown): value is M2Response {
  return isRecord(value) && isOptional(value.m2, isStringValue);
}

export function parseM2Response(body: string): string | undefined {
  return parseResponse(body, isM2Response, 'SRP prove response').m2?.value;
}

function isNextAuthenticator(value: unknown): value is NextAuthenticator {
  return (
    isRecord(value) &&
    isString(value.authenticatorType) &&
    isString(value.authenticatorSessionFlowKey) &&
    isString(value.eafeHash) &&
    isString(value.authenticatorSessionId)
  );
}

type AuthenticatorCombination = NonNullable<NextAuthenticatorResponse['combinations']>[number];
type NextError = NonNullable<NextAuthenticatorResponse['errors']>[number];

function isAuthenticatorCombination(value: unknown): value is AuthenticatorCombination {
  const isItem = (candidate: unknown): candidate is { name: string } =>
    isRecord(candidate) && isString(candidate.name);
  return isRecord(value) && isString(value.id) && isArrayOf(value.combinationItems, isItem);
}

function isNextError(value: unknown): value is NextError {
  const isText = (candidate: unknown): candidate is { text?: string } =>
    isRecord(candidate) && isOptional(candidate.text, isString);
  const isUserMessage = (candidate: unknown): candidate is NonNullable<NextError['userMessage']> =>
    isRecord(candidate) &&
    isOptional(candidate.text, isText) &&
    isOptional(candidate.supportErrorId, isString);
  return (
    isRecord(value) &&
    isOptional(value.errorCode, isString) &&
    isOptional(value.message, isString) &&
    isOptional(value.userMessage, isUserMessage)
  );
}

function isNextAuthenticatorResponse(value: unknown): value is NextAuthenticatorResponse {
  return (
    isRecord(value) &&
    isOptional(value.nextAuthenticator, isNextAuthenticator) &&
    isOptional(value.combinations, (candidate): candidate is AuthenticatorCombination[] =>
      isArrayOf(candidate, isAuthenticatorCombination),
    ) &&
    isOptional(value.errors, (candidate): candidate is NextError[] =>
      isArrayOf(candidate, isNextError),
    ) &&
    isOptional(value.nextSessionId, isString)
  );
}

export function parseNextAuthenticatorResponse(body: string): NextAuthenticatorResponse {
  return parseResponse(body, isNextAuthenticatorResponse, 'MitID /next response');
}

export function parseFinalizationResponse(body: string): FinalizationResponse {
  const predicate = (value: unknown): value is FinalizationResponse =>
    isRecord(value) && isOptional(value.authorizationCode, isString);
  return parseResponse(body, predicate, 'finalization response');
}

function safeJson(text: string): { errorCode?: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    return typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {};
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
