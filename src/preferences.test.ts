import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPreference,
  DEFAULT_PREFERENCES,
  loadPreferences,
  MAX_PREFERENCES,
  parsePreferences,
  readPreferences,
  removePreference,
  resetPreferences,
  writePreferences,
} from './preferences.ts';

const dirs: string[] = [];
function prefsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-prefs-test-'));
  dirs.push(dir);
  // Nested, so the writer has to create the directory it lives in.
  return join(dir, 'aula', 'preferences.md');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A path whose file already exists and is empty — no defaults in the way. */
function blank(): string {
  const path = prefsPath();
  writePreferences([], path);
  return path;
}

const JOHN = 'beskeder fra John (Hjaltes far) er altid vigtige';

describe('preferences.md', () => {
  test('a missing file is an empty list, not an error', () => {
    expect(readPreferences(prefsPath())).toEqual([]);
  });

  test('an emptied list writes an empty file, not a stub', () => {
    const path = prefsPath();
    writePreferences([], path);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readPreferences(path)).toEqual([]);
  });

  test('the file holds the list and nothing else', () => {
    const path = prefsPath();
    writePreferences([JOHN], path);
    expect(readFileSync(path, 'utf8')).toBe(`- ${JOHN}\n`);
  });

  test('remembers a wish, and reads it back verbatim', () => {
    const path = blank();
    const result = addPreference(JOHN, path);
    expect(result).toEqual({ added: true, text: JOHN, preferences: [JOHN] });
    expect(readPreferences(path)).toEqual([JOHN]);
  });

  test('a wish is one line, however it was pasted', () => {
    const path = blank();
    addPreference('  beskeder fra John\n  er altid vigtige  ', path);
    expect(readPreferences(path)).toEqual(['beskeder fra John er altid vigtige']);
  });

  test('a leading bullet is the users, not ours', () => {
    const path = blank();
    addPreference('- ingen billeder, tak', path);
    expect(readFileSync(path, 'utf8')).toBe('- ingen billeder, tak\n');
  });

  test('the same wish twice says so rather than writing it twice', () => {
    const path = blank();
    addPreference(JOHN, path);
    const second = addPreference(JOHN.toUpperCase(), path);
    expect(second.added).toBe(false);
    expect(readPreferences(path)).toEqual([JOHN]);
  });

  test('an empty wish is a usage error, not an empty line in the file', () => {
    const path = prefsPath();
    expect(() => addPreference('   ', path)).toThrow(/aula remember/);
    expect(readPreferences(path)).toEqual([]);
  });

  test('the list is capped, and says how to make room', () => {
    const path = prefsPath();
    writePreferences(
      Array.from({ length: MAX_PREFERENCES }, (_, i) => `ønske nummer ${i + 1}`),
      path,
    );
    expect(() => addPreference('én til', path)).toThrow(/aula forget/);
  });

  test('forget takes the number the listing shows', () => {
    const path = prefsPath();
    writePreferences(['først', 'anden', 'tredje'], path);
    expect(removePreference(2, path)).toEqual({
      removed: 'anden',
      preferences: ['først', 'tredje'],
    });
    expect(readPreferences(path)).toEqual(['først', 'tredje']);
  });

  test('forgetting a number that is not there names the range', () => {
    const path = prefsPath();
    writePreferences(['først'], path);
    expect(() => removePreference(7, path)).toThrow(/1–1/);
    expect(() => removePreference(0, path)).toThrow(/1–1/);
    // …and says something more useful when there is nothing at all.
    expect(() => removePreference(1, blank())).toThrow(/Nothing is remembered yet/);
  });

  test('a line typed by hand counts, with or without the dash', () => {
    // The failure this replaced: the file invited hand-editing, the parser took
    // bullets only, and a line typed without a dash was dropped in silence —
    // the worst possible outcome for a preference file.
    expect(
      parsePreferences(
        [
          '# Mine præferencer',
          '',
          'jeg vil gerne se billeder',
          '* ingen fællesbeskeder',
          '  - John er vigtig',
          '-',
          '- ',
          '',
        ].join('\n'),
      ),
    ).toEqual(['jeg vil gerne se billeder', 'ingen fællesbeskeder', 'John er vigtig']);
  });

  test('an unreadable file never stops the brief', () => {
    // Whatever is in there, reading it is not allowed to throw: the 06:30 run
    // has nobody watching, and a broken preference must not cost the overview.
    const path = prefsPath();
    writePreferences([JOHN], path);
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]));
    expect(() => readPreferences(path)).not.toThrow();
    rmSync(path);
    expect(readPreferences(path)).toEqual([]);
  });

  test('written readable only by the owner: these lines name other peoples children', () => {
    const path = prefsPath();
    writePreferences([JOHN], path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('an empty wish is refused before the file is even created', () => {
    const path = prefsPath();
    expect(() => addPreference('', path)).toThrow();
    expect(readPreferences(path)).toEqual([]);
  });
});

describe('the opinions aula-cli ships with', () => {
  test('are seeded into the file on first use, not hidden in a prompt', () => {
    const path = prefsPath();
    expect(readPreferences(path)).toEqual([]);
    expect(loadPreferences(path)).toEqual([...DEFAULT_PREFERENCES]);
    // On disk from now on, in the same format as anything the user adds.
    expect(readPreferences(path)).toEqual([...DEFAULT_PREFERENCES]);
  });

  test('include the municipal rule — the opinion most likely to be wrong for someone', () => {
    // It used to be a line in the extraction prompt reading "aldrig relevant",
    // which no user could reach. It is now line 5 of their own list.
    expect(DEFAULT_PREFERENCES.some((line) => /kommunen/i.test(line))).toBe(true);
  });

  test('a default the user drops stays dropped', () => {
    const path = prefsPath();
    const seeded = loadPreferences(path);
    const municipal = seeded.findIndex((line) => /kommunen/i.test(line));
    removePreference(municipal + 1, path);
    expect(loadPreferences(path).some((line) => /kommunen/i.test(line))).toBe(false);
  });

  test('an emptied list stays empty — seeding happens once, not every run', () => {
    const path = prefsPath();
    writePreferences([], path);
    expect(loadPreferences(path)).toEqual([]);
  });

  test('remember and forget count from what the listing shows, defaults included', () => {
    const path = prefsPath();
    const added = addPreference(JOHN, path);
    expect(added.preferences).toEqual([...DEFAULT_PREFERENCES, JOHN]);
    expect(removePreference(DEFAULT_PREFERENCES.length + 1, path).removed).toBe(JOHN);
  });
});

describe('reset', () => {
  test('restores the shipped list, whatever was done to it', () => {
    const path = prefsPath();
    writePreferences(['kun mine egne', 'og en til'], path);
    expect(resetPreferences(path).preferences).toEqual([...DEFAULT_PREFERENCES]);
    expect(readPreferences(path)).toEqual([...DEFAULT_PREFERENCES]);
  });

  test('reports what it threw away, so it can be typed back in', () => {
    const path = prefsPath();
    loadPreferences(path);
    addPreference(JOHN, path);
    removePreference(1, path);
    const { dropped, preferences } = resetPreferences(path);
    expect(dropped).toEqual([JOHN]);
    // …including the default that had been deleted, which is back.
    expect(preferences).toEqual([...DEFAULT_PREFERENCES]);
  });

  test('a list that is already the defaults loses nothing', () => {
    const path = prefsPath();
    loadPreferences(path);
    expect(resetPreferences(path).dropped).toEqual([]);
  });

  test('works on an install that has no file yet', () => {
    const path = prefsPath();
    expect(resetPreferences(path).preferences).toEqual([...DEFAULT_PREFERENCES]);
  });
});
