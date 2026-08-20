/**
 * Minimal structured logger interface. Callers pass their own (pino, console,
 * MCP transport, etc.). Default is silent so tests + libraries don't spam.
 */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Logger that writes every level to stderr — the only loud logger here,
 * because the CLI's stdout is a data channel (see src/io.ts) and
 * `console.info`/`debug` default to stdout in Node/Bun.
 */
export function stderrLogger(prefix = 'aula-auth'): Logger {
  const write = (level: string, m: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${prefix}] ${level} ${m}${suffix}\n`);
  };
  return {
    debug: (m, meta) => write('DEBUG', m, meta),
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
