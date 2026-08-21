/**
 * Encrypted token persistence, so the user does not re-do MitID per process.
 *
 * `EncryptedFileTokenStore` writes a JSON envelope (version + IV + ciphertext
 * + tag) at the configured path. The AES-256-GCM key comes from one of:
 *   1. an explicit Buffer passed to the constructor (the tests use this),
 *   2. the configured env var (64 hex chars, or any passphrase — hashed),
 *   3. the configured key file, created with chmod 600 on first use.
 *
 * Paths and the env-var name are supplied by `src/auth.ts` — this module has
 * no defaults of its own, so it cannot quietly write outside `$AULA_DIR`.
 *
 * The persisted record includes the active identity (so multi-child guardians
 * don't have to re-pick on every refresh) and a `version` to allow future
 * format changes without losing data.
 */

import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isRecord } from '../../validation.ts';
import {
  type AulaTokens,
  DEFAULT_OAUTH_CONFIG,
  isTokenExpired,
  refreshAccessToken,
} from './aula-oauth.ts';
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, sha256 } from './crypto.ts';
import { hexToBytes } from './encoding.ts';
import { AulaAuthFlowError } from './errors.ts';
import type { AulaHttpClient } from './http.ts';
import { silentLogger } from './logger.ts';

export class TokenStoreError extends AulaAuthFlowError {
  override readonly name: string = 'TokenStoreError';
}

/** Persisted record. The shape is bumped via `version` if we change anything. */
export interface StoredTokenRecord {
  version: 1;
  username: string;
  tokens: AulaTokens;
  /** The MitID identity index the user picked (1-based). Optional: unset when
   *  the user has only one identity / hasn't yet selected. */
  identityIndex?: number;
  /** Display name for the chosen identity (helpful for `aula status`). */
  identityName?: string;
  /** When the record was last written. Unix epoch seconds. */
  saved_at: number;
}

export interface EncryptedFileTokenStoreOptions {
  filePath: string;
  /** Where the generated key lives. Without it (and without `key` or the env
   *  var) there is no key source, and the store refuses to run. */
  keyFilePath?: string;
  /** Force-supply the 32-byte AES-GCM key. Wins over env / file. */
  key?: Buffer;
  /** Env var consulted for the key before falling back to the key file. */
  envVarName?: string;
}

interface EncryptedEnvelope {
  version: 1;
  /** AES-256-GCM. */
  alg: 'aes-256-gcm';
  /** 16-byte IV, base64. */
  iv: string;
  /** Ciphertext, base64. */
  ct: string;
  /** Auth tag, base64. */
  tag: string;
}

export class EncryptedFileTokenStore {
  /** Resolved on-disk path. Exposed (read-only) so long-lived consumers can
   *  watch it for external writes. */
  readonly filePath: string;
  private readonly keyFilePath: string | undefined;
  private readonly envVar: string | undefined;
  private readonly explicitKey?: Buffer;
  private cachedKey?: Buffer;

  constructor(opts: EncryptedFileTokenStoreOptions) {
    this.filePath = opts.filePath;
    this.keyFilePath = opts.keyFilePath;
    this.envVar = opts.envVarName;
    if (opts.key) this.explicitKey = opts.key;
  }

  async load(): Promise<StoredTokenRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if (isEnoent(e)) return null;
      throw new TokenStoreError(`Failed to read token file ${this.filePath}`, { cause: e });
    }
    let envelope: EncryptedEnvelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      envelope = parseEncryptedEnvelope(parsed);
    } catch (e) {
      if (e instanceof TokenStoreError) throw e;
      throw new TokenStoreError('Token file is not valid JSON', { cause: e });
    }
    const key = await this.resolveKey();
    let plaintext: Buffer;
    try {
      plaintext = aesGcmDecrypt(
        key,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      );
    } catch (e) {
      throw new TokenStoreError(
        `Failed to decrypt token file. Wrong ${this.envVar ?? 'key'}, or the key file is missing/corrupted.`,
        { cause: e },
      );
    }
    let record: StoredTokenRecord;
    try {
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
      record = parseStoredTokenRecord(parsed);
    } catch (e) {
      if (e instanceof TokenStoreError) throw e;
      throw new TokenStoreError('Decrypted token blob is not valid JSON', { cause: e });
    }
    return record;
  }

  async save(record: StoredTokenRecord): Promise<void> {
    const key = await this.resolveKey();
    const iv = randomBytes(16);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from(JSON.stringify(record), 'utf8'));
    const envelope: EncryptedEnvelope = {
      version: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(envelope, null, 2), 'utf8');
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // chmod may fail on some filesystems (NTFS share, etc.) — non-fatal.
    }
  }

  async clear(): Promise<void> {
    // Delete the file outright. `load()` returns null for missing files, so a
    // post-clear `load()` rightly reports "no tokens" instead of throwing on
    // an empty-string parse. The .key file is intentionally left in place so
    // the next login can reuse the same encryption key.
    try {
      await unlink(this.filePath);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  // ---- key resolution ------------------------------------------------------

  private async resolveKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    if (this.explicitKey) {
      assertKeyLength(this.explicitKey);
      this.cachedKey = this.explicitKey;
      return this.cachedKey;
    }
    const envValue = this.envVar ? process.env[this.envVar] : undefined;
    if (envValue) {
      this.cachedKey = decodeKeyMaterial(envValue);
      return this.cachedKey;
    }
    if (!this.keyFilePath) {
      throw new TokenStoreError(
        'No key source configured — pass `key`, `keyFilePath`, or set the env var.',
      );
    }
    let fileContents: string;
    try {
      fileContents = (await readFile(this.keyFilePath, 'utf8')).trim();
    } catch (e) {
      if (isEnoent(e)) {
        const fresh = randomBytes(32);
        await mkdir(dirname(this.keyFilePath), { recursive: true });
        await writeFile(this.keyFilePath, fresh.toString('hex'), 'utf8');
        try {
          await chmod(this.keyFilePath, 0o600);
        } catch {
          // best-effort
        }
        this.cachedKey = fresh;
        return this.cachedKey;
      }
      throw new TokenStoreError(`Failed to read key file ${this.keyFilePath}`, { cause: e });
    }
    this.cachedKey = decodeKeyMaterial(fileContents);
    return this.cachedKey;
  }
}

function parseEncryptedEnvelope(value: unknown): EncryptedEnvelope {
  if (!isRecord(value)) throw new TokenStoreError('Token file envelope must be an object');
  if (value.version !== 1 || value.alg !== 'aes-256-gcm') {
    throw new TokenStoreError(
      `Unsupported token file envelope (version=${String(value.version)}, alg=${String(value.alg)})`,
    );
  }
  if (typeof value.iv !== 'string' || typeof value.ct !== 'string' || typeof value.tag !== 'string') {
    throw new TokenStoreError('Token file envelope is missing encrypted string fields');
  }
  return { version: 1, alg: 'aes-256-gcm', iv: value.iv, ct: value.ct, tag: value.tag };
}

function parseStoredTokenRecord(value: unknown): StoredTokenRecord {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.tokens)) {
    throw new TokenStoreError('Decrypted token record has an unsupported shape');
  }
  const tokens = value.tokens;
  const expiresIn = nonNegativeInteger(tokens.expires_in);
  const expiresAt = nonNegativeInteger(tokens.expires_at);
  const obtainedAt = nonNegativeInteger(tokens.obtained_at);
  const savedAt = nonNegativeInteger(value.saved_at);
  const identityIndex = value.identityIndex === undefined
    ? undefined
    : positiveInteger(value.identityIndex);
  if (
    typeof value.username !== 'string' || !value.username ||
    savedAt === undefined ||
    typeof tokens.access_token !== 'string' || !tokens.access_token ||
    typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
    tokens.token_type !== 'Bearer' ||
    expiresIn === undefined ||
    expiresAt === undefined ||
    obtainedAt === undefined ||
    (value.identityIndex !== undefined && identityIndex === undefined) ||
    (value.identityName !== undefined && typeof value.identityName !== 'string')
  ) {
    throw new TokenStoreError('Decrypted token record has invalid fields');
  }
  return {
    version: 1,
    username: value.username,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      expires_at: expiresAt,
      obtained_at: obtainedAt,
    },
    saved_at: savedAt,
    ...(identityIndex !== undefined ? { identityIndex } : {}),
    ...(typeof value.identityName === 'string' ? { identityName: value.identityName } : {}),
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function decodeKeyMaterial(material: string): Buffer {
  const trimmed = material.trim();
  // Accept hex (64 chars) or base64 (44 chars including padding).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  // Hash anything else with SHA-256 to derive a 32-byte key — works for
  // arbitrary passphrases and keeps the API forgiving.
  return sha256(trimmed);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== 32) {
    throw new TokenStoreError(`Token store key must be 32 bytes (got ${key.length})`);
  }
}

function isEnoent(e: unknown): boolean {
  return isRecord(e) && e.code === 'ENOENT';
}

// --------------------------------------------------------------------------
// Refresh-on-load helper
// --------------------------------------------------------------------------

/**
 * Load the stored record and refresh the access token if it's within 60s of
 * expiry. Saves the new tokens back to the store. Returns the (possibly
 * refreshed) record. Throws if no record is present.
 */
export async function withFreshTokens(args: {
  store: EncryptedFileTokenStore;
  http: AulaHttpClient;
}): Promise<StoredTokenRecord> {
  const record = await args.store.load();
  if (!record) {
    throw new TokenStoreError('No tokens on disk. Run `bun run login` first.');
  }
  if (!isTokenExpired(record.tokens, 60)) {
    return record;
  }
  const refreshed = await refreshAccessToken(
    args.http,
    DEFAULT_OAUTH_CONFIG,
    record.tokens.refresh_token,
    silentLogger,
  );
  const updated: StoredTokenRecord = {
    ...record,
    tokens: refreshed,
    saved_at: Math.floor(Date.now() / 1000),
  };
  await args.store.save(updated);
  return updated;
}
