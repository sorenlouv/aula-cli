#!/usr/bin/env bun
/**
 * `bun run scan:private` — refuse a tracked file that names the real family.
 *
 * This repository is public and the data it works with is personal, so the
 * denylist of real names lives in gitignored `data/private-terms.txt` (see
 * `data/README.md`). That file cannot be in CI, which is why this is a local
 * check: run it before a commit that touched a fixture, a test, a doc or an
 * example, and a term that slipped in fails the run.
 *
 * Every term is matched as a whole word, case-insensitively, tolerating the
 * Danish genitive `-s` ("Almas"). Only the file and line are printed — never
 * the term or the line's text — so the output is safe in a log or a chat.
 *
 * Tracked files only, as git sees them: the runtime data in `~/.aula` and the
 * captures in `data/` are outside the question this answers.
 *
 * One exemption, derived rather than listed: the words of `package.json`'s
 * `author` are the one name this public, MIT-licensed repository carries on
 * purpose — the copyright line, the author field, a comment about whose laptop
 * a test needs. The list may still carry them, so a surname shared with the
 * children stays caught wherever it is not the author's own full name.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/**
 * The list lives beside the primary checkout's `data/`, and a worktree — where
 * every feature is implemented — has a `data/` of its own that does not have
 * it. So look in this checkout first, then in the checkout that owns the
 * shared `.git`, which `git rev-parse --git-common-dir` names.
 */
function termsPath(): string | null {
  const local = join(ROOT, 'data', 'private-terms.txt');
  if (existsSync(local)) return local;
  const result = Bun.spawnSync({
    cmd: ['git', 'rev-parse', '--git-common-dir'],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return null;
  const common = resolve(ROOT, result.stdout.toString('utf8').trim());
  const primary = join(common, '..', 'data', 'private-terms.txt');
  return existsSync(primary) ? primary : null;
}

/** Binary and vendored bytes are not prose; the lockfile has no prose either. */
const SKIP = /\.(png|jpg|jpeg|gif|ico|woff2?|lock)$|^bun\.lock$/;

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync({ cmd: ['git', 'ls-files', '-z'], cwd: ROOT, stdout: 'pipe' });
  if (result.exitCode !== 0) throw new Error('git ls-files failed');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function main(): number {
  const termsFile = termsPath();
  if (termsFile === null) {
    console.error(
      'No data/private-terms.txt here or in the primary checkout; nothing to scan against. That is a fresh clone, not a pass.',
    );
    return 0;
  }
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const authorField =
    typeof manifest === 'object' && manifest !== null && 'author' in manifest
      ? manifest.author
      : undefined;
  const author = typeof authorField === 'string' ? authorField : '';
  const authorWords = new Set(
    author
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase()),
  );
  const isAuthor = (term: string) =>
    term.toLowerCase() === author.toLowerCase() || authorWords.has(term.toLowerCase());
  const terms = readFileSync(termsFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !isAuthor(line));
  // A hyphen binds: a surname is a whole word before a space or a full stop,
  // and not inside the author's own hyphenated one, which the exemption above
  // already covers whole.
  const patterns = terms.map(
    (term) => new RegExp(`(?<![\\p{L}\\p{N}-])${escape(term)}s?(?![\\p{L}\\p{N}-])`, 'iu'),
  );

  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : trackedFiles();
  let hits = 0;
  for (const file of files) {
    if (SKIP.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (patterns.some((pattern) => pattern.test(line))) {
        console.log(`${file}:${index + 1}`);
        hits += 1;
      }
    }
  }
  if (hits > 0) {
    console.error(
      `${hits} line(s) name a private term. Invent a name instead; see data/README.md.`,
    );
    return 1;
  }
  console.log(`${files.length} tracked file(s) scanned against ${terms.length} term(s): clean.`);
  return 0;
}

process.exit(main());
