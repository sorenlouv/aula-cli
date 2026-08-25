/**
 * Durable developer diagnostics for brief generation.
 *
 * The terminal is ephemeral, while a scheduled model failure often gets
 * investigated hours later. Only failures and incomplete model answers are
 * appended here; prompts and source payloads are deliberately excluded. The
 * Claude transport error carries its captured process output, which is enough
 * to distinguish an API outage, timeout, missing login and malformed reply.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from '../auth.ts';
import { errorMessage } from '../validation.ts';

export const BRIEF_LOG_PATH = join(AULA_DIR, 'logs', 'brief.jsonl');
const SOURCE_ROOT = join(import.meta.dir, '..', '..');

export type SourceRevision = {
  commit: string | null;
  dirty: boolean | null;
};

export type BriefLogEvent = {
  at: string;
  event: 'brief.model.failed' | 'brief.model.incomplete';
  day: string;
  isoWeek: string;
  model: string | null;
  effort: string | null;
  useCache: boolean;
  details: unknown;
};

export type BriefLogResult =
  { ok: true; path: string } | { ok: false; path: string; error: string };

/** Identify the checked-out source without making diagnostics depend on Git. */
export function sourceRevision(root: string = SOURCE_ROOT): SourceRevision {
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2_000 });

  try {
    const revision = run(['rev-parse', '--verify', 'HEAD']);
    const commit = revision.status === 0 ? revision.stdout.trim() : '';
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) return { commit: null, dirty: null };

    const status = run(['status', '--porcelain', '--untracked-files=normal']);
    return { commit, dirty: status.status === 0 ? status.stdout.length > 0 : null };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** JSON-safe error detail, including ClaudeRunError's process diagnostics. */
export function errorForBriefLog(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { message: errorMessage(value) };
  const error = value as Error & { cause?: unknown; details?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(error.cause !== undefined ? { cause: errorForBriefLog(error.cause) } : {}),
  };
}

/**
 * Append without endangering the overview itself. The caller reports a failed
 * log write in the terminal, but never adds developer diagnostics to the page.
 */
export function appendBriefLog(
  event: BriefLogEvent,
  path: string = BRIEF_LOG_PATH,
  revision: SourceRevision = sourceRevision(),
): BriefLogResult {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    appendFileSync(path, `${JSON.stringify({ ...event, revision })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, error: errorMessage(err) };
  }
}
