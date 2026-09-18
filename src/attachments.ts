/**
 * Downloading what teachers attach to messages and posts.
 *
 * Aula does not serve attachments itself — it hands out CloudFront presigned
 * URLs, valid for about an hour, where the signature *is* the authorisation.
 * Two consequences shape this module:
 *
 *  - The URL must be fetched clean. Sending the Aula cookie or an Authorization
 *    header alongside a presigned URL makes S3 reject the request.
 *  - The URL must not make a round trip through a model. They are long opaque
 *    blobs, and a single mangled character produces a `MalformedSignature` 403
 *    that reads like an auth failure. Downloading here and returning a path
 *    keeps them out of that loop entirely.
 *
 * The second rule was written here and broken everywhere else: every message
 * and post in `digest`, `thread`, `messages --full`, `posts` and `attachments`
 * carried `{ name, url }`, so the model was handed each signature anyway — a
 * few hundred tokens apiece, for a string it must never retype — and a post's
 * attachment had no download command at all, which made copying the URL out of
 * the JSON the only way to fetch it. Payloads now carry an {@link AttachmentRef}
 * instead: a position to hand to `attachment` or `post-attachment`, never a
 * signed URL.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';
import { ATTACHMENT_TIMEOUT_MS, remoteReadSignal } from './transport.ts';
import type { Attachment } from './types.ts';
import { errorMessage } from './validation.ts';

const ATTACHMENTS_DIR = process.env.AULA_ATTACHMENTS_DIR ?? join(homedir(), '.aula', 'attachments');

/** Attachments are usually photos and PDFs; anything past this is a mistake. */
const MAX_BYTES = 50 * 1024 * 1024;

export type ResolvedAttachment = {
  /** Position in the flattened, message-order list — what the CLI takes. */
  index: number;
  /** Aula's own id for the attachment, when the payload carries one. */
  id: number | null;
  name: string;
  url: string;
  /** A `link` has no bytes behind it: it points somewhere else on the web. */
  kind: 'file' | 'media' | 'link';
  mediaType?: string;
};

/**
 * Flatten a thread's or post's attachments into an addressable list.
 *
 * Aula models three kinds — `file`, `media` (photo/video) and `link` — in the
 * same array. Links have no bytes to fetch, so they are listed but not
 * downloadable.
 */
export function listAttachments(attachments: Attachment[] | undefined): ResolvedAttachment[] {
  const out: ResolvedAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const kind = attachment.file ? 'file' : attachment.media ? 'media' : 'link';
    const target = attachment.file ?? attachment.media ?? attachment.link ?? null;
    const url = target?.url;
    if (!url) continue;
    out.push({
      index: out.length,
      id: attachment.id ?? null,
      name: attachment.name ?? target?.name ?? `attachment-${out.length}`,
      url,
      kind,
    });
  }
  return out;
}

/** What a payload says about an attachment: enough to name and fetch it. */
export type AttachmentRef = {
  /**
   * What `attachment <threadId> <index>` and `post-attachment <postId> <index>`
   * take. Null when only part of a thread was read: a position counts from the
   * thread's first message, so it cannot be known from one page of it.
   */
  index: number | null;
  id: number | null;
  name: string;
  kind: ResolvedAttachment['kind'];
  /**
   * Where a `link` points — an ordinary web address somebody pasted, which is
   * content. Null for `file` and `media`, whose URLs are presigned and stay in
   * this process.
   */
  link: string | null;
};

/**
 * The payload form of {@link listAttachments}, built on it so the two can never
 * number the same attachments differently.
 *
 * `firstIndex` is where this list starts within its thread — a thread's
 * attachments are numbered across all of its messages — or null when that is
 * not known.
 */
export function describeAttachments(
  attachments: Attachment[] | undefined,
  firstIndex: number | null = 0,
): AttachmentRef[] {
  return listAttachments(attachments).map((attachment) => ({
    index: firstIndex === null ? null : firstIndex + attachment.index,
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    link: attachment.kind === 'link' ? attachment.url : null,
  }));
}

/** Strips anything that could escape the target directory or confuse a shell. */
export function safeFilename(name: string): string {
  const cleaned = name
    // Path separators and anything exotic. `\w` is unicode-aware under /u, so
    // "Ugeplan uge 33 – æøå.pdf" survives intact.
    .replace(/[^\w.\- ]+/gu, '_')
    // No `..` segment survives, in any position.
    .replace(/\.{2,}/g, '_')
    // A leading dot would make it a hidden file; leading padding is just noise.
    .replace(/^[._\-\s]+/, '')
    .trim();
  return cleaned || 'attachment';
}

export type DownloadResult = {
  path: string;
  bytes: number;
  filename: string;
  mediaType: string | null;
};

export async function downloadAttachment(opts: {
  attachment: ResolvedAttachment;
  /** Prefixed onto the filename so two threads cannot collide. */
  prefix: string;
  /** Exact output path. Overrides the directory + generated filename. */
  out?: string;
}): Promise<DownloadResult> {
  // Deliberately plain `fetch`: no cookie, no Authorization, no custom headers.
  const res = await fetch(opts.attachment.url, {
    signal: remoteReadSignal(ATTACHMENT_TIMEOUT_MS),
  }).catch((err: unknown) => {
    // No answer at all — not the expired-URL case below, which is an answer.
    throw new CliError(
      'NETWORK',
      `Could not reach the file store to download "${opts.attachment.name}" (${errorMessage(err)}).`,
      'Check the network connection and try again.',
    );
  });
  if (!res.ok) {
    throw new CliError(
      'UPSTREAM',
      `Could not download "${opts.attachment.name}" (HTTP ${res.status}). ` +
        `Presigned Aula attachment URLs expire after about an hour — re-read the ` +
        `thread and try again.`,
    );
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    throw new CliError(
      'UPSTREAM',
      `"${opts.attachment.name}" is ${declared} bytes, over the ${MAX_BYTES}-byte limit.`,
    );
  }

  const bytes = await readBoundedBody(res, opts.attachment.name);

  const filename = safeFilename(opts.attachment.name);
  const path = opts.out ?? join(ATTACHMENTS_DIR, `${opts.prefix}-${filename}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Same reasoning as the session file: this is personal data about children.
  writeFileSync(path, bytes, { mode: 0o600 });

  return {
    path,
    bytes: bytes.byteLength,
    filename,
    mediaType: res.headers.get('content-type') ?? opts.attachment.mediaType ?? null,
  };
}

export async function readBoundedBody(
  response: Response,
  name: string,
  maxBytes = MAX_BYTES,
): Promise<Buffer> {
  if (!Number.isInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a non-negative integer');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CliError(
          'UPSTREAM',
          `"${name}" exceeded the ${maxBytes}-byte limit while downloading.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
