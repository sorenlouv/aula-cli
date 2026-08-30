/**
 * On-disk response cache.
 *
 * The Claude skill runs `digest --days 14` for nearly every question it is
 * asked, and one digest is ~60 requests: every thread body, several pages of
 * posts, the calendar, presence, and a weekly plan per vendor widget. Asking
 * three questions in a row therefore costs three identical round-trips over
 * everything, and the vendor APIs are the slowest part of it.
 *
 * So responses are kept on disk with a short TTL. `flat-cache` does the actual
 * work — one JSON file, an expiry stamp per entry, expiry enforced on read
 * rather than by a sweeper, which is what makes it survive between processes.
 *
 * ## What is not cached, and why
 *
 * - **`aulaToken.getAulaToken`.** Widget tokens live about a minute and the
 *   vendors disagree on how they announce an expired one, so `WidgetTokens`
 *   retries once with a fresh token. Serving that "fresh" token from cache
 *   would hand back the same dead string and turn a recoverable expiry into a
 *   hard failure.
 * - **Anything that failed.** Only a status-0 envelope is stored, so a
 *   transient 403 does not get pinned for the length of the TTL.
 * - **The session bootstrap.** `#ensureApiVersion` and `#ensureSession` call
 *   the transport directly rather than through the cached path, so a run that
 *   hits cache for everything skips the handshake, and the first genuine miss
 *   still performs it.
 *
 * ## Staleness
 *
 * The TTL is the only invalidation — nothing here can tell that a new message
 * arrived. It is deliberately short, `--no-cache` bypasses it entirely, and
 * `login`, `logout` and `refresh-stepup` all drop the cache, because each of
 * those changes *what the account can see* rather than just what it has seen.
 *
 * The data is personal and concerns children, so the file is 0600 inside the
 * 0700 `~/.aula` — the same handling as the cookie jar and downloaded
 * attachments.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FlatCache } from 'flat-cache';
import { AULA_DIR, ensureAulaDir } from './auth.ts';

const CACHE_DIR = join(AULA_DIR, 'cache');
const CACHE_ID = 'responses';
export const CACHE_PATH = join(CACHE_DIR, CACHE_ID);

/**
 * Ten minutes: long enough that a whole conversation with the skill costs one
 * fetch, short enough that "did the teacher reply yet?" is never wrong for
 * longer than it takes to make a cup of coffee.
 */
export const DEFAULT_TTL_MS = 10 * 60_000;

export type CacheSettings = {
  /** Off entirely — no reads, no writes, no file touched. */
  enabled?: boolean;
  ttlMs?: number;
  /**
   * Which login these entries belong to. Mixing two guardians' children in one
   * file would be a data-protection bug, not a cache bug, so the scope is part
   * of every key rather than something the caller may forget.
   */
  scope?: string;
};

export class ResponseCache {
  readonly enabled: boolean;
  readonly ttlMs: number;
  #scope: string;
  #store: FlatCache | undefined;
  #dirty = false;

  private constructor(settings: CacheSettings) {
    this.enabled = settings.enabled ?? true;
    this.ttlMs = settings.ttlMs ?? DEFAULT_TTL_MS;
    this.#scope = settings.scope ?? 'default';
    if (this.enabled && this.ttlMs > 0) {
      ensureAulaDir();
      this.#store = new FlatCache({ cacheDir: CACHE_DIR, cacheId: CACHE_ID, ttl: this.ttlMs });
      this.#store.load();
    }
  }

  /** A cache that never hits and never writes. The default for library use. */
  static disabled(): ResponseCache {
    return new ResponseCache({ enabled: false });
  }

  static open(settings: CacheSettings = {}): ResponseCache {
    return new ResponseCache(settings);
  }

  /**
   * `namespace` is the readable half of the key — an Aula method name, or the
   * widget id for a vendor plan. It stays in the clear so `cache status` can
   * say what is cached; everything identifying is hashed into the other half.
   */
  get(namespace: string, key: unknown): unknown {
    if (!this.#store) return undefined;
    return this.#store.get(this.#key(namespace, key));
  }

  set(namespace: string, key: unknown, value: unknown): void {
    // `undefined` cannot survive the round-trip through JSON, so it would come
    // back as a miss anyway — better not to spend a slot on it.
    if (!this.#store || value === undefined) return;
    this.#store.set(this.#key(namespace, key), value);
    this.#dirty = true;
  }

  /** Writes the accumulated entries out. Called once, as the process exits. */
  flush(): void {
    if (!this.#store || !this.#dirty) return;
    this.#store.save(true);
    this.#dirty = false;
    restrictPermissions();
  }

  stats(): CacheStats {
    if (!this.#store) {
      return {
        enabled: false,
        path: CACHE_PATH,
        ttlMs: this.ttlMs,
        entries: 0,
        byNamespace: {},
        bytes: 0,
      };
    }
    const now = Date.now();
    const byNamespace: Record<string, number> = {};
    let entries = 0;
    for (const item of this.#store.items) {
      // `items` reports what is stored, including entries that have aged out
      // but not yet been evicted — counting those would overstate what a run
      // would actually hit.
      if (typeof item.expires === 'number' && item.expires <= now) continue;
      entries++;
      const namespace = item.key.split(' ', 1)[0] ?? '?';
      byNamespace[namespace] = (byNamespace[namespace] ?? 0) + 1;
    }
    return {
      enabled: true,
      path: CACHE_PATH,
      ttlMs: this.ttlMs,
      entries,
      byNamespace,
      bytes: existsSync(CACHE_PATH) ? statSync(CACHE_PATH).size : 0,
    };
  }

  #key(namespace: string, key: unknown): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([this.#scope, namespace, key]))
      .digest('hex')
      .slice(0, 32);
    return `${namespace} ${digest}`;
  }
}

export type CacheStats = {
  enabled: boolean;
  path: string;
  ttlMs: number;
  entries: number;
  byNamespace: Record<string, number>;
  bytes: number;
};

// ------------------------------------------------------------------ lifecycle

let opened: ResponseCache | undefined;

/**
 * The process-wide cache. One instance, because `flat-cache` holds the whole
 * file in memory and two instances would write over each other on the way out.
 */
export function openCache(settings: CacheSettings = {}): ResponseCache {
  opened = ResponseCache.open(settings);
  return opened;
}

/** Persists whatever the command accumulated. Safe to call when nothing did. */
export function flushCache(): void {
  opened?.flush();
}

/** Drops every cached response. Returns whether there was anything to drop. */
export function clearCache(): boolean {
  const existed = existsSync(CACHE_PATH);
  opened = undefined;
  rmSync(CACHE_DIR, { recursive: true, force: true });
  return existed;
}

export function cacheStats(settings: CacheSettings = {}): CacheStats {
  return (opened ?? ResponseCache.open({ ...settings, enabled: true })).stats();
}

/**
 * `flat-cache` writes 0644 in a 0755 directory, which for a file full of other
 * people's messages about children is not good enough.
 */
function restrictPermissions(): void {
  try {
    chmodSync(CACHE_DIR, 0o700);
    if (existsSync(CACHE_PATH)) chmodSync(CACHE_PATH, 0o600);
  } catch {
    // A filesystem that cannot express these modes is not a reason to lose the
    // cache; the enclosing ~/.aula is already restricted.
  }
}
