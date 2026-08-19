import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployArtifact, deployPrompt, readTarget } from './deploy.ts';

const VALID = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const dirs: string[] = [];

function tempDir(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-deploy-test-'));
  dirs.push(dir);
  if (contents !== undefined) writeFileSync(join(dir, 'artifact-url'), contents);
  return dir;
}

afterEach(() => {
  delete process.env.AULA_ARTIFACT_URL;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readTarget', () => {
  test('is null when nothing is configured — hosting is opt-in', () => {
    expect(readTarget(tempDir())).toBeNull();
  });

  test('reads the url file, ignoring the trailing newline an editor leaves', () => {
    expect(readTarget(tempDir(`${VALID}\n`))).toBe(VALID);
  });

  test('an empty file counts as unconfigured rather than as an empty url', () => {
    expect(readTarget(tempDir('   \n'))).toBeNull();
  });

  test('the environment overrides the file, so one-off runs can retarget', () => {
    process.env.AULA_ARTIFACT_URL = VALID;
    expect(readTarget(tempDir('https://claude.ai/code/artifact/ffffffff-ffff-ffff-ffff-ffffffffffff'))).toBe(VALID);
  });
});

describe('deployArtifact', () => {
  test('skips silently when no target is configured', async () => {
    const result = await deployArtifact('/tmp/artifact.html', { title: 'T', dir: tempDir() });
    expect(result.status).toBe('skipped');
  });

  test('refuses a target that is not an artifact url', async () => {
    // Without this the prompt would carry an arbitrary URL into a subprocess
    // holding a publishing tool.
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      dir: tempDir('https://example.com/somewhere-else'),
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('ugyldig');
  });

  test('refuses an artifact url with a path glued on', async () => {
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      dir: tempDir(`${VALID}/../../evil`),
    });
    expect(result.status).toBe('failed');
  });
});

describe('deployPrompt', () => {
  test('names the file and the target, and grants nothing else', () => {
    const prompt = deployPrompt('/Users/x/.aula/brief/artifact.html', VALID, 'Aula AI oversigt');
    expect(prompt).toContain('/Users/x/.aula/brief/artifact.html');
    expect(prompt).toContain(VALID);
    expect(prompt).toContain('exactly one Artifact tool call');
    expect(prompt).toContain('do not call any other tool');
  });

  test('carries no text read out of Aula', () => {
    // The whole page is other people's prose. If any of it reached the prompt,
    // a school post would be able to steer what gets published — so the only
    // interpolated values are ones this module produced.
    const prompt = deployPrompt('/tmp/artifact.html', VALID, 'Aula AI oversigt');
    const interpolated = ['/tmp/artifact.html', VALID, 'Aula AI oversigt'];
    for (const line of prompt.split('\n')) {
      const stripped = interpolated.reduce((acc, value) => acc.replaceAll(value, ''), line);
      expect(stripped).not.toMatch(/[ÆØÅæøå]/);
    }
  });
});
