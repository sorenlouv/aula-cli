/**
 * The skill template is what an agent reads to drive this tool, and nothing
 * held it to the code: it said the schedule ran weekday mornings at 06:30 and
 * took `--at HH:MM` while the code ran 06:00 and 18:00 every day and took a
 * list, and its options line left out five flags that existed. Prose drifts
 * silently, and an agent reads it and believes it.
 *
 * So: every command and flag the template names must exist, in the pairing the
 * template shows; every command the code has must be in the template or on the
 * internal list below; and every option an agent-facing command takes must be
 * mentioned somewhere.
 */

import { describe, expect, test } from 'bun:test';
import template from '../.claude/skills/aula/SKILL.md' with { type: 'text' };
import {
  CLI_COMMANDS,
  type CliCommand,
  isCliCommand,
  optionNamesFor,
  optionsFor,
  parseCommandLine,
} from './cli-options.ts';
import { contractFrame } from './contract.ts';

/**
 * Commands an agent never runs by hand, so the template need not teach them:
 * the scheduler's own entry point, and what SETUP.md drives during install.
 */
const INTERNAL_OR_SETUP: readonly CliCommand[] = ['scheduled-run', 'install-skill', 'version'];

/** Flags that are not options of any command: the tool-level ones. */
const TOOL_FLAGS = new Set(['--help', '--contract', '--version', '--json']);

/** Every backticked span in the template, with the code fences' lines too. */
function spans(): string[] {
  const inline = [...template.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');
  const fenced = [...template.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
  return [...inline, ...fenced];
}

/** `aula <command> …` spans: the invocations an agent will paste. */
function invocations(): Array<{ span: string; command: string; flags: string[] }> {
  return spans()
    .filter((span) => /^aula\s+\S/.test(span))
    .map((span) => {
      const words = span.split(/\s+/).slice(1);
      const command = words[0] ?? '';
      const flags = words.filter((w) => w.startsWith('--')).map((w) => w.replace(/=.*$/, ''));
      return { span, command, flags };
    });
}

describe('the skill template and the code agree', () => {
  test('every `aula <command>` the template shows is a command, with flags it accepts', () => {
    for (const { span, command, flags } of invocations()) {
      // `aula <command>` is the template's own placeholder, not an invocation.
      if (TOOL_FLAGS.has(command) || command.startsWith('<')) continue;
      expect(isCliCommand(command), `"${span}": no such command`).toBe(true);
      if (!isCliCommand(command)) continue;
      const accepted = new Set(optionsFor(command));
      for (const flag of flags) {
        expect(
          accepted.has(flag) || TOOL_FLAGS.has(flag),
          `"${span}": ${command} takes no ${flag}`,
        ).toBe(true);
      }
    }
  });

  test('every command row in the tables names a command with flags it accepts', () => {
    // `| \`messages --limit 20\` | …` — the first cell of a table row, when it
    // is a command rather than a Danish phrase.
    const rows = [...template.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? '');
    for (const row of rows) {
      // Alternatives share a row: `preferences` / `forget <n>`.
      for (const alternative of row.split(/` \/ `|\s\/\s/)) {
        const words = alternative
          .replace(/^aula\s+/, '')
          .trim()
          .split(/\s+/);
        const command = words[0] ?? '';
        if (!/^[a-z][a-z-]*$/.test(command)) continue;
        expect(isCliCommand(command), `table row "${row}": no such command "${command}"`).toBe(
          true,
        );
        if (!isCliCommand(command)) continue;
        const accepted = new Set(optionsFor(command));
        for (const flag of words.filter((w) => w.startsWith('--'))) {
          const bare = flag.replace(/[\][|].*$/, '');
          expect(accepted.has(bare), `table row "${row}": ${command} takes no ${bare}`).toBe(true);
        }
      }
    }
  });

  test('every flag the template mentions exists, and a command it is shown with accepts it', () => {
    const everyFlag = new Set(
      [...template.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]).filter((f) => f !== '--'),
    );
    const known = new Set([
      ...TOOL_FLAGS,
      ...(Object.keys(contractFrame().commands as object) as CliCommand[]).flatMap(optionsFor),
      ...INTERNAL_OR_SETUP.flatMap(optionsFor),
      ...(['new', 'open', 'publish', 'schedule', 'login', 'calendars'] as CliCommand[]).flatMap(
        optionsFor,
      ),
    ]);
    // `pdftotext -layout` is a single dash and never matches; `--layout` would.
    for (const flag of everyFlag) {
      expect(known.has(flag), `the template mentions ${flag}, which no command takes`).toBe(true);
    }
  });

  test('every command the code has is taught by the template or declared internal', () => {
    const missing = CLI_COMMANDS.filter(
      (command) =>
        !INTERNAL_OR_SETUP.includes(command) &&
        // Mentioned as a command: in backticks, on its own or after `aula`,
        // followed by a space, a bracket or the closing backtick.
        !new RegExp(`\`(aula )?${command}(\\s|\`)`).test(template),
    );
    expect(missing, 'commands the template never mentions').toEqual([]);
  });

  test('every option an agent-facing command takes is mentioned somewhere', () => {
    const agentFacing = Object.keys(contractFrame().commands as object) as CliCommand[];
    const wanted = new Set(agentFacing.flatMap((command) => optionNamesFor(command)));
    const missing = [...wanted].filter((name) => !template.includes(`--${name}`));
    expect(missing, 'options of read commands the template never mentions').toEqual([]);
  });

  test('the schedule the template describes is the one the code installs', () => {
    // Two slots a day, every day, and a list of times. It said weekday
    // mornings at 06:30 and `--at HH:MM` for long enough to be believed.
    expect(template).toMatch(/06:00 and 18:00/);
    expect(template).not.toMatch(/06:30|weekday-morning|weekday mornings/);
    expect(template).toMatch(/--at HH:MM,HH:MM/);
    expect(() => parseCommandLine('schedule', ['--at', '06:00,18:00'])).not.toThrow();
  });
});
