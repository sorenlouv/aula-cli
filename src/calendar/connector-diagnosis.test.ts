/**
 * What the connector concludes from a session it did not get an answer out of.
 *
 * `parseStream` was well covered and `attemptTool` was not at all, which is how
 * the race this file's sibling now fixes survived: every unit here was correct,
 * and the sentence the user read — "the Google Calendar connection in Claude is
 * missing" — was produced by the one seam nothing exercised. Each test drives a
 * whole `listEvents` against a scripted `claude` session and asserts the
 * *diagnosis*, because the diagnosis is the product. A wrong one sends a parent
 * to reconnect something that was never disconnected.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeClaude } from '../testing/fake-claude.ts';
import { CalendarNotConnectedError, listEvents } from './connector.ts';

const ORIGINAL_PATH = process.env.PATH;
const dirs: string[] = [];

beforeAll(() => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'aula-fake-claude-'));
  dirs.push(fakeDir);
  process.env.PATH = installFakeClaude(fakeDir).path;
  process.env.FAKE_CLAUDE_MODE = 'stream';
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_STREAM_FILE;
});

afterAll(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOOL = 'mcp__claude_ai_Google_Calendar__list_events';

/** Scripts one `claude` session and runs a real `listEvents` against it. */
function sessionOf(lines: unknown[]): Promise<unknown[]> {
  const dir = mkdtempSync(join(tmpdir(), 'aula-stream-'));
  dirs.push(dir);
  const file = join(dir, 'session.ndjson');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  process.env.FAKE_CLAUDE_STREAM_FILE = file;
  return listEvents('a@b.c', '2026-09-08T00:00:00+02:00', '2026-09-22T00:00:00+02:00', {
    timeoutMs: 20_000,
  });
}

const init = (servers: { name: string; status: string }[]) => ({
  type: 'system',
  subtype: 'init',
  mcp_servers: servers,
});

const callAnd = (payload: string) => [
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: TOOL,
          input: {
            calendarId: 'a@b.c',
            startTime: '2026-09-08T00:00:00+02:00',
            endTime: '2026-09-22T00:00:00+02:00',
            pageSize: 250,
          },
        },
      ],
    },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: payload }] },
  },
];

describe('what the connector concludes', () => {
  test('a session with the server and the call is simply read', async () => {
    const events = await sessionOf([
      init([{ name: 'claude.ai Google Calendar', status: 'connected' }]),
      ...callAnd('{"events":[{"id":"e1"}]}'),
    ]);
    expect(events).toEqual([{ id: 'e1' }]);
  });

  test('a populated server list without ours means not connected', async () => {
    await expect(
      sessionOf([init([{ name: 'claude.ai Gmail', status: 'connected' }])]),
    ).rejects.toThrow(CalendarNotConnectedError);
  });

  /**
   * The gap. `needs-auth` is the connector whose Google grant has lapsed — the
   * one state where "reconnect it" is the right thing to say — and it used to
   * fall past the status check into the generic branch, which reported
   * `list_events blev aldrig kaldt`. True, and no help to anybody.
   */
  test('a connector whose grant has lapsed says so, not "never called"', async () => {
    await expect(
      sessionOf([init([{ name: 'claude.ai Google Calendar', status: 'needs-auth' }])]),
    ).rejects.toThrow(/needs-auth/);
  });

  test('a tool called with arguments we did not ask for is rejected, not read', async () => {
    const lines = callAnd('{"events":[]}');
    const call = lines[0] as { message: { content: { input: Record<string, unknown> }[] } };
    call.message.content[0]!.input.calendarId = 'somebody-else@b.c';
    await expect(
      sessionOf([init([{ name: 'claude.ai Google Calendar', status: 'connected' }]), ...lines]),
    ).rejects.toThrow(/somebody-else/);
  });

  /** A truncated fortnight must never pass for a quiet one. */
  test('a paginated answer is an error rather than a short calendar', async () => {
    await expect(
      sessionOf([
        init([{ name: 'claude.ai Google Calendar', status: 'connected' }]),
        ...callAnd('{"events":[{"id":"e1"}],"nextPageToken":"more"}'),
      ]),
    ).rejects.toThrow(/flere sider/);
  });
});
