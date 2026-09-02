import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeClaude } from '../testing/fake-claude.ts';
import { readConfig, writeConfig } from '../config.ts';
import { deployArtifact, deployPrompt, isArtifactUrl, readTarget, setTarget } from './deploy.ts';

const VALID = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = 'https://claude.ai/code/artifact/ffffffff-ffff-ffff-ffff-ffffffffffff';

const dirs: string[] = [];

/** A config path that belongs to the test, never to ~/.aula. */
function configPath(url?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-deploy-test-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  if (url !== undefined) writeConfig({ artifactUrl: url }, path);
  return path;
}

const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'aula-fake-claude-'));
  dirs.push(fakeDir);
  process.env.PATH = installFakeClaude(fakeDir).path;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_RESULT_JSON;
  delete process.env.FAKE_CLAUDE_LOG;
  for (const dir of dirs.splice(1)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Points the fake at a fresh call log and returns a reader for it. */
function fakeClaude(mode: string, result?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aula-fake-log-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_LOG = log;
  if (result !== undefined) process.env.FAKE_CLAUDE_RESULT_JSON = JSON.stringify(result);
  return { calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('readTarget / setTarget', () => {
  test('is null when nothing is configured — hosting is opt-in', () => {
    expect(readTarget(configPath())).toBeNull();
  });

  test('reads what setTarget wrote, and null turns hosting off', () => {
    const path = configPath();
    setTarget(VALID, path);
    expect(readTarget(path)).toBe(VALID);
    expect(readConfig(path)).toEqual({ artifactUrl: VALID });
    setTarget(null, path);
    expect(readTarget(path)).toBeNull();
  });
});

describe('isArtifactUrl', () => {
  test('accepts exactly the artifact shape and nothing glued on', () => {
    expect(isArtifactUrl(VALID)).toBe(true);
    expect(isArtifactUrl(`${VALID}/../../evil`)).toBe(false);
    expect(isArtifactUrl('https://example.com/somewhere-else')).toBe(false);
    expect(isArtifactUrl(`${VALID}?x=1`)).toBe(false);
  });
});

describe('deployArtifact', () => {
  test('reports an unconfigured target rather than skipping quietly', async () => {
    // A lost `artifactUrl` used to be indistinguishable from `--no-deploy`, so
    // the brief kept reporting success while the shared link went stale. The
    // status has to say which of the two happened, and the reason has to name
    // the command that fixes it.
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(),
    });
    expect(result.status).toBe('unconfigured');
    expect(result.status === 'unconfigured' && result.reason).toContain('publish');
  });

  test('refuses a target that is not an artifact url', async () => {
    // Without this the prompt would carry an arbitrary URL into a subprocess
    // holding a publishing tool.
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath('https://example.com/somewhere-else'),
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('ugyldig');
  });

  test('succeeds only when the reply names the target url', async () => {
    const fake = fakeClaude('ok', VALID);
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
    });
    expect(result).toEqual({ status: 'ok', url: VALID });
    const [call] = fake.calls();
    expect(call).toContain('--tools Artifact Read');
    // Read is permitted for the artifact alone, spelled as an absolute-path rule.
    expect(call).toContain('--allowedTools Artifact Read(//tmp/artifact.html)');
    expect(call).not.toMatch(/Read\(\/\/tmp\/artifact\.html\)\s+\S*Read/);
    expect(call).toContain('--output-format json');
    expect(call).toContain('read it if you need to');
  });

  test('a reply naming some other url is a failure, not a success', async () => {
    fakeClaude('ok', OTHER);
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
    });
    expect(result.status).toBe('failed');
  });

  test('a refused Artifact tool is reported as such', async () => {
    fakeClaude('denied');
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
    });
    expect(result.status === 'failed' && result.reason).toContain('Artifact');
  });

  test('an error envelope surfaces its text', async () => {
    fakeClaude('error');
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
    });
    expect(result.status === 'failed' && result.reason).toContain('Not logged in');
  });

  test('a stalled process is killed and tried once more in a fresh one', async () => {
    const fake = fakeClaude('stall-then-ok', VALID);
    const started = Date.now();
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
      timeoutMs: 300,
      graceMs: 200,
    });
    expect(result).toEqual({ status: 'ok', url: VALID });
    expect(fake.calls()).toHaveLength(2);
    // The stall cost the timeout plus the drain grace, not the orphan's lifetime.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('two stalls are a bounded failure, even when the process ignores SIGTERM', async () => {
    const fake = fakeClaude('stall-ignore-term');
    const started = Date.now();
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(VALID),
      timeoutMs: 300,
      graceMs: 200,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toContain('2 forsøg');
    expect(fake.calls()).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test('with `create`, the reply is where the url comes from', async () => {
    const fake = fakeClaude('ok', `Published: ${VALID}`);
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(),
      create: true,
    });
    expect(result).toEqual({ status: 'ok', url: VALID });
    // And the prompt asked for a new artifact, not an update.
    expect(fake.calls()[0]).not.toContain('force: true');
  });

  test('with `create`, a reply naming two urls is not trusted', async () => {
    fakeClaude('ok', `${VALID} or maybe ${OTHER}`);
    const result = await deployArtifact('/tmp/artifact.html', {
      title: 'T',
      configPath: configPath(),
      create: true,
    });
    expect(result.status).toBe('failed');
  });
});

describe('deployPrompt', () => {
  test('names the file and the target, and grants nothing else', () => {
    const prompt = deployPrompt('/Users/x/.aula/brief/artifact.html', VALID, 'Aula AI oversigt');
    expect(prompt).toContain('/Users/x/.aula/brief/artifact.html');
    expect(prompt).toContain(VALID);
    expect(prompt).toContain('force: true');
    expect(prompt).toContain('exactly one Artifact tool call');
    expect(prompt).toContain('do not call any other tool');
  });

  test('without a target it asks for a new artifact and no force', () => {
    const prompt = deployPrompt('/tmp/artifact.html', null, 'Aula AI oversigt');
    expect(prompt).toContain('new artifact');
    expect(prompt).not.toContain('url:');
    expect(prompt).not.toContain('force');
  });

  test('carries no text read out of Aula', () => {
    // The whole page is other people's prose. If any of it reached the prompt,
    // a school post would be able to steer what gets published — so the only
    // interpolated values are ones this module produced.
    for (const url of [VALID, null]) {
      const prompt = deployPrompt('/tmp/artifact.html', url, 'Aula AI oversigt');
      const interpolated = ['/tmp/artifact.html', VALID, 'Aula AI oversigt'];
      for (const line of prompt.split('\n')) {
        const stripped = interpolated.reduce((acc, value) => acc.replaceAll(value, ''), line);
        expect(stripped).not.toMatch(/[ÆØÅæøå]/);
      }
    }
  });
});
