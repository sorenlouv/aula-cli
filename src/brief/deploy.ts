/**
 * Redeploying the hosted copy of the brief.
 *
 * `publish.ts` writes files. This pushes the same page to its artifact URL so
 * the shared link shows today's brief rather than the day it was first
 * published. It is a separate module because it is a separate kind of risk:
 * writing to ~/.aula always works, while this leg needs the network, claude.ai
 * credentials and a model — and must never take the brief down when it fails.
 *
 * The Artifact publisher is a Claude *tool*, not an HTTP endpoint, so the only
 * way a launchd job can reach it is to spawn `claude -p` and let it make the
 * call.
 *
 * Two deliberate constraints on that subprocess:
 *
 * - **Opt-in by configuration.** Nothing leaves the machine until a target URL
 *   exists in `AULA_ARTIFACT_URL` or `~/.aula/brief/artifact-url`. The page
 *   carries health information about the children, so hosting has to be asked
 *   for — never inherited by cloning the repo.
 * - **No Aula text reaches the prompt, and the agent gets no reader.** The page
 *   is assembled from posts and messages written by other people. If any of it
 *   were interpolated into the instructions — or readable by an agent holding a
 *   publishing tool — a sentence in a school post would be in a position to
 *   steer what gets published. So the prompt carries only a path and a URL this
 *   module produced itself, and `Artifact` is the only tool granted.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_DIR } from './state.ts';

/** Stable across redeploys on purpose: a changed favicon reads as a new page. */
const FAVICON = '🎒';

/**
 * Static, and free of anything read out of Aula — this is the one string that
 * ends up in the prompt beside the path, so it may not carry other people's
 * prose. The gallery card is a label, not a summary of the day.
 */
const DESCRIPTION = 'Dagligt overblik over beskeder, opslag og aftaler i Aula.';

const TIMEOUT_MS = 180_000;
const URL_FILE = 'artifact-url';

const ARTIFACT_URL =
  /^https:\/\/claude\.ai\/code\/artifact\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DeployResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; url: string }
  | { status: 'failed'; reason: string };

/** The configured target, env first so a one-off run can override the file. */
export function readTarget(dir = BRIEF_DIR): string | null {
  const fromEnv = (process.env.AULA_ARTIFACT_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(dir, URL_FILE), 'utf8').trim() || null;
  } catch {
    // No file is the normal state for an install that never asked for hosting.
    return null;
  }
}

/**
 * Why `force: true`, when the Artifact publisher otherwise treats a 409 as
 * something to merge rather than overwrite.
 *
 * Merging is the right default where two people edit one page. This is not that
 * shape. The page is generated whole from Aula every morning and wholly
 * replaces the day before — there is no edit to preserve, and yesterday's
 * content is exactly what has to go. Nothing else ever writes to this URL.
 *
 * And the conflict is not an exception here, it is the steady state: each run
 * spawns a *fresh* `claude -p`, so the publishing session has by definition
 * never seen the version it is replacing and will 409 every single morning.
 * Without this the deploy would fail every day rather than occasionally.
 */
export function deployPrompt(artifactPath: string, url: string, title: string): string {
  return [
    'Redeploy an already-written page to an existing artifact.',
    '',
    'Make exactly one Artifact tool call, with these inputs and no others:',
    `  file_path: ${artifactPath}`,
    `  url: ${url}`,
    `  title: ${title}`,
    `  favicon: ${FAVICON}`,
    `  description: ${DESCRIPTION}`,
    '  force: true',
    '',
    "The file was generated and validated by this machine's aula-cli brief",
    'pipeline moments ago and is the intended content. Do not open, edit,',
    'summarise or comment on it, and do not call any other tool.',
    '',
    'Then reply with the deployed URL and nothing else. If the call fails,',
    'reply with "ERROR: " followed by the reason.',
  ].join('\n');
}

/**
 * Pushes `artifactPath` to the configured URL.
 *
 * Never throws: every outcome is a `DeployResult` the caller turns into a note,
 * because a brief that exists locally is worth more than a failed run.
 */
export async function deployArtifact(
  artifactPath: string,
  opts: { title: string; dir?: string; timeoutMs?: number },
): Promise<DeployResult> {
  const url = readTarget(opts.dir);
  if (!url) return { status: 'skipped', reason: 'ingen artifact-URL konfigureret' };
  if (!ARTIFACT_URL.test(url)) {
    return { status: 'failed', reason: `ugyldig artifact-URL: ${url}` };
  }

  const proc = Bun.spawn(
    ['claude', '-p', deployPrompt(artifactPath, url, opts.title), '--allowedTools', 'Artifact', '--strict-mcp-config'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      // `claude` only offers the Artifact tool to sessions that announce this
      // entrypoint. Measured, not assumed: with it the tool is present in an
      // otherwise stripped environment, and without it a session that is fully
      // logged in and can run every model call still reports the tool as
      // missing. A launchd agent inherits no such marker, so the scheduled
      // deploy fails without this line while an interactive one succeeds —
      // which is exactly the trap this pipeline is meant to avoid.
      //
      // It is set on this one subprocess rather than on the agent, so the
      // extraction and layout calls keep the environment they already had.
      //
      // This is an undocumented lever and may stop working on any `claude`
      // update. The failure is loud and harmless: the deploy reports the tool
      // as unavailable, the note lands in the run's output, and the local brief
      // is unaffected.
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    },
  );
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? TIMEOUT_MS);

  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // The reply is prose from a model, so it is a report and not proof: require
    // the target URL back, with no error marker beside it. A brief that
    // silently did not deploy is the one outcome this whole leg exists to
    // prevent, so anything less counts as a failure.
    //
    // The exit code is the weaker signal of the two and deliberately does not
    // get a veto. `claude` runs plugin hooks after the turn is over, and a hook
    // that cannot start — a SessionEnd hook looking for a `node` that is not on
    // launchd's PATH, say — kills the process with 143 long after the Artifact
    // call has landed. Treating that as a failed deploy would report a page as
    // stale while it was in fact published.
    const said = out.trim();
    if (!said.includes(url) || /\bERROR\b/i.test(said)) {
      const detail = said || err.trim() || '(tomt svar)';
      return {
        status: 'failed',
        reason: code === 0 ? detail : `claude -p afsluttede med ${code}: ${detail}`,
      };
    }
    return { status: 'ok', url };
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
