/** Shared deadlines for remote reads. A hung endpoint must not stall a scheduled brief forever. */

export const REMOTE_READ_TIMEOUT_MS = 30_000;
export const ATTACHMENT_TIMEOUT_MS = 60_000;

export function remoteReadSignal(timeoutMs = REMOTE_READ_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
