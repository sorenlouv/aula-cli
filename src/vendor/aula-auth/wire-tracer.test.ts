import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonlFileTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
} from './wire-tracer.ts';

describe('sanitizeUrl', () => {
  test('redacts access_token in query string', () => {
    const url =
      'https://www.aula.dk/api/v22/?method=profiles.getProfilesByLogin&access_token=eyJhbGciOiJSUzI1NiJ9.long.jwt.value';
    const out = sanitizeUrl(url);
    expect(out).toContain('method=profiles.getProfilesByLogin');
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(out).toContain('access_token=%3Credacted');
  });

  test('redacts every known-secret query param', () => {
    const url = 'https://example.com/?code=AUTHCODE&state=STATE&access_token=AT&ticket=T&keep=ok';
    const out = sanitizeUrl(url);
    expect(out).not.toContain('AUTHCODE');
    expect(out).not.toContain('STATE');
    expect(out).not.toContain('AT');
    expect(out).not.toContain('=T&');
    expect(out).toContain('keep=ok');
  });

  test('returns the URL unchanged when no secrets are present', () => {
    const url = 'https://example.com/x?foo=bar';
    expect(sanitizeUrl(url)).toBe(url);
  });

  test('returns the input unchanged when not a valid URL', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});

describe('sanitizeHeaders', () => {
  test('redacts Cookie / Authorization / Set-Cookie / CSRF headers', () => {
    const out = sanitizeHeaders({
      cookie: 'a=b; sessionId=xyz',
      authorization: 'Bearer XYZ',
      'aula-authorization': 'Bearer XYZ',
      'csrfp-token': 'TOKEN',
      'user-agent': 'Mozilla',
    });
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out.authorization).toMatch(/^<redacted/);
    expect(out['aula-authorization']).toMatch(/^<redacted/);
    expect(out['csrfp-token']).toMatch(/^<redacted/);
    expect(out['user-agent']).toBe('Mozilla');
  });

  test('accepts a Headers object', () => {
    const h = new Headers();
    h.set('Cookie', 'val');
    h.set('X-Custom', 'ok');
    const out = sanitizeHeaders(h);
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out['x-custom']).toBe('ok');
  });
});

describe('sanitizeRequestBody', () => {
  test('redacts secret fields in form-urlencoded body', () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'AUTHCODE',
      code_verifier: 'PKCE_VERIFIER',
      password: 'hunter2',
    });
    const out = sanitizeRequestBody(body);
    expect(out).toContain('grant_type=authorization_code');
    expect(out).toContain('code=%3Credacted');
    expect(out).toContain('password=%3Credacted');
    // code_verifier is also redacted — it's PKCE state and could be used to
    // forge a token exchange against a captured authorization code.
    expect(out).toContain('code_verifier=%3Credacted');
  });

  test('redacts secret fields in JSON body', () => {
    const json = JSON.stringify({
      randomA: { value: 'A_HEX' },
      m1: { value: 'M1_HEX' },
      flowValueProof: { value: 'PROOF' },
      keep_me: 'fine',
    });
    const out = sanitizeRequestBody(json);
    if (out == null) throw new Error('expected non-null');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.randomA).toContain('redacted');
    expect(parsed.m1).toContain('redacted');
    expect(parsed.flowValueProof).toContain('redacted');
    expect(parsed.keep_me).toBe('fine');
  });

  test('binary body is summarised as length only', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    expect(sanitizeRequestBody(buf)).toBe('<binary 4 bytes>');
  });

  test('returns null when body is undefined', () => {
    expect(sanitizeRequestBody(undefined)).toBeNull();
  });
});

describe('sanitizeResponseBody', () => {
  test('truncates long bodies and reports original size', () => {
    const big = 'x'.repeat(10_000);
    const out = sanitizeResponseBody(big, 100);
    expect(out.bytes).toBe(10_000);
    expect(out.text.length).toBeLessThanOrEqual(140);
    expect(out.text.endsWith('chars>')).toBe(true);
  });

  test('redacts SAMLResponse-shaped JSON keys', () => {
    const body = JSON.stringify({ access_token: 'AAA', refresh_token: 'RRR', expires_in: 60 });
    const out = sanitizeResponseBody(body);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(parsed.access_token).toContain('redacted');
    expect(parsed.refresh_token).toContain('redacted');
    expect(parsed.expires_in).toBe(60);
  });

  test('redacts hidden auth fields and embedded tokens in HTML', () => {
    const body = `<form><input type="hidden" name="SAMLResponse" value="SECRET_ASSERTION"><input type="hidden" name="unknown" value="SECRET_UNKNOWN"><script>{"access_token":"SECRET_TOKEN"}</script></form>`;
    const out = sanitizeResponseBody(body);
    expect(out.text).not.toContain('SECRET_ASSERTION');
    expect(out.text).not.toContain('SECRET_UNKNOWN');
    expect(out.text).not.toContain('SECRET_TOKEN');
    expect(out.text).toContain('<redacted>');
  });
});

test('JsonlFileTracer creates and repairs private paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'aula-wire-'));
  const path = join(root, 'private', 'login-trace.jsonl');
  const tracer = new JsonlFileTracer(path);
  tracer.record({
    ts: new Date(0).toISOString(),
    seq: 1,
    method: 'GET',
    url: 'https://example.com',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseHeaders: {},
    responseBody: 'ok',
    responseBodyBytes: 2,
    durationMs: 1,
  });
  expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, 'utf8')).toContain('"seq":1');
});
