import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { ClaudeRunError } from '../llm/claude.ts';
import { appendBriefLog, errorForBriefLog, sourceRevision } from './log.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('appends private JSONL diagnostics outside the overview', () => {
  const root = mkdtempSync(join(tmpdir(), 'aula-brief-log-'));
  dirs.push(root);
  const path = join(root, 'logs', 'brief.jsonl');
  const result = appendBriefLog(
    {
      at: '2026-08-24T14:05:00.000Z',
      event: 'brief.model.failed',
      day: '2026-08-24',
      isoWeek: '2026-W35',
      model: null,
      effort: null,
      useCache: true,
      details: { message: 'overloaded' },
    },
    path,
    { commit: '0123456789abcdef0123456789abcdef01234567', dirty: false },
  );

  expect(result).toEqual({ ok: true, path });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    event: 'brief.model.failed',
    revision: {
      commit: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
    },
    details: { message: 'overloaded' },
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
});

test('reports when the logged revision has uncommitted changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'aula-brief-revision-'));
  dirs.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
  };

  git('init', '--quiet');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'user.name', 'Aula tests');
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  git('add', 'tracked.txt');
  git('commit', '--quiet', '-m', 'fixture');

  expect(sourceRevision(root)).toMatchObject({
    commit: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    dirty: false,
  });

  writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  const revision = sourceRevision(root);

  expect(revision.commit).toMatch(/^[0-9a-f]{40,64}$/);
  expect(revision.dirty).toBe(true);
});

test('preserves Claude process output and the stack for after-the-fact debugging', () => {
  const error = new ClaudeRunError('claude -p exited 1: overloaded', {
    timeoutMs: 240_000,
    model: null,
    effort: null,
    schemaRequested: true,
    attempts: [
      {
        stdout: '{"is_error":true,"result":"overloaded"}',
        stderr: 'request id: abc',
        code: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
  });

  expect(errorForBriefLog(error)).toMatchObject({
    name: 'ClaudeRunError',
    message: 'claude -p exited 1: overloaded',
    details: {
      schemaRequested: true,
      attempts: [{ code: 1, stderr: 'request id: abc' }],
    },
  });
  expect(errorForBriefLog(error).stack).toContain('ClaudeRunError');
});
