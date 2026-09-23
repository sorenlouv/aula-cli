/**
 * The Worker's own login: one-time codes by email, then a long session.
 *
 * Cloudflare Access did this first, and was replaced for two reasons it could
 * not change: its sessions end after a month at the longest, and its login
 * page cannot be designed — "Log in to <application>" on a grey card, under
 * the team's `cloudflareaccess.com` domain. A page two parents open every
 * morning is worth making theirs, and a family should sign in about once a
 * year, not once a month.
 *
 * What that costs is this file, so it is kept small and pure: no storage, no
 * I/O, Web Crypto only, which Bun and workerd both provide — the tests run the
 * same functions the Worker does.
 *
 * - **Nothing secret is stored as itself.** A session token is kept as its
 *   SHA-256 digest, so the store never holds one that would let its reader
 *   in. A login code is too, but six digits are a million guesses from their
 *   digest — found in under a second while testing this — so what keeps a code
 *   safe is its ten minutes and five tries, not the hash.
 * - **Every comparison of a secret takes the same time,** whatever it is
 *   compared with — `sameText` over digests of equal length.
 */

/** HttpOnly, Secure, host-only: `__Host-` makes the browser insist on all three. */
export const SESSION_COOKIE = '__Host-aula_session';

/**
 * How long a session lasts since it was last renewed. Renewed at most daily,
 * on any visit, so a family that opens the page at all stays signed in; Chrome
 * caps a cookie at 400 days whatever the server asks for.
 */
export const SESSION_DAYS = 365;
export const RENEW_AFTER_MS = 86_400_000;

/** A code is good for ten minutes and five guesses: one in 200,000 per code. */
export const CODE_MINUTES = 10;
export const CODE_ATTEMPTS = 5;

/**
 * At most this many codes to one address per hour. Someone who knows a
 * parent's address can make the page send it mail; this is how much.
 */
export const SENDS_PER_HOUR = 5;

/** A second press of "Send kode" within this long shows the same code form. */
export const RESEND_AFTER_MS = 60_000;

/** Six digits, uniformly: values in the uneven tail of 2³² are drawn again. */
export function newCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? limit;
    if (value < limit) return String(value % 1_000_000).padStart(6, '0');
  }
}

/** 256 random bits, base64url — a session token or an upload token. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether two strings are equal, in time that depends only on their length.
 * Callers compare digests, which always have the same length.
 */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Whether `given` is the upload token, compared as digests. */
export async function isUploadToken(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected || !given) return false;
  return sameText(await sha256(given), await sha256(expected));
}

/** The digest a login code is stored as. The address is in it, so a code is one person's. */
export function codeDigest(email: string, code: string): Promise<string> {
  return sha256(`${email}\n${code}`);
}

/** A plausible address, lowercased — or null. Deliverability is the mail's business. */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** `ALLOWED_EMAILS`, a Worker secret: addresses separated by commas or whitespace. */
export function allowedEmails(value: string | undefined): Set<string> {
  const emails = (value ?? '').split(/[\s,]+/).map(normaliseEmail);
  return new Set(emails.filter((email): email is string => email !== null));
}

export function sessionCookie(token: string): string {
  const maxAge = SESSION_DAYS * 86_400;
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
