/**
 * Holds `UPSTREAM.md` to the code it describes.
 *
 * WHY. The bypass material was already written — `API.md` has been accurate for
 * as long as this repo has existed — and it was still useless to the reader who
 * needed it, because it sat in a checkout that reader does not have. `--upstream`
 * fixes the reach. Nothing fixes the rot: a document an agent believes and
 * nobody checks is worse than no document, because a wrong endpoint reads as an
 * answer. So the same bargain `contract.json` and `config/` already make.
 *
 * The two registries this reads are not a hand-kept list of things to mention:
 * they are the transport's own guards. `READ_ONLY_METHODS` is what Aula calls
 * are permitted, `WIDGET_ENDPOINTS` is what vendor URLs are permitted, and a
 * call to anything absent from them is refused before a socket opens. So a new
 * upstream CANNOT be reached without being added to one of them, and adding it
 * fails this test until the document says so too. That is the whole point:
 * the check cannot be satisfied by remembering.
 */

import { describe, expect, test } from 'bun:test';

import {
  AULA_API_BASE,
  CALENDAR_MAX_SPAN_DAYS,
  FALLBACK_API_VERSION,
  READ_ONLY_METHODS,
} from './client.ts';
import { type CliCommand, isCliCommand, parseCommandLine, TOOL_FLAGS } from './cli-options.ts';
import { contractFrame } from './contract.ts';
import { upstreamDoc } from './upstream.ts';
import { WIDGETS, WIDGET_ENDPOINTS } from './widgets.ts';

const doc = upstreamDoc();

describe('every upstream the code can reach is in the document', () => {
  test('the Aula base URL, with the version in the path', () => {
    // Both together: the base alone would pass while the document sent an agent
    // to a retired version, where every method answers 10 and nothing says why.
    expect(doc).toContain(`${AULA_API_BASE}/v${FALLBACK_API_VERSION}/`);
  });

  test('every Aula method the transport permits', () => {
    const missing = [...READ_ONLY_METHODS].filter((method) => !doc.includes(method));
    expect(missing, 'Aula methods this client calls that UPSTREAM.md never names').toEqual([]);
  });

  test('every vendor endpoint the transport permits', () => {
    const missing = Object.keys(WIDGET_ENDPOINTS).filter((url) => !doc.includes(url));
    expect(missing, 'vendor endpoints this client calls that UPSTREAM.md never names').toEqual([]);
  });

  test('every widget id the registry knows, since that is what `raw` takes', () => {
    // `aulaToken.getAulaToken widgetId=<id>` is the whole vendor route, and an
    // id is four digits with no clue in it — an agent cannot guess one.
    const missing = Object.keys(WIDGETS).filter((id) => !doc.includes(`\`${id}\``));
    expect(missing, 'widget ids UPSTREAM.md never names').toEqual([]);
  });

  test('the calendar window cap, which is where a hand-built POST fails', () => {
    expect(doc).toContain(`${CALENDAR_MAX_SPAN_DAYS} days`);
  });
});

test('the commands it calls already-wrapped are the commands the contract declares', () => {
  // §1 says "check these before bypassing". A stale list there sends an agent
  // to hand-roll a call this tool already makes better — which is the exact
  // failure the section exists to prevent.
  const declared = Object.keys(contractFrame().commands as Record<string, unknown>);
  const missing = declared.filter((command) => !doc.includes(`\`${command}\``));
  expect(missing, 'wrapped commands UPSTREAM.md does not list').toEqual([]);
});

// ------------------------------------------------------- the fenced commands

/** Splits a shell-ish line into argv, respecting single and double quotes. */
function tokenize(line: string): string[] {
  const tokens = [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  // Everything past a pipe belongs to another program — `jq`, `grep` — and is
  // none of this parser's business.
  const pipe = tokens.indexOf('|');
  return pipe === -1 ? tokens : tokens.slice(0, pipe);
}

/** Every line inside a ```bash fence that invokes this tool. */
function fencedAulaCommands(): string[][] {
  const lines = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((match) =>
    (match[1] ?? '').split('\n'),
  );
  return (
    lines
      .map((line) => tokenize(line.trim()))
      // A leading `VAR=value` is an environment assignment, not an argument.
      .map((tokens) => {
        let start = 0;
        for (const token of tokens) {
          if (!/^[A-Z_][A-Z0-9_]*=/.test(token)) break;
          start += 1;
        }
        return tokens.slice(start);
      })
      .filter((tokens) => tokens[0] === 'aula')
      .map((tokens) => tokens.slice(1))
  );
}

describe('every command the document shows is one this tool can actually run', () => {
  const commands = fencedAulaCommands();

  test('there are some, so an empty match cannot pass this file silently', () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  for (const argv of commands) {
    const line = `aula ${argv.join(' ')}`;
    test(line.length > 80 ? `${line.slice(0, 77)}...` : line, () => {
      const head = argv[0] ?? '';
      if (TOOL_FLAGS.has(head)) {
        expect(argv).toHaveLength(1);
        return;
      }
      expect(isCliCommand(head), `"${head}" is not a command this tool has`).toBe(true);
      // The real parser, not a copy of its rules: this is what rejects an
      // option the command does not accept, which is how the options line in
      // the skill template drifted before anything held it to the code.
      expect(() => parseCommandLine(head as CliCommand, argv.slice(1))).not.toThrow();
    });
  }
});
