/**
 * The wire between the login page's two halves.
 *
 * It exists because those halves compile in different programs — the server
 * with no DOM, the client with no Bun — and this shape is the only thing they
 * share. Before the port it was a comment on one side and a run of
 * `state.kind === '...'` string tests on the other, which is a contract that
 * can only be broken at runtime, on a parent's screen, mid-login.
 *
 * Nothing here may touch `Bun` or `document`: this file is the one module
 * compiled by both projects, so anything platform-specific in it fails one of
 * the two typechecks — which is exactly the guard that keeps it a protocol.
 */

/**
 * How often the browser asks for the current state.
 *
 * MitID's own poll runs at 1s and rotates the QR pair every few of those. Twice
 * that rate keeps a rotation from being visibly late, and a poll that finds
 * nothing new costs one small JSON body — see `since`.
 *
 * Imported by both halves on purpose: the server sizes `SETTLE_CEILING_MS` at
 * four of these, so a client that quietly slowed down would make that ceiling
 * too tight and end a finished login on "the page lost the connection".
 */
export const POLL_MS = 500;

/**
 * Consecutive dropped polls before the page decides the command is gone.
 *
 * One dropped request is not the end of a login. Three in a row is the process
 * having exited, which is worth saying rather than spinning against a dead port.
 */
export const MAX_POLL_FAILURES = 3;

/**
 * The state as the browser receives it: QR payloads already rendered.
 *
 * Rendering server-side is what keeps a QR library out of the page, and `rev`
 * is what keeps the rendering out of the poll — a client that already has
 * revision N is answered with four bytes instead of two encoded symbols.
 */
export type WireState = (
  | { kind: 'starting' | 'verified' }
  | { kind: 'ask-username'; error?: string }
  | { kind: 'ask-identity'; options: string[]; error?: string }
  | { kind: 'otp'; otp: string }
  | { kind: 'qr'; svg1: string; svg2: string; updateCount: number }
  | { kind: 'done'; ok: boolean; message: string }
) & { rev: number };

/** What `GET /{token}/state?since=N` answers with. */
export type PollResponse = WireState | { rev: number; unchanged: true };

/**
 * What `POST /{token}/input` answers with, on every status it can return.
 *
 * `ok: false` on a 200 means "still armed, fix it and send it again"; the 4xx
 * bodies carry the same shape, which is why the page shows the server's own
 * Danish sentence instead of inventing one.
 */
export type InputReply = { ok: true } | { ok: false; error: string };
