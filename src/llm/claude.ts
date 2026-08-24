/**
 * The shared Claude CLI transport.
 *
 * Request-specific instructions and schemas live under `llm/requests/`; this
 * file owns only process lifecycle, JSON envelopes and the no-tools structured
 * request path.
 */

import { isRecord } from '../validation.ts';

/** Extraction quality and deterministic tool transport have separate cost dials. */
export function modelEffortArgs(purpose: 'brief' | 'transport' = 'brief'): string[] {
  const model =
    purpose === 'brief' ? process.env.AULA_BRIEF_MODEL : (process.env.AULA_TOOL_MODEL ?? 'haiku');
  const effort =
    purpose === 'brief' ? process.env.AULA_BRIEF_EFFORT : (process.env.AULA_TOOL_EFFORT ?? 'low');
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

/** How a `claude -p` subprocess ended, before any interpretation of what it said. */
export type ClaudeExit = {
  stdout: string;
  stderr: string;
  code: number;
  /** The deadline passed and the process was killed by this module. */
  timedOut: boolean;
};

/**
 * Spawns `claude` and bounds both the process and inherited output pipes.
 *
 * SIGTERM is followed by SIGKILL because a sleeping network request can ignore
 * the first signal for minutes. Output is drained while the process runs, then
 * its readers are released even if a plugin child still holds their write end.
 */
export async function spawnClaude(
  args: string[],
  opts: { stdin?: string; timeoutMs: number; graceMs?: number; env?: Record<string, string> },
): Promise<ClaudeExit> {
  const proc = Bun.spawn(['claude', ...args], {
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    // Always explicit: tests change PATH after startup to install a fake CLI.
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  let timedOut = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    hardKill = setTimeout(() => proc.kill('SIGKILL'), opts.graceMs ?? 10_000);
  }, opts.timeoutMs);

  const out = proc.stdout.getReader();
  const err = proc.stderr.getReader();
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const draining = Promise.all([drain(out, outChunks), drain(err, errChunks)]);
  try {
    const code = await proc.exited;
    await Promise.race([draining, Bun.sleep(1_000)]);
    return {
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      code,
      timedOut,
    };
  } finally {
    clearTimeout(deadline);
    if (hardKill) clearTimeout(hardKill);
    for (const reader of [out, err]) reader.cancel().catch(() => {});
  }
}

/** Structural on purpose: Bun's reader type and TypeScript's lib disagree. */
async function drain<T>(
  reader: { read(): Promise<{ done: boolean; value?: T }> },
  into: T[],
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) into.push(value);
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
  opts: { timeoutMs?: number; graceMs?: number; schema?: unknown } = {},
): Promise<{ text: string; structured: unknown }> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = await spawnClaude(
      [
        '-p',
        instructions,
        '--tools',
        '',
        '--strict-mcp-config',
        '--output-format',
        'json',
        ...(opts.schema === undefined ? [] : ['--json-schema', JSON.stringify(opts.schema)]),
        ...modelEffortArgs(),
      ],
      { stdin, timeoutMs, ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}) },
    );
    if (run.timedOut) continue;
    const reply = parseClaudeJson(run.stdout);
    if (run.code !== 0 || reply?.isError) {
      const detail = reply?.text.trim() || run.stderr.trim() || run.stdout.trim() || '(no stderr)';
      throw new Error(`claude -p exited ${run.code}: ${detail}`);
    }
    if (opts.schema !== undefined && reply?.structured === undefined) {
      throw new Error(
        'claude -p returned no schema-validated structured_output. Update Claude CLI.',
      );
    }
    return { text: (reply?.text ?? run.stdout).trim(), structured: reply?.structured };
  }
  throw new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s (2 attempts)`);
}
