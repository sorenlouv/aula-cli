/**
 * Reading a Google calendar through Claude's own Google Calendar connector.
 *
 * This is the only supported way in, and the pipeline already spawns
 * `claude -p` anyway. Where the user has connected Google Calendar there is
 * nothing left to set up: no Cloud project, no OAuth client, no URL to copy out
 * of a settings page — and it reaches calendars shared *to* the user, which is
 * what a household's shared calendar usually is.
 *
 * The three alternatives were each rejected on a fact worth not rediscovering:
 *
 * - **The Calendar API.** `calendar.readonly` is a sensitive scope. Unverified
 *   in *Testing*, refresh tokens expire after 7 days, which is fatal for an
 *   unattended 06:30 job; verification wants a homepage, a privacy policy and a
 *   demo video, and puts a client secret in a public repository.
 * - **An ICS feed.** Google issues a secret address only for calendars you
 *   *own*, so a partner's shared calendar — the one this feature exists for —
 *   is precisely what it cannot reach. Recurrence would also become ours.
 * - **EventKit.** macOS only, needs a compiled helper in a repository with no
 *   build step, and its permission prompt has nobody to answer it at 06:30.
 *
 * **The model is not asked what the calendar says.** It is asked to place one
 * call, and the connector's own JSON is read straight off the `stream-json`
 * wire — `tool_use` for the arguments it chose, `tool_result` for the payload.
 * Its prose is discarded unread. So this is a transport that happens to need a
 * model to authenticate it, not a model that reports on a calendar, and the
 * difference is the whole reason calendar data is allowed near a page whose
 * worst failure is a quiet omission.
 *
 * What is checked, because each is a way this could lie:
 *
 * - the connector is actually connected (from the session's own `init` line,
 *   so "not set up" never reads as "no appointments");
 * - the tool was called, exactly once, with the arguments we asked for;
 * - the answer is not paginated, so a truncated fortnight cannot pass for a
 *   quiet one.
 *
 * Note the absence of `--strict-mcp-config`, which `deploy.ts` passes: that
 * flag drops the configured MCP servers, which here would remove the very
 * thing being called.
 */

import { errorMessage, isRecord } from '../validation.ts';
import { modelEffortArgs, spawnClaude } from '../llm/claude.ts';
import { googleCalendarToolRequest } from '../llm/requests/google-calendar.ts';
import { wireText } from '../cli-helpers.ts';

/** Generous for a call measured at 8–9s; short enough to cost minutes, not a morning. */
const TIMEOUT_MS = 120_000;

/** How the connector's server announces itself in the session's `init` line. */
const SERVER_MATCH = /google\s*calendar/i;

/** Tool names are the server name with everything non-alphanumeric flattened. */
const TOOL_PREFIX = 'mcp__claude_ai_Google_Calendar__';

/**
 * The connector's mutating half, denied by name.
 *
 * This tool reads calendars; it has no business creating, moving, deleting or
 * RSVPing to an appointment, and the connector offers all four. Aula gets the
 * same treatment one layer down in `assertReadOnly`, and for the same reason:
 * a read-only promise that is only kept by the prompt is not kept.
 *
 * Named rather than pattern-matched because `--disallowedTools` matches a real
 * server or tool name and nothing else — a bare `mcp__` prefix was measured to
 * deny nothing at all. So this list has to be revisited if the connector grows
 * a new way to write; `expectedCalls` below is the backstop that notices a call
 * we did not ask for, whatever its name.
 */
const WRITE_TOOLS = [
  `${TOOL_PREFIX}create_event`,
  `${TOOL_PREFIX}delete_event`,
  `${TOOL_PREFIX}update_event`,
  `${TOOL_PREFIX}respond_to_event`,
];

/**
 * The connector is not connected for this user.
 *
 * Its own error, because it is the one failure with a cure the user can act on
 * — and the only one the setup command turns into instructions rather than a
 * complaint.
 */
export class CalendarNotConnectedError extends Error {
  override readonly name = 'CalendarNotConnectedError';
}

export type ConnectorCalendar = {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  /** `owner` | `writer` | `reader` | `freeBusyReader`. */
  accessRole?: string;
};

/** A valid JSON reply is not necessarily a valid connector reply. */
export function parseCalendarsPayload(payload: unknown): ConnectorCalendar[] {
  if (!isRecord(payload) || !Array.isArray(payload.calendars)) {
    throw new Error('list_calendars svarede uden en calendars-liste');
  }
  return payload.calendars.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new Error(`list_calendars gav en ugyldig kalender på plads ${index + 1}`);
    }
    if (typeof raw.summary !== 'string' || !raw.summary.trim()) {
      throw new Error(`list_calendars gav en kalender uden navn (${raw.id})`);
    }
    return {
      id: raw.id,
      summary: raw.summary,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.timeZone === 'string' ? { timeZone: raw.timeZone } : {}),
      ...(typeof raw.accessRole === 'string' ? { accessRole: raw.accessRole } : {}),
    };
  });
}

/** Events are shaped later, but the envelope itself is a strict contract. */
export function parseEventsPayload(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new Error('list_events svarede uden en events-liste');
  }
  if (payload.nextPageToken !== undefined && typeof payload.nextPageToken !== 'string') {
    throw new Error('list_events gav en ugyldig nextPageToken');
  }
  if (typeof payload.nextPageToken === 'string' && payload.nextPageToken.length > 0) {
    throw new Error('kalenderen gav flere sider end der blev læst — perioden er for lang');
  }
  return payload.events;
}

/** Calendars the connector can see. The whole of the setup flow's discovery. */
export async function listCalendars(
  opts: { timeoutMs?: number } = {},
): Promise<ConnectorCalendar[]> {
  const payload = await callTool('list_calendars', {}, 'Kald list_calendars uden argumenter.', {
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  });
  return parseCalendarsPayload(payload);
}

/** Raw events for one calendar over one window. Shaping is `index.ts`'s job. */
export async function listEvents(
  calendarId: string,
  startTime: string,
  endTime: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const args = { calendarId, startTime, endTime, pageSize: 250 };
  const payload = await callTool(
    'list_events',
    args,
    `Kald list_events med præcis dette JSON-objekt som argument: ${JSON.stringify(args)}`,
    { timeoutMs: opts.timeoutMs ?? TIMEOUT_MS },
  );
  return parseEventsPayload(payload);
}

// --------------------------------------------------------------- transport

/**
 * One tool call, verified.
 *
 * `expected` is compared against what the model actually asked for. A model
 * that widened the window or reached for another calendar is a rejected run,
 * never an interpreted one — the point of this module is that the arguments
 * are ours.
 */
async function callTool(
  tool: string,
  expected: Record<string, unknown>,
  instruction: string,
  opts: { timeoutMs: number },
): Promise<unknown> {
  // A transient gets exactly one fresh process. Measured: the session's `init`
  // envelope reports an empty server list on roughly one run in three, and
  // without a retry that fraction of mornings would lose the calendar.
  let last: Error | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await attemptTool(tool, expected, instruction, opts);
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) throw err;
      if (!(err instanceof CalendarToolUnavailableError || err instanceof CalendarTimeoutError)) {
        throw err;
      }
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (last instanceof CalendarToolUnavailableError) {
    throw new CalendarNotConnectedError('Google Kalender er ikke forbundet i Claude.');
  }
  throw last ?? new Error(`${tool} fejlede`);
}

/** Empty server discovery plus no tool call; retried before it means disconnected. */
class CalendarToolUnavailableError extends Error {
  override readonly name = 'CalendarToolUnavailableError';
}

class CalendarTimeoutError extends Error {
  override readonly name = 'CalendarTimeoutError';
}

async function attemptTool(
  tool: string,
  expected: Record<string, unknown>,
  instruction: string,
  opts: { timeoutMs: number },
): Promise<unknown> {
  const name = `${TOOL_PREFIX}${tool}`;
  const prompt = googleCalendarToolRequest.prompt({ instruction });

  // `claude` needs `$USER` to find its keychain credentials: with `HOME` and
  // `PATH` alone it reports *Not logged in*. launchd supplies it, so the
  // scheduled run is fine — but reproducing that environment with `env -i` and
  // only the plist's variables fails in a way indistinguishable from an expired
  // login. Bisected; `USER` alone is what fixes it.
  const run = await spawnClaude(
    [
      '-p',
      prompt,
      // `--tools` is what removes the built-in set — Read, Write, Bash, Glob and
      // the rest — which `--allowedTools` alone does not: deploy.ts measured
      // that an allow-list on its own still left the agent able to read any
      // file. Here that was not theoretical. These sessions inherited a working
      // directory of `/`, so a session rooted at the boot volume was being
      // handed other people's calendar text with the file tools present, and
      // macOS was asking the family to approve `aula` for their Photos and
      // Music libraries. `spawnClaude` now supplies a cwd of its own; this is
      // the other half.
      //
      // It does not restrict MCP tools: measured, `--tools` leaves every tool
      // of every connected server in the list — Gmail's `send_message` and
      // Drive's `share_file` among them. They are not pre-approved, so a
      // headless run cannot call them, but `--disallowedTools` takes the
      // reachable half off the table rather than trusting that.
      '--tools',
      'ToolSearch',
      name,
      '--disallowedTools',
      ...WRITE_TOOLS,
      // ToolSearch as well: MCP tools are deferred in headless runs, so without
      // it the model can never reach the one tool it is allowed to call.
      '--allowedTools',
      'ToolSearch',
      name,
      '--output-format',
      'stream-json',
      '--verbose',
      ...modelEffortArgs('transport'),
    ],
    { timeoutMs: opts.timeoutMs },
  );

  if (run.timedOut) {
    throw new CalendarTimeoutError(
      `claude -p svarede ikke inden for ${Math.round(opts.timeoutMs / 1000)}s`,
    );
  }

  const stream = parseStream(run.stdout);
  // Only a *populated* server list that lacks ours is evidence of absence. An
  // empty one means the session had not registered its servers yet when the
  // envelope was written — saying "not connected" on that would send somebody
  // off to connect a connector they already have.
  const calendarServer = stream.servers.find((server) => SERVER_MATCH.test(server.name));
  if (stream.servers.length > 0 && !calendarServer) {
    throw new CalendarNotConnectedError('Google Kalender er ikke forbundet i Claude.');
  }
  if (calendarServer?.status && /failed|error|disconnected/i.test(calendarServer.status)) {
    throw new CalendarNotConnectedError(
      `Google Kalender-forbindelsen i Claude svarer ${calendarServer.status}.`,
    );
  }
  if (run.code !== 0 && stream.calls.length === 0) {
    const detail = run.stderr.trim() || run.stdout.trim().slice(0, 200) || '(ingen fejltekst)';
    throw new Error(`claude -p afsluttede med ${run.code}: ${detail}`);
  }

  const calls = stream.calls.filter((call) => call.name === name);
  if (calls.length === 0) {
    if (stream.servers.length === 0)
      throw new CalendarToolUnavailableError(`${tool} blev aldrig kaldt`);
    throw new Error(`${tool} blev aldrig kaldt`);
  }
  if (calls.length > 1) throw new Error(`${tool} blev kaldt ${calls.length} gange`);
  const call = calls[0]!;

  if (!sameToolInput(call.input, expected)) {
    throw new Error(
      `${tool} blev kaldt med ${JSON.stringify(call.input)}, ikke ${JSON.stringify(expected)}`,
    );
  }

  const result = stream.results.get(call.id);
  if (result === undefined) throw new Error(`${tool} gav intet svar`);
  if (result.isError) throw new Error(`${tool} fejlede: ${result.text.slice(0, 200)}`);
  try {
    return JSON.parse(result.text) as unknown;
  } catch (err) {
    throw new Error(`${tool} svarede ikke med JSON: ${errorMessage(err)}`, { cause: err });
  }
}

function sameToolInput(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

type ConnectorServer = { name: string; status: string | null };
type ToolCall = { id: string; name: string; input: Record<string, unknown> };
type ToolResult = { text: string; isError: boolean };

/**
 * `stream-json` is NDJSON, one envelope per line, and this reads only the three
 * things that matter: which MCP servers the session had, which tools were
 * called, and what came back.
 *
 * A line that does not parse is skipped rather than fatal — the format carries
 * progress envelopes this module has no opinion about, and new ones appearing
 * in a `claude` update must not break a calendar read.
 */
export function parseStream(stdout: string): {
  /**
   * The MCP servers the session reported, which may be empty for two different
   * reasons — no init line at all, or an init line written before the servers
   * registered. Neither is evidence that a server is missing; only a populated
   * list without ours is. See `attemptTool`.
   */
  servers: ConnectorServer[];
  calls: ToolCall[];
  results: Map<string, ToolResult>;
} {
  let servers: ConnectorServer[] = [];
  const calls: ToolCall[] = [];
  const results = new Map<string, ToolResult>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    if (
      parsed.type === 'system' &&
      parsed.subtype === 'init' &&
      Array.isArray(parsed.mcp_servers)
    ) {
      servers = parsed.mcp_servers
        .filter(isRecord)
        .map((server) => ({
          name: wireText(server.name),
          status: typeof server.status === 'string' ? server.status : null,
        }))
        .filter((server) => server.name.length > 0);
    }

    const message = parsed.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        calls.push({
          id: block.id,
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
        });
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, {
          text: resultText(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  return { servers, calls, results };
}

/** Tool results arrive as a bare string or as content blocks; both mean the same here. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}
