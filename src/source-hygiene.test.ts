/**
 * Bytes that should never be in the source.
 *
 * This repo has shipped invisible characters twice: a raw NUL used as a cache
 * key delimiter, and raw ETX/DEL in the raw-mode stdin switch of a password
 * prompt that has since been deleted. Both were legitimate values written the
 * wrong way — `'\x03'` says the same thing to the
 * compiler and something quite different to a reviewer. Git also treats a file
 * containing a NUL as binary, which silently costs you diffs, blame and merges.
 *
 * The Unicode half is the Trojan Source class: bidirectional overrides and
 * zero-width characters can make code read as something other than what it
 * compiles to. Neither is hypothetical in a repo whose input is prose written
 * by other people.
 *
 * The patterns below are spelled with escapes for the same reason the source
 * they check has to be: a character class written with the literal characters
 * would be unreadable, and this file would fail its own test.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const SRC = new URL('.', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (extname(entry.name) === '.ts') out.push(path);
  }
  return out;
}

/** C0 and C1, less the three whitespace characters source is allowed to use. */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

/** Soft hyphen, zero-width and bidi controls, word joiners, BOM at any offset. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** Reports the offending file with the line and codepoint, not just a boolean. */
function scan(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const found = line.match(pattern);
      if (!found) continue;
      const point = found[0].codePointAt(0) ?? 0;
      hits.push(`${file}:${index + 1} U+${point.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return hits;
}

describe('source hygiene', () => {
  const files = sourceFiles(SRC);

  test('the scan actually reaches the source', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test('no raw control characters', () => {
    expect(scan(files, CONTROL)).toEqual([]);
  });

  test('no invisible or bidirectional Unicode', () => {
    expect(scan(files, INVISIBLE)).toEqual([]);
  });
});
