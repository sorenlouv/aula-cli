/**
 * The skill template has to come out correct for both installations.
 *
 * What makes this worth testing is that the failure is silent: a skill that
 * still says `bun src/cli.ts` installs fine, loads fine, and then fails the
 * first time the agent runs a command — on a machine that was never supposed
 * to need bun. So the assertions are about what must *not* survive rendering.
 */

import { describe, expect, test } from 'bun:test';
import { parseSkillTarget, renderSkill } from './install-skill.ts';

const TEMPLATE = [
  '# Aula',
  '',
  '{{AULA_CLI_LOCATION}}',
  '',
  '```bash',
  'bun src/cli.ts <command>',
  '```',
  '',
  'Run `bun src/cli.ts digest --days 14`, then `bun src/cli.ts whoami`.',
].join('\n');

describe('renderSkill', () => {
  test('a binary install names the executable and never mentions bun', () => {
    const out = renderSkill(TEMPLATE, {
      prefix: '/Users/x/.local/bin/aula',
      compiled: true,
      repoDir: '/unused',
    });

    expect(out).not.toContain('bun src/cli.ts');
    expect(out).not.toContain('{{');
    expect(out).toContain('/Users/x/.local/bin/aula <command>');
    expect(out).toContain('/Users/x/.local/bin/aula digest --days 14');
    // The location line must not send the agent to a checkout it does not have.
    expect(out).toContain('runs from any directory');
    expect(out).not.toContain('/unused');
  });

  test('a source checkout keeps the bun spelling and names the repo', () => {
    const out = renderSkill(TEMPLATE, {
      prefix: 'bun src/cli.ts',
      compiled: false,
      repoDir: '/Users/x/aula-cli',
    });

    expect(out).not.toContain('{{');
    expect(out).toContain('bun src/cli.ts <command>');
    expect(out).toContain('**Where the CLI lives:** /Users/x/aula-cli.');
  });

  test('every command spelling is rewritten, not just the first', () => {
    const out = renderSkill(TEMPLATE, {
      prefix: '/bin/aula',
      compiled: true,
      repoDir: '/unused',
    });
    // Three in the fixture: the fenced example and the two in the prose line.
    expect(out.match(/\/bin\/aula/g)?.length).toBeGreaterThanOrEqual(3);
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
