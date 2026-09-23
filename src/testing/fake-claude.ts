/**
 * A stand-in `claude` binary for tests of the subprocess plumbing.
 *
 * The pipeline shells out to `claude -p` and reads back the `--output-format
 * json` envelope; the things worth testing are the things that go wrong around
 * that call — a stalled process, a hook holding the pipe, an error envelope, a
 * refused tool — and none of them need a model. `installFakeClaude` writes an
 * executable shell script named `claude` into a directory; put that directory
 * first on PATH and the real code path runs against it.
 *
 * Behaviour is chosen per call through the environment, so one installation
 * serves a whole test file:
 *
 *   FAKE_CLAUDE_MODE         ok | error | stall | stall-ignore-term | stall-then-ok |
 *                            structured-then-stall | structured-unconfirmed-stall | stream
 *   FAKE_CLAUDE_STREAM_FILE  for `stream`: a file of NDJSON copied to stdout verbatim, so a
 *                            caller can hand `parseStream`'s reader a whole session.
 *                            `<file>.<n>` overrides it for the nth call (needs
 *                            FAKE_CLAUDE_LOG, which is what counts calls) — that is how a
 *                            paginated read is scripted, page 2 being its own process
 *   FAKE_CLAUDE_RESULT_JSON  the `result` field for `ok`, already JSON-encoded (default "OK")
 *   FAKE_CLAUDE_LOG          append one line per call (the argv), and count calls from it
 *                            `<log>.results` may hold one JSON result per call
 *   FAKE_CLAUDE_CWD_LOG      append one line per call: the directory it was started in
 *   FAKE_CLAUDE_ENV_LOG      append one line per call: `NAME=value` for each space-separated
 *                            name in FAKE_CLAUDE_ENV_KEYS, and nothing else. The calendar
 *                            connector's whole correctness rests on one such variable and
 *                            argv cannot see it; the named-keys restriction is so that a
 *                            failed assertion prints that variable rather than the
 *                            developer's whole environment.
 *   FAKE_CLAUDE_ENV_KEYS     which names FAKE_CLAUDE_ENV_LOG records
 *
 * `stall` sleeps as a child of the script, so killing the script leaves an
 * orphan holding the stdout pipe — the exact hostage situation spawnClaude is
 * built to survive. `stall-ignore-term` also ignores SIGTERM, which the orphan
 * inherits, so only the SIGKILL escalation ends it. `stall-then-ok` stalls on
 * the first call and answers on the next: the retry path.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/bin/sh
# One line per call, whatever the prompt contains, so the log doubles as a counter.
if [ -n "$FAKE_CLAUDE_LOG" ]; then printf '%s' "$*" | tr '\\n' ' ' >> "$FAKE_CLAUDE_LOG"; printf '\\n' >> "$FAKE_CLAUDE_LOG"; fi
# Where it was started, which is the whole subject of claude.test.ts: a session
# inherits its working directory as a project, so who chooses it matters.
if [ -n "$FAKE_CLAUDE_CWD_LOG" ]; then pwd >> "$FAKE_CLAUDE_CWD_LOG"; fi
# One line per call, holding only the variables the caller named. Never the
# whole environment: a failing assertion prints what it received, and this
# process inherits the parent's — which on a developer's machine carries session
# tokens and paths that have no business in a public repository's CI log.
if [ -n "$FAKE_CLAUDE_ENV_LOG" ]; then
  line=""
  for key in $FAKE_CLAUDE_ENV_KEYS; do
    eval "value=\\\${$key-}"
    line="$line$key=$value "
  done
  printf '%s\\n' "$line" >> "$FAKE_CLAUDE_ENV_LOG"
fi
n=0
if [ -n "$FAKE_CLAUDE_LOG" ]; then n=$(wc -l < "$FAKE_CLAUDE_LOG" | tr -d ' '); fi
mode="\${FAKE_CLAUDE_MODE:-ok}"
if [ "$mode" = "stall-then-ok" ]; then
  if [ "$n" -le 1 ]; then mode=stall; else mode=ok; fi
fi
case "$mode" in
  stream)
    # \`<file>.<n>\` serves a different session to the nth call, which is what a
    # paginated read needs: page 2 is a separate \`claude\` process asking with a
    # pageToken. Falls back to the base file, so the single-session case stays a
    # single file. Numbering needs FAKE_CLAUDE_LOG, which is what counts calls.
    if [ -n "$FAKE_CLAUDE_STREAM_FILE" ] && [ -f "$FAKE_CLAUDE_STREAM_FILE.$n" ]; then
      cat "$FAKE_CLAUDE_STREAM_FILE.$n"
    elif [ -n "$FAKE_CLAUDE_STREAM_FILE" ] && [ -f "$FAKE_CLAUDE_STREAM_FILE" ]; then
      cat "$FAKE_CLAUDE_STREAM_FILE"
    fi
    ;;
  stall)
    sleep 10
    ;;
  stall-ignore-term)
    trap '' TERM
    sleep 10
    ;;
  structured-then-stall|structured-unconfirmed-stall)
    structured_json="\${FAKE_CLAUDE_STRUCTURED_JSON:-}"
    if [ -z "$structured_json" ]; then structured_json='{}'; fi
    printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_fake","name":"StructuredOutput","input":%s}]}}\n' "$structured_json"
    if [ "$mode" = "structured-then-stall" ]; then
      printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_fake","content":"Structured output provided successfully"}]}}\n'
    fi
    sleep 10
    ;;
  error)
    printf '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","permission_denials":[]}\\n'
    exit 1
    ;;
  *)
    result_json="\${FAKE_CLAUDE_RESULT_JSON:-\\"OK\\"}"
    structured_json="\${FAKE_CLAUDE_STRUCTURED_JSON:-}"
    if [ -n "$FAKE_CLAUDE_LOG" ] && [ -f "$FAKE_CLAUDE_LOG.results" ]; then
      result_json=$(sed -n "\${n}p" "$FAKE_CLAUDE_LOG.results")
    fi
    if [ -n "$FAKE_CLAUDE_LOG" ] && [ -f "$FAKE_CLAUDE_LOG.structured" ]; then
      structured_json=$(sed -n "\${n}p" "$FAKE_CLAUDE_LOG.structured")
    fi
    case " $* " in
      *" --json-schema "*)
        if [ -n "$structured_json" ]; then
          printf '{"type":"result","subtype":"success","is_error":false,"result":%s,"structured_output":%s,"permission_denials":[]}\\n' "$result_json" "$structured_json"
        else
          printf '{"type":"result","subtype":"success","is_error":false,"result":%s,"permission_denials":[]}\\n' "$result_json"
        fi
        ;;
      *) printf '{"type":"result","subtype":"success","is_error":false,"result":%s,"permission_denials":[]}\\n' "$result_json" ;;
    esac
    ;;
esac
`;

/** Writes the fake into `dir` and returns a PATH that resolves `claude` to it. */
export function installFakeClaude(dir: string): { path: string; binary: string } {
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, 'claude');
  writeFileSync(binary, SCRIPT);
  chmodSync(binary, 0o755);
  return { path: `${dir}:${process.env.PATH ?? ''}`, binary };
}
