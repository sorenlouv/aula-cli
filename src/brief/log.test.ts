import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { ClaudeRunError } from '../llm/claude.ts';
import { appendBriefLog, errorForBriefLog } from './log.ts';

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
  );

  expect(result).toEqual({ ok: true, path });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    event: 'brief.model.failed',
    details: { message: 'overloaded' },
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
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
