import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  MitidError,
  parseAppInitAuthResponse,
  parseAppPollResponse,
  parseAuthenticationSessionResponse,
  parseAuxResponse,
  parseFinalizationResponse,
  parseM2Response,
  parseNextAuthenticatorResponse,
  parseSrpInitResponse,
} from './mitid-client.ts';
import { normalizeAuthenticatorType } from './mitid-types.ts';

describe('parseAuxResponse', () => {
  function buildAuxBody(inner: unknown): string {
    const auxB64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    return JSON.stringify({ Aux: auxB64 });
  }

  test('decodes a well-formed Aux blob', () => {
    const body = buildAuxBody({
      coreClient: { checksum: Buffer.from('cafebabe', 'hex').toString('base64') },
      parameters: { authenticationSessionId: '11111111-2222-3333-4444-555555555555' },
    });
    const out = parseAuxResponse(body);
    expect(out.clientHash).toBe('cafebabe');
    expect(out.authenticationSessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('accepts already-parsed object form', () => {
    const auxB64 = Buffer.from(
      JSON.stringify({
        coreClient: { checksum: Buffer.from('00ff', 'hex').toString('base64') },
        parameters: { authenticationSessionId: 'abc' },
      }),
      'utf8',
    ).toString('base64');
    const out = parseAuxResponse({ Aux: auxB64 });
    expect(out.clientHash).toBe('00ff');
    expect(out.authenticationSessionId).toBe('abc');
  });

  test('handles the double-JSON-encoded body that nemlog-in.mitid.dk actually returns', () => {
    // Real shape captured from a live login: the HTTP body is a JSON string
    // whose contents are the actual JSON object (so parsing once yields a
    // string, not the object).
    const inner = {
      coreClient: { checksum: Buffer.from('cafebabe', 'hex').toString('base64') },
      parameters: { authenticationSessionId: '78b4810a-e1e7-4e04-8fb4-650d7d9c81ef' },
    };
    const auxB64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    const innerObject = JSON.stringify({ Aux: auxB64 });
    const doubleEncodedBody = JSON.stringify(innerObject); // wraps the whole thing as a JSON string
    const out = parseAuxResponse(doubleEncodedBody);
    expect(out.clientHash).toBe('cafebabe');
    expect(out.authenticationSessionId).toBe('78b4810a-e1e7-4e04-8fb4-650d7d9c81ef');
  });

  test('throws when Aux missing', () => {
    expect(() => parseAuxResponse('{}')).toThrow(MitidError);
    expect(() => parseAuxResponse('not json')).toThrow(MitidError);
  });

  test('throws when Aux is not valid base64-JSON', () => {
    expect(() => parseAuxResponse(JSON.stringify({ Aux: 'not-base64-of-json' }))).toThrow(
      MitidError,
    );
  });

  test('throws when checksum or sessionId missing', () => {
    const body = buildAuxBody({ coreClient: {}, parameters: {} });
    expect(() => parseAuxResponse(body)).toThrow(MitidError);
  });
});

describe('normalizeAuthenticatorType', () => {
  test('maps the server\'s "TOKEN" (hardware kodeviser) to CODE_TOKEN', () => {
    expect(normalizeAuthenticatorType('TOKEN')).toBe('CODE_TOKEN');
  });

  test('passes APP, PASSWORD and CODE_TOKEN through unchanged', () => {
    expect(normalizeAuthenticatorType('APP')).toBe('APP');
    expect(normalizeAuthenticatorType('PASSWORD')).toBe('PASSWORD');
    expect(normalizeAuthenticatorType('CODE_TOKEN')).toBe('CODE_TOKEN');
  });

  test('rejects a new server value instead of lying about its union type', () => {
    expect(() => normalizeAuthenticatorType('NEW_DEVICE')).toThrow(
      /Unknown MitID authenticator type/,
    );
  });
});

describe('MitID wire response parsers', () => {
  test('parses the authentication-session fields the flow proof needs', () => {
    const response = parseAuthenticationSessionResponse(
      JSON.stringify({
        brokerSecurityContext: 'context',
        serviceProviderName: 'Aula',
        referenceTextHeader: 'header',
        referenceTextBody: 'body',
        ignoredByThisClient: true,
      }),
    );
    expect(response.serviceProviderName).toBe('Aula');
    expect(() => parseAuthenticationSessionResponse('{}')).toThrow(MitidError);
  });

  test('accepts both APP startup success and a typed error response', () => {
    expect(parseAppInitAuthResponse('{"pollUrl":"https://poll","ticket":"t"}')).toEqual({
      pollUrl: 'https://poll',
      ticket: 't',
    });
    expect(parseAppInitAuthResponse('{"errorCode":"parallel"}')).toEqual({ errorCode: 'parallel' });
    expect(() => parseAppInitAuthResponse('{"pollUrl":42}')).toThrow(MitidError);
  });

  test('validates poll payloads before the state machine reads them', () => {
    expect(parseAppPollResponse('{"status":"timeout"}')).toEqual({ status: 'timeout' });
    expect(() => parseAppPollResponse('{"status":"OK","payload":{"response":42}}')).toThrow(
      MitidError,
    );
  });

  test('validates SRP init and prove wrappers', () => {
    expect(
      parseSrpInitResponse(
        JSON.stringify({
          srpSalt: { value: 'salt' },
          randomB: { value: 'random' },
        }),
      ).randomB.value,
    ).toBe('random');
    expect(parseM2Response('{"m2":{"value":"proof"}}')).toBe('proof');
    expect(() => parseSrpInitResponse('{"srpSalt":{},"randomB":{"value":"x"}}')).toThrow(
      MitidError,
    );
  });

  test('validates nested /next combinations, authenticators and error messages', () => {
    const parsed = parseNextAuthenticatorResponse(
      JSON.stringify({
        nextAuthenticator: {
          authenticatorType: 'APP',
          authenticatorSessionFlowKey: 'flow',
          eafeHash: 'hash',
          authenticatorSessionId: 'session',
        },
        combinations: [{ id: 'S3', combinationItems: [{ name: 'MitID app' }] }],
        errors: [
          { errorCode: 'x', userMessage: { supportErrorId: 'CAP008', text: { text: 'busy' } } },
        ],
      }),
    );
    expect(parsed.combinations?.[0]?.combinationItems[0]?.name).toBe('MitID app');
    expect(parsed.errors?.[0]?.userMessage?.supportErrorId).toBe('CAP008');
    expect(() => parseNextAuthenticatorResponse('{"combinations":[{"id":"S3"}]}')).toThrow(
      MitidError,
    );
  });

  test('keeps finalization absence explicit for the caller to diagnose', () => {
    expect(parseFinalizationResponse('{}')).toEqual({});
    expect(parseFinalizationResponse('{"authorizationCode":"code"}')).toEqual({
      authorizationCode: 'code',
    });
    expect(() => parseFinalizationResponse('null')).toThrow(MitidError);
  });
});

/**
 * The regression that broke `login` outright.
 *
 * MitID does not omit optional fields when it has nothing to put in them — it
 * sends `null`. A `/next` reporting an error carries `"nextAuthenticator":
 * null` and `"nextSessionId": null`, and a guard that accepted only
 * `undefined` rejected the whole response as an unexpected shape. The message
 * underneath was CAP008, which this client already handles kindly, so the cost
 * of that strictness was a clear "your session was cancelled, wait a minute"
 * turning into an unactionable parse complaint.
 *
 * The body below is the shape aula.dk actually returned, with the text MitID
 * actually sent.
 */
describe('a /next response with nulls where optional fields would be', () => {
  const REAL_CAP008 = JSON.stringify({
    selectCombination: false,
    defaultCombinationId: 'S3',
    flowCancelled: false,
    errors: [
      {
        errorCode: 'control.authenticator_cannot_be_started',
        message: 'Unable to start authenticator %s',
        continueText: null,
        userMessage: {
          title: { text: 'Session cancelled', textAria: '' },
          text: {
            text:
              'You have used your user ID in two places at the same time. ' +
              'Due to this, your session has been cancelled. Try again',
            textAria: '',
          },
          severity: 'ERROR',
          supportErrorId: 'CAP008',
        },
        correlationId: '00000000-1111-2222-3333-444444444444',
      },
    ],
    nextAuthenticator: null,
    combinations: [{ id: 'S3', combinationItems: [{ name: 'MitID app', iconURL: 'x' }] }],
    terms: null,
    nextSessionId: null,
  });

  test('parses, instead of being rejected as an unexpected shape', () => {
    const parsed = parseNextAuthenticatorResponse(REAL_CAP008);
    expect(parsed.nextAuthenticator).toBeNull();
    expect(parsed.nextSessionId).toBeNull();
    expect(parsed.combinations).toHaveLength(1);
  });

  test('carries the error through, so the CAP008 handler can see it', () => {
    const parsed = parseNextAuthenticatorResponse(REAL_CAP008);
    const err = parsed.errors?.[0];
    expect(err?.errorCode).toBe('control.authenticator_cannot_be_started');
    expect(err?.userMessage?.supportErrorId).toBe('CAP008');
    expect(err?.userMessage?.text?.text).toMatch(/two places at the same time/);
  });

  test('a null optional is not confused with a wrong-typed one', () => {
    // null passes; a number where a string belongs must still be refused.
    expect(() => parseNextAuthenticatorResponse('{"nextSessionId":42}')).toThrow(MitidError);
    expect(parseNextAuthenticatorResponse('{"nextSessionId":null}').nextSessionId).toBeNull();
  });
});
