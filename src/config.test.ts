import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, updateConfig, writeConfig } from './config.ts';

const URL = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const dirs: string[] = [];
function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-config-test-'));
  dirs.push(dir);
  // A nested path, so the writer has to create the directory it lives in.
  return join(dir, 'aula', 'config.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config.json', () => {
  test('a missing file is an empty config, not an error', () => {
    expect(readConfig(configPath())).toEqual({});
  });

  test('a corrupt file is an empty config too — a broken preference must not stop the brief', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, '{not json');
    expect(readConfig(path)).toEqual({});
  });

  test('a non-string url is ignored, a padded one is trimmed', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, JSON.stringify({ artifactUrl: 42 }));
    expect(readConfig(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ artifactUrl: `  ${URL}\n` }));
    expect(readConfig(path)).toEqual({ artifactUrl: URL });
  });

  test('writes create the file and its directory, readable only by the owner', () => {
    const path = configPath();
    writeConfig({ artifactUrl: URL }, path);
    expect(readConfig(path)).toEqual({ artifactUrl: URL });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('config.json holds more than one preference', () => {
  const CALENDARS = [{ id: 'far@eksempel.dk', name: 'Familien' }];

  test('calendars survive a publish — the one that used to eat them', () => {
    const path = configPath();
    updateConfig({ calendars: CALENDARS }, path);
    // `aula publish` goes through setTarget → updateConfig, and the earlier
    // version rebuilt the file from `artifactUrl` alone.
    updateConfig({ artifactUrl: URL }, path);
    expect(readConfig(path)).toEqual({ artifactUrl: URL, calendars: CALENDARS });
  });

  test('publish --off forgets the URL and nothing else', () => {
    const path = configPath();
    updateConfig({ artifactUrl: URL, calendars: CALENDARS }, path);
    updateConfig({ artifactUrl: undefined }, path);
    expect(readConfig(path)).toEqual({ calendars: CALENDARS });
  });

  test('a key this version knows nothing about is carried through untouched', () => {
    const path = configPath();
    writeConfig({ artifactUrl: URL, somethingNewer: { a: 1 } }, path);
    updateConfig({ calendars: CALENDARS }, path);
    expect(readConfig(path).somethingNewer).toEqual({ a: 1 });
  });

  test('junk calendars are dropped, and duplicates collapse on id', () => {
    const path = configPath();
    // Written as raw JSON rather than through `writeConfig`, because the case
    // being tested is a hand-edited file — which the docs call a supported way
    // to configure this, and which no type can police.
    writeConfig({}, path);
    writeFileSync(
      path,
      JSON.stringify({
        calendars: [
          { id: 'a@example.com', name: 'A' },
          { id: '  ', name: 'blank id' },
          { id: 'a@example.com', name: 'A again' },
          'not an object',
          { id: 'b@example.com' },
        ],
      }),
    );
    expect(readConfig(path).calendars).toEqual([
      { id: 'a@example.com', name: 'A' },
      // No name given: the id is the least-wrong label to show.
      { id: 'b@example.com', name: 'b@example.com' },
    ]);
  });

  test('an empty calendar list reads as absent rather than as an empty array', () => {
    const path = configPath();
    writeConfig({ calendars: [] }, path);
    expect(readConfig(path)).toEqual({});
  });
});
