/**
 * Wire tracing for the auth flow. When MitID fails (and it will, in subtle
 * ways), Casper needs to see the actual HTTP traffic to figure out why.
 *
 * The tracer gets called by AulaHttpClient before/after every fetch. We
 * sanitize bodies that contain known-secret fields (passwords, auth codes,
 * SAML responses, tokens) so a transcript is safe to share for debugging.
 *
 * Two implementations: `noopTracer` (the zero-cost default) and
 * `JsonlFileTracer`, which `aula login --debug` points at
 * `~/.aula/login-trace.jsonl` — append-only, so it survives crashes.
 */

import { Buffer } from 'node:buffer';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from '../../validation.ts';

export interface WireEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Sequence number — useful when sorting entries from concurrent calls. */
  seq: number;
  method: string;
  url: string;
  /** Sanitised request headers. */
  requestHeaders: Record<string, string>;
  /** Body summary; full body is replaced by `<redacted N bytes>` for secrets. */
  requestBody: string | null;
  status: number;
  /** Sanitised response headers. */
  responseHeaders: Record<string, string>;
  /** Body summary, possibly truncated. */
  responseBody: string;
  /** Response body length in bytes (before truncation). */
  responseBodyBytes: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface WireTracer {
  record(entry: WireEntry): void;
}

export const noopTracer: WireTracer = { record() {} };

/** Append-only JSONL file tracer. Creates the parent dir if needed. */
export class JsonlFileTracer implements WireTracer {
  private dirReady = false;
  constructor(private readonly path: string) {}
  record(entry: WireEntry): void {
    if (!this.dirReady) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.path), 0o700);
      this.dirReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    // appendFile's mode only applies on creation. Correct an older permissive
    // trace too, before another record can put new credentials in it.
    chmodSync(this.path, 0o600);
  }
}

// --------------------------------------------------------------------------
// Sanitization
// --------------------------------------------------------------------------

/** Header names whose value is replaced with `<redacted>`. Lower-case. */
const SECRET_HEADERS = new Set([
  'authorization',
  'aula-authorization',
  'cookie',
  'set-cookie',
  'csrfp-token',
  'x-csrf-token',
]);

/** Body field names (in form-urlencoded or JSON) we redact. */
const SECRET_BODY_FIELDS = [
  'password',
  'pwd',
  'mitidauthcode',
  'authorizationcode',
  'authorization_code',
  'access_token',
  'refresh_token',
  'code',
  'code_verifier',
  'samlresponse',
  'relaystate',
  '__requestverificationtoken',
  'sessionstorageactivesessionuuid',
  'sessionstorageactivechallenge',
  'm1',
  'flowvalueproof',
  'randoma',
  'identityclaim',
  'chosenoptionjson',
];

const SECRET_BODY_FIELDS_SET = new Set(SECRET_BODY_FIELDS.map((s) => s.toLowerCase()));

/**
 * Query-string keys to redact in URLs before they hit a tracer. Aula's API
 * passes `access_token` as a query param (not a header), so without this the
 * --debug transcript would leak the JWT in every URL.
 */
const SECRET_URL_PARAMS = new Set([
  'access_token',
  'refresh_token',
  'code',
  'code_verifier',
  'state',
  'mitidauthcode',
  '__requestverificationtoken',
  'ticket',
  'session_code',
]);

/** Sanitise a URL by redacting known-secret query-string values. */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let mutated = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SECRET_URL_PARAMS.has(key.toLowerCase())) {
      const v = parsed.searchParams.get(key) ?? '';
      parsed.searchParams.set(key, `<redacted ${v.length}>`);
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : url;
}

/** Truncation cap for response bodies (bytes). */
const DEFAULT_BODY_CAP = 4_096;

export function sanitizeHeaders(headers: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (SECRET_HEADERS.has(key)) {
      out[key] = `<redacted ${v.length} chars>`;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Sanitise a request body whose shape may be form-urlencoded or JSON. */
export function sanitizeRequestBody(
  body: string | URLSearchParams | Uint8Array | undefined,
): string | null {
  if (body === undefined) return null;
  if (body instanceof URLSearchParams) {
    const out = new URLSearchParams();
    for (const [k, v] of body) {
      out.set(k, SECRET_BODY_FIELDS_SET.has(k.toLowerCase()) ? `<redacted ${v.length}>` : v);
    }
    return out.toString();
  }
  if (body instanceof Uint8Array) {
    return `<binary ${body.length} bytes>`;
  }
  // String — try JSON first, then assume opaque.
  try {
    const parsed: unknown = JSON.parse(body);
    return JSON.stringify(redactJson(parsed));
  } catch {
    return truncateString(body, DEFAULT_BODY_CAP);
  }
}

export function sanitizeResponseBody(
  body: string,
  cap = DEFAULT_BODY_CAP,
): {
  text: string;
  bytes: number;
} {
  const bytes = Buffer.byteLength(body, 'utf8');
  // For JSON/HTML responses, redact known secret fields by string match.
  let cleaned = body;
  if (looksLikeJson(body)) {
    try {
      const parsed: unknown = JSON.parse(body);
      cleaned = JSON.stringify(redactJson(parsed));
    } catch {
      // fall through to raw
    }
  } else if (/<(?:input|textarea|meta)\b/i.test(body)) {
    cleaned = redactHtmlSecrets(body);
  }
  return { text: truncateString(cleaned, cap), bytes };
}

function redactAttribute(tag: string, attribute: 'value' | 'content'): string {
  const quoted = new RegExp(`(\\b${attribute}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, 'i');
  if (quoted.test(tag)) return tag.replace(quoted, `$1$2<redacted>$2`);
  const bare = new RegExp(`(\\b${attribute}\\s*=\\s*)([^\\s>]+)`, 'i');
  return tag.replace(bare, '$1<redacted>');
}

function attributeValue(tag: string, attribute: string): string | null {
  const quoted = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  if (quoted !== undefined) return quoted;
  return new RegExp(`\\b${attribute}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)?.[1] ?? null;
}

/** Auth pages carry SAML and anti-forgery values in hidden HTML fields. */
function redactHtmlSecrets(body: string): string {
  let cleaned = body.replace(/<input\b[^>]*>/gi, (tag) => {
    const name = attributeValue(tag, 'name') ?? attributeValue(tag, 'id') ?? '';
    const type = attributeValue(tag, 'type') ?? '';
    return type.toLowerCase() === 'hidden' || SECRET_BODY_FIELDS_SET.has(name.toLowerCase())
      ? redactAttribute(tag, 'value')
      : tag;
  });
  cleaned = cleaned.replace(/<meta\b[^>]*>/gi, (tag) => {
    const name = attributeValue(tag, 'name') ?? attributeValue(tag, 'property') ?? '';
    return SECRET_BODY_FIELDS_SET.has(name.toLowerCase()) ? redactAttribute(tag, 'content') : tag;
  });
  cleaned = cleaned.replace(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi,
    (whole, attributes: string) => {
      const name = attributeValue(attributes, 'name') ?? attributeValue(attributes, 'id') ?? '';
      return SECRET_BODY_FIELDS_SET.has(name.toLowerCase())
        ? `<textarea${attributes}><redacted></textarea>`
        : whole;
    },
  );
  // Embedded JSON/configuration is common on identity-provider pages.
  for (const field of SECRET_BODY_FIELDS) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(
      new RegExp(`(["']${escaped}["']\\s*:\\s*["'])([^"']*)(["'])`, 'gi'),
      '$1<redacted>$3',
    );
  }
  return cleaned.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url));
}

function redactJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJson);
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return value;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_BODY_FIELDS_SET.has(k.toLowerCase())) {
      out[k] =
        typeof v === 'string'
          ? `<redacted ${v.length}>`
          : isRecord(v) && 'value' in v
            ? `<redacted object with .value>`
            : `<redacted>`;
    } else {
      out[k] = redactJson(v);
    }
  }
  return out;
}

function truncateString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}…<+${s.length - cap} chars>`;
}

function looksLikeJson(s: string): boolean {
  const trimmed = s.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
