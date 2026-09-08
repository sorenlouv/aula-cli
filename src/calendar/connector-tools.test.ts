/**
 * What the calendar session is allowed to reach.
 *
 * This is the one caller that cannot pass `--strict-mcp-config` — it is calling
 * a configured MCP server, and that flag would drop the very thing being called
 * — so it is also the one whose tool surface has to be argued for rather than
 * assumed. All three assertions below were measured against a real `claude`
 * before being written down; the notes say what came back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeClaude } from '../testing/fake-claude.ts';
import { listCalendars } from './connector.ts';

const ORIGINAL_PATH = process.env.PATH;
const dirs: string[] = [];

beforeAll(() => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'aula-fake-claude-'));
  dirs.push(fakeDir);
  process.env.PATH = installFakeClaude(fakeDir).path;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_LOG;
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_ENV_LOG;
  delete process.env.FAKE_CLAUDE_ENV_KEYS;
});

afterAll(() => {
  if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The argv of the one call a `listCalendars` makes. The fake answers with an
 * envelope this code rejects, which is fine — the call has already been logged
 * by then, and the arguments are the whole subject here.
 */
async function argvOfOneCall(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aula-args-log-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_LOG = log;
  await listCalendars({ timeoutMs: 20_000 }).catch(() => undefined);
  return readFileSync(log, 'utf8');
}

/**
 * The named variables every `claude` a `listCalendars` starts was given — one
 * entry per call, because the fake's envelope is one this code rejects and the
 * retry is therefore also exercised. A variable that has to be set has to be
 * set on the retry too.
 */
async function envOfEveryCall(keys: string[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'aula-env-log-'));
  dirs.push(dir);
  const log = join(dir, 'env.log');
  writeFileSync(log, '');
  process.env.FAKE_CLAUDE_ENV_LOG = log;
  process.env.FAKE_CLAUDE_ENV_KEYS = keys.join(' ');
  await listCalendars({ timeoutMs: 20_000 }).catch(() => undefined);
  return readFileSync(log, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('the calendar session’s tool surface', () => {
  /**
   * `--allowedTools` pre-approves; `--tools` is what removes the built-in set.
   * deploy.ts measured that an allow-list alone still let the agent read any
   * file, and here that mattered doubly: these sessions used to inherit a
   * working directory of `/`, so the file tools were present in a session
   * rooted at the boot volume while it read other people's calendar text.
   */
  test('names --tools, which is what strips Read, Write, Bash and the rest', async () => {
    const argv = await argvOfOneCall();
    expect(argv).toContain('--tools');
    expect(argv).toContain('ToolSearch');
    expect(argv).toContain('mcp__claude_ai_Google_Calendar__list_calendars');
  });

  /**
   * The connector offers four ways to change a calendar and this tool has no
   * business with any of them — the same promise `assertReadOnly` keeps for
   * Aula one layer down.
   */
  test('denies every way the connector can write to a calendar', async () => {
    const argv = await argvOfOneCall();
    expect(argv).toContain('--disallowedTools');
    for (const tool of ['create_event', 'delete_event', 'update_event', 'respond_to_event']) {
      expect(argv).toContain(`mcp__claude_ai_Google_Calendar__${tool}`);
    }
  });

  /**
   * Measured, and the reason the deny list above is written by name: `--tools`
   * filters the built-in set only, so every tool of every *other* connected
   * server — Gmail's `send_message`, Drive's `share_file` — stays in the
   * session's list. They are not pre-approved, so a headless run cannot call
   * one, but that is a property of the permission layer rather than of this
   * argv. If a future `claude` grows a way to allow-list MCP tools, this is the
   * call that should use it.
   */
  test('does not pretend to have restricted the other connectors', async () => {
    const argv = await argvOfOneCall();
    expect(argv).not.toContain('--strict-mcp-config');
  });

  /**
   * The regression, and the only one of these assertions that is about the
   * environment rather than argv — which is why it went unnoticed. A claude.ai
   * connector is fetched from the account at startup and connected
   * fire-and-forget, so the session's tool list is normally assembled before
   * the calendar tool exists. Measured: six runs in seven reported
   * `mcp_servers: []` and never called the tool, and `aula calendars` reported
   * a connector the user had already connected as missing.
   */
  test('waits for the claude.ai connectors instead of racing them', async () => {
    const calls = await envOfEveryCall(['MCP_CONNECTION_NONBLOCKING']);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toEqual(calls.map(() => 'MCP_CONNECTION_NONBLOCKING=false'));
  });
});
