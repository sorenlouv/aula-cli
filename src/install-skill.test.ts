/**
 * The skill template has to come out correct for both installations.
 *
 * What makes this worth testing is that the failure is silent: a skill that
 * names a program the reader does not have installs fine, loads fine, and then
 * fails the first time the agent runs a command. The commands are literal
 * `aula` now, so what is left to get wrong is the one paragraph that still
 * varies, and whether the template as shipped stays consistent with the CLI.
 * Those are checked against the REAL template at the bottom of this file,
 * because the leak that actually shipped was on a line no fixture here would
 * have contained.
 */

import { describe, expect, test } from 'bun:test';
import TEMPLATE_SOURCE from '../.claude/skills/aula/SKILL.md' with { type: 'text' };
import { isCliCommand, optionsFor } from './cli-options.ts';
import { parseSkillTarget, renderSkill } from './install-skill.ts';

const TEMPLATE = [
  '# Aula',
  '',
  '{{AULA_CLI_LOCATION}}',
  '',
  '```bash',
  'aula <command>',
  '```',
  '',
  'Run `aula digest --days 14`, then `aula whoami`.',
].join('\n');

describe('renderSkill', () => {
  test('a binary install states the location and leaves the commands as `aula`', () => {
    const out = renderSkill(TEMPLATE, {
      executable: '/Users/x/.local/bin/aula',
      compiled: true,
      repoDir: '/unused',
    });

    expect(out).not.toContain('{{');
    // The location paragraph carries the absolute path, so the agent can still
    // find the program if the bare name does not resolve.
    expect(out).toContain('/Users/x/.local/bin/aula');
    // Commands stay the spelling SETUP.md taught the user.
    expect(out).toContain('aula digest --days 14');
    // The location line must not send the agent to a checkout it does not have.
    expect(out).toContain('runs from any directory');
    expect(out).not.toContain('/unused');
  });

  test('a source checkout names the repo and explains the spelling once', () => {
    const out = renderSkill(TEMPLATE, {
      executable: '/unused',
      compiled: false,
      repoDir: '/Users/x/aula-cli',
    });

    expect(out).not.toContain('{{');
    expect(out).toContain('**Where the CLI lives:** /Users/x/aula-cli.');
    // One sentence carries the whole difference, rather than 16 substitutions.
    expect(out).toContain('read\n`aula` below as `bun src/cli.ts`');
  });

  test('the location placeholder is filled wherever it appears', () => {
    const twice = `${TEMPLATE}\n\n{{AULA_CLI_LOCATION}}`;
    const out = renderSkill(twice, {
      executable: '/bin/aula',
      compiled: true,
      repoDir: '/unused',
    });
    expect(out).not.toContain('{{');
    expect(out.match(/Where the CLI lives/g)?.length).toBe(2);
  });
});

/**
 * The leak this guards against reached real installs: one line said
 * `bun run login`, which the old placeholder — the literal string
 * `bun src/cli.ts` — could not match, so it survived rendering and told people
 * with no checkout to run a command in a directory they do not have.
 */
describe('the real skill template', () => {
  test('names no build toolchain, so nothing can leak into a binary install', () => {
    expect(TEMPLATE_SOURCE).not.toMatch(/\b(bun|node|npm|npx|deno|pnpm|yarn)\b/i);
  });

  test('renders a binary install with no toolchain and no placeholder', () => {
    const out = renderSkill(TEMPLATE_SOURCE, {
      executable: '/Users/x/.local/bin/aula',
      compiled: true,
      repoDir: '/unused',
    });
    expect(out).not.toMatch(/\b(bun|node|npm|npx|deno|pnpm|yarn)\b/i);
    expect(out).not.toContain('{{');
    expect(out).not.toContain('/unused');
  });

  /**
   * The skill's header tells the agent that `--text` is available. Thirteen
   * commands reject it outright, and the skill names several of them, so an
   * agent following the header verbatim gets a usage error instead of an
   * answer. Checking every `--text` in the template against the CLI's own
   * option table keeps the sentence honest as commands are added.
   */
  test('never attaches --text to a command that rejects it', () => {
    const offenders: string[] = [];
    for (const match of TEMPLATE_SOURCE.matchAll(/\baula ([a-z-]+)[^\n`]*?--text\b/g)) {
      const command = match[1] ?? '';
      if (isCliCommand(command) && !optionsFor(command).includes('--text')) {
        offenders.push(command);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('parseSkillTarget', () => {
  test('defaults to claude, accepts codex', () => {
    expect(parseSkillTarget(undefined)).toBe('claude');
    expect(parseSkillTarget('claude')).toBe('claude');
    expect(parseSkillTarget('codex')).toBe('codex');
  });

  test('refuses an agent it has no directory for', () => {
    expect(() => parseSkillTarget('cursor')).toThrow(/claude or codex/);
  });
});
