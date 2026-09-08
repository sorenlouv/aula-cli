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
  delete process.env.FAKE_CLAUDE_LOG;
});

afterAll(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOOL = 'mcp__claude_ai_Google_Calendar__list_events';

const FROM = '2026-09-08T00:00:00+02:00';
const TO = '2026-09-22T00:00:00+02:00';

/** Scripts one `claude` session and runs a real `listEvents` against it. */
function sessionOf(lines: unknown[]): Promise<unknown[]> {
  return sessionsOf([lines]);
}

/**
 * Scripts one session per `claude` call and runs a real `listEvents`.
 *
 * More than one only matters for a paginated read, where page 2 is its own
 * process asking with a `pageToken` — and the whole point of the pagination
 * fix is that the second call is really made.
 */
function sessionsOf(sessions: unknown[][]): Promise<unknown[]> {
  const dir = mkdtempSync(join(tmpdir(), 'aula-stream-'));
  dirs.push(dir);
  const file = join(dir, 'session.ndjson');
  const write = (path: string, lines: unknown[]) =>
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  write(file, sessions[0]!);
  sessions.forEach((lines, index) => write(`${file}.${index + 1}`, lines));
  writeFileSync(join(dir, 'calls.log'), '');
  process.env.FAKE_CLAUDE_STREAM_FILE = file;
  process.env.FAKE_CLAUDE_LOG = join(dir, 'calls.log');
  return listEvents('a@b.c', FROM, TO, { timeoutMs: 20_000 });
}

const init = (servers: { name: string; status: string }[]) => ({
  type: 'system',
  subtype: 'init',
  mcp_servers: servers,
});

/** A session that calls the tool with the arguments this code asks for. */
const callAnd = (payload: string, pageToken?: string) => [
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
            startTime: FROM,
            endTime: TO,
            pageSize: 250,
            ...(pageToken === undefined ? {} : { pageToken }),
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

  /**
   * The read-only promise, kept by the transport rather than by the prompt.
   * The deny list in `WRITE_TOOLS` is by name and goes stale the moment the
   * connector grows a fifth way to write; this notices any tool that was not
   * asked for, whatever it is called.
   */
  test('a session that reached for another tool is refused, not quietly filtered', async () => {
    const lines = callAnd('{"events":[]}');
    const reached = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_evil',
            name: 'mcp__claude_ai_Gmail__send_message',
            input: {},
          },
        ],
      },
    };
    await expect(
      sessionOf([
        init([{ name: 'claude.ai Google Calendar', status: 'connected' }]),
        reached,
        ...lines,
      ]),
    ).rejects.toThrow(/send_message/);
  });

  /** ToolSearch is the exception, because a deferred MCP tool needs it. */
  test('the ToolSearch that reaches the deferred tool is not held against it', async () => {
    const search = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_s', name: 'ToolSearch', input: { query: 'x' } }],
      },
    };
    const events = await sessionOf([
      init([{ name: 'claude.ai Google Calendar', status: 'connected' }]),
      search,
      ...callAnd('{"events":[{"id":"e1"}]}'),
    ]);
    expect(events).toEqual([{ id: 'e1' }]);
  });

  test('a tool called with arguments we did not ask for is rejected, not read', async () => {
    const lines = callAnd('{"events":[]}');
    const call = lines[0] as { message: { content: { input: Record<string, unknown> }[] } };
    call.message.content[0]!.input.calendarId = 'somebody-else@b.c';
    await expect(
      sessionOf([init([{ name: 'claude.ai Google Calendar', status: 'connected' }]), ...lines]),
    ).rejects.toThrow(/somebody-else/);
  });

  /**
   * A truncated fortnight must never pass for a quiet one — and the way it
   * used to avoid that was to throw the whole calendar away. A busy shared
   * calendar lost fourteen days rather than its 251st appointment.
   */
  test('a next page is followed, not treated as too much calendar', async () => {
    const connected = init([{ name: 'claude.ai Google Calendar', status: 'connected' }]);
    const events = await sessionsOf([
      [connected, ...callAnd('{"events":[{"id":"e1"}],"nextPageToken":"p2"}')],
      [connected, ...callAnd('{"events":[{"id":"e2"}]}', 'p2')],
    ]);
    expect(events).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  });

  /**
   * Following pages is not unbounded. Each one is a whole `claude` subprocess,
   * so a calendar that never stops paging has to end as a named complaint
   * rather than as a morning spent reading it.
   */
  test('an endless pager is refused once the page budget is spent', async () => {
    const connected = init([{ name: 'claude.ai Google Calendar', status: 'connected' }]);
    // Every page points at the next, and each session repeats the pageToken the
    // previous one handed out, so the argument check keeps passing.
    await expect(
      sessionsOf([
        [connected, ...callAnd('{"events":[{"id":"e1"}],"nextPageToken":"p"}')],
        [connected, ...callAnd('{"events":[{"id":"e2"}],"nextPageToken":"p"}', 'p')],
        [connected, ...callAnd('{"events":[{"id":"e3"}],"nextPageToken":"p"}', 'p')],
        [connected, ...callAnd('{"events":[{"id":"e4"}],"nextPageToken":"p"}', 'p')],
      ]),
    ).rejects.toThrow(/flere end 4 sider/);
  });
});
