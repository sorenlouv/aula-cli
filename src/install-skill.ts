/**
 * `install-skill` — write the agent skill into the user's agent directory.
 *
 * The template spells every command `aula`, literally, because that is what
 * the command is: SETUP.md installs the binary as `aula` and puts its
 * directory on PATH precisely so the user — and this skill — can just say
 * `aula`. Writing it out beats templating it. The agent pastes these lines
 * into a shell verbatim, and a literal is the one form that cannot render
 * wrong, drift out of sync with SETUP.md, or disagree with the `aula …` every
 * error message already prints.
 *
 * That leaves exactly one thing that genuinely differs per installation —
 * where the CLI lives — so exactly one placeholder survives. A checkout has no
 * `aula` on PATH, so its paragraph says to read `aula` as `bun src/cli.ts`:
 * one sentence for the maintainer, instead of a substitution every end user's
 * file has to come through correctly.
 *
 * The template ships *inside* the binary via an embedded import, which is what
 * lets `install-skill` work for someone who never cloned the repository. The
 * same import resolves to the file on disk when Bun runs the source, so there
 * is one template and no build-time copy step.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import template from '../.claude/skills/aula/SKILL.md' with { type: 'text' };
import { UsageError } from './errors.ts';
import { fmt, ok } from './io.ts';
import { isCompiled } from './runtime.ts';

/** Stands in for the paragraph that says where the CLI is and how to run it. */
const LOCATION_PLACEHOLDER = '{{AULA_CLI_LOCATION}}';

export type SkillTarget = 'claude' | 'codex';

/** Where each agent looks for personal, cross-project skills. */
const TARGET_DIRS: Record<SkillTarget, string[]> = {
  claude: ['.claude', 'skills', 'aula'],
  codex: ['.agents', 'skills', 'aula'],
};

export function parseSkillTarget(value: string | undefined): SkillTarget {
  if (value === undefined || value === 'claude') return 'claude';
  if (value === 'codex') return 'codex';
  throw new UsageError(`Unknown agent "${value}". Choose claude or codex.`);
}

/**
 * Fills the template for this installation.
 *
 * `executable` and `compiled` are parameters rather than reads of the live
 * runtime so the compiled shape can be tested from a source checkout —
 * otherwise the branch that matters most to end users would be the one branch
 * the suite could never reach.
 */
export function renderSkill(
  source: string,
  opts: { executable: string; compiled: boolean; repoDir: string },
): string {
  const location = opts.compiled
    ? `**Where the CLI lives:** \`${opts.executable}\`, on your PATH as \`aula\` —\n` +
      'an installed program, so it runs from any directory and needs no checkout:'
    : `**Where the CLI lives:** ${opts.repoDir}. Run every command from that\n` +
      'directory. (If you are already working inside the aula-cli repository, that\n' +
      'is the directory.) No build step — it runs from source directly, so read\n' +
      '`aula` below as `bun src/cli.ts`:';

  return source.replaceAll(LOCATION_PLACEHOLDER, location);
}

export function runInstallSkill(target: SkillTarget, outDir: string | undefined): number {
  const compiled = isCompiled();
  // `import.meta.dir` is src/ from a checkout, and a virtual path when
  // compiled — where it is never used, because the template is embedded.
  const repoDir = join(import.meta.dir, '..');

  const rendered = renderSkill(template, { executable: process.execPath, compiled, repoDir });
  // A skill that still says `{{…}}` would send the agent to a directory that
  // does not exist, and it would look like a working install while doing it.
  if (rendered.includes('{{')) {
    throw new Error('The skill template still has an unfilled placeholder.');
  }

  const dir = outDir ?? join(homedir(), ...TARGET_DIRS[target]);
  const path = join(dir, 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered, 'utf8');

  ok(`Installed the aula skill for ${target}.`);
  console.error(`  ${fmt.dim(path)}`);
  console.error('  Open a new session to load it.');
  console.log(path);
  return 0;
}
