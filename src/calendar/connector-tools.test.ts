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
});
