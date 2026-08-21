import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from './config.ts';

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
