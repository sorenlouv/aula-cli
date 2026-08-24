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
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ATTACHMENT_TIMEOUT_MS, remoteReadSignal } from './transport.ts';
import type { Attachment } from './types.ts';

const ATTACHMENTS_DIR = process.env.AULA_ATTACHMENTS_DIR ?? join(homedir(), '.aula', 'attachments');

/** Attachments are usually photos and PDFs; anything past this is a mistake. */
const MAX_BYTES = 50 * 1024 * 1024;

export type ResolvedAttachment = {
  /** Position in the flattened, message-order list — what the CLI takes. */
  index: number;
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
      name: attachment.name ?? target?.name ?? `attachment-${out.length}`,
      url,
      kind,
    });
  }
  return out;
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
  mediaType?: string;
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
  });
  if (!res.ok) {
    throw new Error(
      `Could not download "${opts.attachment.name}" (HTTP ${res.status}). ` +
        `Presigned Aula attachment URLs expire after about an hour — re-read the ` +
        `thread and try again.`,
    );
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    throw new Error(
      `"${opts.attachment.name}" is ${declared} bytes, over the ${MAX_BYTES}-byte limit.`,
    );
  }

  const bytes = await readBoundedBody(res, opts.attachment.name);

  const filename = safeFilename(opts.attachment.name);
  const path = opts.out ?? join(ATTACHMENTS_DIR, `${opts.prefix}-${filename}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Same reasoning as the session file: this is personal data about children.
  writeFileSync(path, bytes, { mode: 0o600 });

  const mediaType = res.headers.get('content-type') ?? opts.attachment.mediaType;
  return {
    path,
    bytes: bytes.byteLength,
    filename,
    ...(mediaType ? { mediaType } : {}),
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
        throw new Error(`"${name}" exceeded the ${maxBytes}-byte limit while downloading.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
