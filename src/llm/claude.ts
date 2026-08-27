/**
 * The shared Claude CLI transport.
 *
 * Request-specific instructions and schemas live under `llm/requests/`; this
 * file owns only process lifecycle, JSON envelopes and the no-tools structured
 * request path.
 */

import { formatRemedy, type Remedy } from '../errors.ts';
import { cmd } from '../runtime.ts';
import { isRecord } from '../validation.ts';

type ModelPurpose = 'brief' | 'repair' | 'transport';

function modelSettings(purpose: ModelPurpose): {
  model: string | undefined;
  effort: string | undefined;
} {
  const model =
    purpose === 'brief'
      ? process.env.AULA_BRIEF_MODEL
      : purpose === 'repair'
        ? (process.env.AULA_BRIEF_REPAIR_MODEL ?? 'haiku')
        : (process.env.AULA_TOOL_MODEL ?? 'haiku');
  const effort =
    purpose === 'brief'
      ? process.env.AULA_BRIEF_EFFORT
      : purpose === 'repair'
        ? (process.env.AULA_BRIEF_REPAIR_EFFORT ?? 'low')
        : (process.env.AULA_TOOL_EFFORT ?? 'low');
  return { model, effort };
}

/** Extraction, bounded repair, and deterministic tool transport have separate cost dials. */
export function modelEffortArgs(purpose: ModelPurpose = 'brief'): string[] {
  const { model, effort } = modelSettings(purpose);
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

/** How a `claude -p` subprocess ended, before any interpretation of what it said. */
export type ClaudeExit = {
  stdout: string;
  stderr: string;
  code: number;
  /** The deadline passed and the process was killed by this module. */
  timedOut: boolean;
  /** A caller-defined complete answer arrived, then final CLI cleanup exceeded its grace. */
  stoppedAfterOutput: boolean;
  /** Monotonic wall-clock time spent in this `claude -p` subprocess. */
  durationMs: number;
};

type ClaudeExitDiagnostic = ClaudeExit & {
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ClaudeFailureDetails = {
  timeoutMs: number;
  model: string | null;
  effort: string | null;
  schemaRequested: boolean;
  attempts: ClaudeExitDiagnostic[];
};

/** Safe attempt metadata for run-level performance diagnostics. */
export type ClaudeAttempt = Pick<
  ClaudeExit,
  'code' | 'timedOut' | 'stoppedAfterOutput' | 'durationMs'
>;

/** A transport failure whose captured process diagnostics can be logged later. */
export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly details: ClaudeFailureDetails,
  ) {
    super(message);
    this.name = 'ClaudeRunError';
  }
}

/** The one install line, so the three places that offer it cannot drift. */
export const CLAUDE_INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';

/**
 * What to say when `claude` is not there.
 *
 * It is the only program aula-cli needs besides itself, so this is the one
 * dependency failure a user can actually hit — and the one worth naming
 * precisely. `retry` is the command that failed, so the remedy ends with the
 * thing the reader was already trying to do.
 */
export function claudeMissingRemedy(retry: string): Remedy {
  return {
    headline: '`claude` is not installed, and the overview is written with it.',
    detail: 'It is the only program aula-cli needs besides itself.',
    action: 'Install it, then try again:',
    commands: [CLAUDE_INSTALL_COMMAND, retry],
    fallback: 'The Claude desktop app does not provide this command (SETUP.md step 0).',
  };
}

/**
 * `claude` was not on PATH when we went to run it.
 *
 * Distinct from {@link ClaudeRunError} because the two want opposite advice: a
 * run that failed is worth retrying and the morning schedule will do exactly
 * that, while a missing program will still be missing tomorrow. Callers branch
 * on this to stop promising a retry that cannot help.
 */
export class ClaudeMissingError extends Error {
  constructor(retry: string) {
    super(formatRemedy(claudeMissingRemedy(retry)));
    this.name = 'ClaudeMissingError';
  }
}

const DIAGNOSTIC_LIMIT = 32_768;

function diagnosticExit(exit: ClaudeExit): ClaudeExitDiagnostic {
  return {
    ...exit,
    stdout: exit.stdout.slice(0, DIAGNOSTIC_LIMIT),
    stderr: exit.stderr.slice(0, DIAGNOSTIC_LIMIT),
    stdoutTruncated: exit.stdout.length > DIAGNOSTIC_LIMIT,
    stderrTruncated: exit.stderr.length > DIAGNOSTIC_LIMIT,
  };
}

/**
 * Spawns `claude` and bounds both the process and inherited output pipes.
 *
 * SIGTERM is followed by SIGKILL because a sleeping network request can ignore
 * the first signal for minutes. Output is drained while the process runs, then
 * its readers are released even if a plugin child still holds their write end.
 */
export async function spawnClaude(
  args: string[],
  opts: {
    stdin?: string;
    timeoutMs: number;
    graceMs?: number;
    env?: Record<string, string>;
    /** Once true, the CLI gets a short grace to emit its final result and exit. */
    stopWhen?: (stdout: string) => boolean;
    finalizationGraceMs?: number;
  },
): Promise<ClaudeExit> {
  const startedAt = performance.now();
  // A thunk rather than an inline call so the `'pipe'` literals survive
  // inference — `ReturnType<typeof Bun.spawn>` widens them and loses the readers.
  const spawn = () =>
    Bun.spawn(['claude', ...args], {
      stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      // Always explicit: tests change PATH after startup to install a fake CLI.
      env: { ...process.env, ...(opts.env ?? {}) },
    });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (err) {
    // Bun raises this synchronously, and its message is `Executable not found
    // in $PATH: "claude"` — true, but it reads as an internal fault and names
    // no way out. Translate it once, here, rather than letting it surface raw
    // through three different commands.
    if (isRecord(err) && err.code === 'ENOENT') throw new ClaudeMissingError(cmd('new'));
    throw err;
  }

  let timedOut = false;
  let stoppedAfterOutput = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  let finalizationDeadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: 'timeout' | 'complete-output') => {
    if (reason === 'timeout') timedOut = true;
    else stoppedAfterOutput = true;
    proc.kill('SIGTERM');
    hardKill = setTimeout(() => proc.kill('SIGKILL'), opts.graceMs ?? 10_000);
  };
  const deadline = setTimeout(() => terminate('timeout'), opts.timeoutMs);

  const out = proc.stdout.getReader();
  const err = proc.stderr.getReader();
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const draining = Promise.all([
    drain(out, outChunks, () => {
      if (!opts.stopWhen || finalizationDeadline || timedOut) return;
      try {
        const stdout = Buffer.concat(outChunks).toString('utf8');
        if (!opts.stopWhen(stdout)) return;
        clearTimeout(deadline);
        finalizationDeadline = setTimeout(
          () => terminate('complete-output'),
          opts.finalizationGraceMs ?? 10_000,
        );
      } catch {
        // A parser used only for an early-success optimization cannot break the request.
      }
    }),
    drain(err, errChunks),
  ]);
  try {
    const code = await proc.exited;
    await Promise.race([draining, Bun.sleep(1_000)]);
    return {
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      code,
      timedOut,
      stoppedAfterOutput,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(deadline);
    if (finalizationDeadline) clearTimeout(finalizationDeadline);
    if (hardKill) clearTimeout(hardKill);
    for (const reader of [out, err]) reader.cancel().catch(() => {});
  }
}

/** Structural on purpose: Bun's reader type and TypeScript's lib disagree. */
async function drain<T>(
  reader: { read(): Promise<{ done: boolean; value?: T }> },
  into: T[],
  onChunk?: () => void,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        into.push(value);
        onChunk?.();
      }
    }
  } catch {
    // A stream torn down by the kill is the expected end here.
  }
}

/** The `--output-format json` envelope, reduced to what callers act on. */
export type ClaudeReply = {
  text: string;
  isError: boolean;
  structured: unknown;
  denials: string[];
};

export function parseClaudeJson(stdout: string): ClaudeReply | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    if (!isRecord(parsed) || parsed.type !== 'result') return null;
    const denials = Array.isArray(parsed.permission_denials)
      ? parsed.permission_denials
          .filter(isRecord)
          .map((denial) => denial.tool_name)
          .filter((name): name is string => typeof name === 'string')
      : [];
    return {
      text: typeof parsed.result === 'string' ? parsed.result : '',
      isError: parsed.is_error === true,
      structured: parsed.structured_output,
      denials,
    };
  } catch {
    return null;
  }
}

export type ClaudeStreamReply = {
  final: ClaudeReply | null;
  /** Schema-checked tool input whose matching tool result reported success. */
  confirmedStructured: unknown;
};

/** Recover the schema tool's input before Claude CLI's final cleanup finishes. */
export function parseClaudeStreamJson(stdout: string): ClaudeStreamReply {
  let final: ClaudeReply | null = null;
  const pending = new Map<string, unknown>();
  let confirmedStructured: unknown;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === 'result') {
      const parsed = parseClaudeJson(line);
      if (parsed) final = parsed;
      continue;
    }

    if (event.type === 'assistant' && isRecord(event.message)) {
      const content = event.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === 'tool_use' &&
          block.name === 'StructuredOutput' &&
          typeof block.id === 'string'
        ) {
          pending.set(block.id, block.input);
        }
      }
      continue;
    }

    if (event.type === 'user' && isRecord(event.message)) {
      const content = event.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          block.is_error !== true &&
          pending.has(block.tool_use_id)
        ) {
          confirmedStructured = pending.get(block.tool_use_id);
        }
      }
    }
  }

  return { final, confirmedStructured };
}

/**
 * Runs a structured request with every tool disabled.
 *
 * stdin contains untrusted school, parent and calendar prose. `--tools ''`
 * removes built-ins; `--strict-mcp-config` prevents configured MCP servers from
 * putting tools back. A timeout gets one fresh-process retry.
 */
export async function runClaude(
  instructions: string,
  stdin: string,
  opts: {
    timeoutMs?: number;
    graceMs?: number;
    finalizationGraceMs?: number;
    schema?: unknown;
    /** The repair path is deliberately bounded to one fresh process. */
    maxAttempts?: 1 | 2;
    /** Picks the model/effort environment pair without changing the caller's prompt. */
    purpose?: ModelPurpose;
  } = {},
): Promise<{ text: string; structured: unknown; attempts: ClaudeAttempt[] }> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const maxAttempts = opts.maxAttempts ?? 2;
  const streamsStructuredOutput = opts.schema !== undefined;
  const attempts: ClaudeExit[] = [];
  const settings = modelSettings(opts.purpose ?? 'brief');
  const failure = (message: string) =>
    new ClaudeRunError(message, {
      timeoutMs,
      model: settings.model ?? null,
      effort: settings.effort ?? null,
      schemaRequested: opts.schema !== undefined,
      attempts: attempts.map(diagnosticExit),
    });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run = await spawnClaude(
      [
        '-p',
        instructions,
        '--tools',
        '',
        '--strict-mcp-config',
        '--safe-mode',
        '--no-session-persistence',
        '--output-format',
        streamsStructuredOutput ? 'stream-json' : 'json',
        ...(streamsStructuredOutput ? ['--verbose'] : []),
        ...(opts.schema === undefined ? [] : ['--json-schema', JSON.stringify(opts.schema)]),
        ...modelEffortArgs(opts.purpose ?? 'brief'),
      ],
      {
        stdin,
        timeoutMs,
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
        ...(opts.finalizationGraceMs !== undefined
          ? { finalizationGraceMs: opts.finalizationGraceMs }
          : {}),
        ...(streamsStructuredOutput
          ? {
              stopWhen: (stdout: string) =>
                parseClaudeStreamJson(stdout).confirmedStructured !== undefined,
            }
          : {}),
      },
    );
    attempts.push(run);
    const streamed = streamsStructuredOutput ? parseClaudeStreamJson(run.stdout) : null;
    if (streamed?.confirmedStructured !== undefined) {
      return {
        text: (streamed.final?.text ?? '').trim(),
        structured: streamed.confirmedStructured,
        attempts: attempts.map(({ code, timedOut, stoppedAfterOutput, durationMs }) => ({
          code,
          timedOut,
          stoppedAfterOutput,
          durationMs,
        })),
      };
    }
    if (run.timedOut || run.stoppedAfterOutput) continue;
    const reply = streamed?.final ?? parseClaudeJson(run.stdout);
    if (run.code !== 0 || reply?.isError) {
      const detail = reply?.text.trim() || run.stderr.trim() || run.stdout.trim() || '(no stderr)';
      throw failure(`claude -p exited ${run.code}: ${detail}`);
    }
    if (opts.schema !== undefined && reply?.structured === undefined) {
      throw failure('claude -p returned no schema-validated structured_output. Update Claude CLI.');
    }
    return {
      text: (reply?.text ?? run.stdout).trim(),
      structured: reply?.structured,
      attempts: attempts.map(({ code, timedOut, stoppedAfterOutput, durationMs }) => ({
        code,
        timedOut,
        stoppedAfterOutput,
        durationMs,
      })),
    };
  }
  throw failure(
    `claude -p timed out after ${Math.round(timeoutMs / 1000)}s (${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'})`,
  );
}
