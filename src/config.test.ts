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

  test('a corrupt file is reported instead of treated as empty', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, '{not json');
    expect(() => readConfig(path)).toThrow(/config\.json.*ugyldig/i);
    expect(() => updateConfig({ artifactUrl: URL }, path)).toThrow(/config\.json.*ugyldig/i);
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });

  test('a non-string url is rejected, a padded one is trimmed', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, JSON.stringify({ artifactUrl: 42 }));
    expect(() => readConfig(path)).toThrow(/artifactUrl/);
    writeFileSync(path, JSON.stringify({ artifactUrl: `  ${URL}\n` }));
    expect(readConfig(path)).toEqual({ artifactUrl: URL });
  });

  test('an arbitrary URL is not accepted as an artifact target', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, JSON.stringify({ artifactUrl: 'https://example.com/public-page' }));
    expect(() => readConfig(path)).toThrow(/artifactUrl.*ugyldigt format/);
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

  test('junk or duplicate calendars are rejected rather than silently rewritten', () => {
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
    expect(() => readConfig(path)).toThrow(/calendars\[1\]\.id/);
  });

  test('every configured calendar keeps the displayed name the user selected', () => {
    const path = configPath();
    writeConfig({}, path);
    writeFileSync(path, JSON.stringify({ calendars: [{ id: 'a@example.com' }] }));
    expect(() => readConfig(path)).toThrow(/calendars\[0\]\.name mangler/);
  });

  test('an empty calendar list reads as absent rather than as an empty array', () => {
    const path = configPath();
    writeConfig({ calendars: [] }, path);
    expect(readConfig(path)).toEqual({});
  });
});
