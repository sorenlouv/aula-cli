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
 *   exists in `~/.aula/config.json`, and `aula publish` is the only thing that
 *   writes one. The page carries health information about the children, so
 *   hosting has to be asked for — never inherited by cloning the repo. The file
 *   is under `$AULA_DIR`, so it is per installation: every user of this tool
 *   configures their own, and none of them can see or touch another's.
 * - **No Aula text reaches the prompt, and the agent can read one file.** The
 *   page is assembled from posts and messages written by other people. If any
 *   of it were interpolated into the instructions, a sentence in a school post
 *   would be in a position to steer what gets published — so the prompt carries
 *   only a path and a URL this module produced itself. The agent used to get no
 *   reader at all, and that stopped working: the Artifact tool's own rule is
 *   that a file the model did not write must be read before it is published,
 *   and at high effort the model refused outright ("I only publish files I've
 *   actually read"). So it now gets `Read`, permitted for exactly the artifact
 *   path and nothing else (`Read(//…/artifact.html)`; any other path is a
 *   permission prompt no one is there to answer), and the prompt says what the
 *   file is — other people's text, to be treated as page content and never as
 *   instructions. What an injected sentence could still steer is small by
 *   construction: the target URL is fixed in the prompt and checked in the
 *   reply, the agent has no write, shell or network tool, and a published
 *   artifact is private to the account that published it.
 *
 *   Granting a tool takes *both* flags: `--tools` strips the built-in set down
 *   to the named ones, and `--allowedTools` pre-approves calling them. Measured
 *   with the same nonce probe as src/brief/llm.ts: `--allowedTools` alone still
 *   let the agent read any file, `--tools Artifact` alone left it unable to
 *   publish.
 */

import { CONFIG_PATH, readConfig, updateConfig } from '../config.ts';
import { errorMessage } from '../validation.ts';
import { modelEffortArgs, parseClaudeJson, spawnClaude } from '../llm/claude.ts';
import {
  ARTIFACT_URL_ANYWHERE,
  artifactDeployRequest,
  isArtifactUrl,
} from '../llm/requests/artifact-deploy.ts';

export { isArtifactUrl } from '../llm/requests/artifact-deploy.ts';

/**
 * Generous for an 8-second call, because the first token after a wake can be
 * slow; short enough that a stalled connection costs minutes, not a morning.
 * A call that hits it is tried once more in a fresh process (see llm.ts).
 */
const TIMEOUT_MS = 120_000;

export type DeployResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; url: string }
  | { status: 'failed'; reason: string };

/** The configured target, or null when the brief stays local. */
export function readTarget(configPath = CONFIG_PATH): string | null {
  return readConfig(configPath).artifactUrl ?? null;
}

/**
 * The one writer of the preference. `null` turns hosting off.
 *
 * Merged rather than written whole: this file also holds the family's
 * calendars, and rebuilding it from the one field this module knows about
 * would delete them — user data lost in a command about hosting.
 */
export function setTarget(url: string | null, configPath = CONFIG_PATH): void {
  updateConfig({ artifactUrl: url ?? undefined }, configPath);
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
 *
 * With `url` null the call creates a new artifact instead — that is how
 * `aula publish` mints the URL in the first place — and the reply is the
 * only way to learn which URL the tool chose.
 */
export function deployPrompt(artifactPath: string, url: string | null, title: string): string {
  return artifactDeployRequest.prompt({ artifactPath, url, title });
}

/**
 * Pushes `artifactPath` to the configured URL — or, with `create`, to a new
 * artifact whose URL comes back in the result.
 *
 * Never throws: every outcome is a `DeployResult` the caller turns into a note,
 * because a brief that exists locally is worth more than a failed run.
 */
export async function deployArtifact(
  artifactPath: string,
  opts: {
    title: string;
    configPath?: string;
    timeoutMs?: number;
    graceMs?: number;
    /** Publish as a new artifact rather than to the configured URL. */
    create?: boolean;
  },
): Promise<DeployResult> {
  let url: string | null = null;
  if (!opts.create) {
    try {
      url = readTarget(opts.configPath);
    } catch (err) {
      return { status: 'failed', reason: errorMessage(err) };
    }
    if (!url) return { status: 'skipped', reason: 'ingen artifact-URL konfigureret' };
    if (!isArtifactUrl(url)) return { status: 'failed', reason: `ugyldig artifact-URL: ${url}` };
  }

  // `//` is how a permission rule spells an absolute path, so the one file the
  // agent may read is this one, wherever `$AULA_DIR` put it.
  const readRule = `Read(/${artifactPath})`;
  const args = [
    '-p',
    deployPrompt(artifactPath, url, opts.title),
    '--tools',
    'Artifact',
    'Read',
    '--allowedTools',
    'Artifact',
    readRule,
    '--strict-mcp-config',
    '--output-format',
    'json',
    ...modelEffortArgs('transport'),
  ];
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  // A stalled request gets exactly one fresh process; everything else is
  // reported as it is. Two attempts bound the worst case at four minutes
  // instead of the quarter-hours a single unkillable one used to cost.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let run;
    try {
      run = await spawnClaude(args, {
        timeoutMs,
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
        // `claude` only offers the Artifact tool to sessions that announce this
        // entrypoint. Measured, not assumed: with it the tool is present in an
        // otherwise stripped environment, and without it a session that is fully
        // logged in and can run every model call still reports the tool as
        // missing. A launchd agent inherits no such marker, so the scheduled
        // deploy fails without this line while an interactive one succeeds —
        // which is exactly the trap this pipeline is meant to avoid.
        //
        // It is set on this one subprocess rather than on the agent, so the
        // extraction and calendar calls keep the environment they already had.
        //
        // This is an undocumented lever and may stop working on any `claude`
        // update. The failure is loud and harmless: the deploy reports the tool
        // as unavailable, the note lands in the run's output, and the local brief
        // is unaffected.
        env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      });
    } catch (error) {
      return { status: 'failed', reason: errorMessage(error) };
    }
    if (run.timedOut) continue;

    const reply = parseClaudeJson(run.stdout);
    if (reply?.denials.includes('Artifact')) {
      return {
        status: 'failed',
        reason: 'claude -p afviste Artifact-værktøjet (permission denied)',
      };
    }
    // The reply is prose from a model, so it is a report and not proof: require
    // the target URL back, with no error marker beside it. A brief that
    // silently did not deploy is the one outcome this whole leg exists to
    // prevent, so anything less counts as a failure.
    //
    // The exit code is the weaker signal of the two and deliberately does not
    // get a veto: `claude` runs plugin hooks after the turn is over, and a hook
    // that fails can change the exit status long after the Artifact call has
    // landed. Treating that as a failed deploy would report a page as stale
    // while it was in fact published.
    const said = (reply?.text ?? run.stdout).trim();
    const failed = reply?.isError === true || /\bERROR\b/i.test(said);
    if (url) {
      if (!failed && said.includes(url)) return { status: 'ok', url };
    } else {
      const found = [...new Set(said.match(ARTIFACT_URL_ANYWHERE) ?? [])];
      if (!failed && found.length === 1 && found[0]) return { status: 'ok', url: found[0] };
    }
    const detail = said || run.stderr.trim() || '(tomt svar)';
    return {
      status: 'failed',
      reason: run.code === 0 ? detail : `claude -p afsluttede med ${run.code}: ${detail}`,
    };
  }
  return {
    status: 'failed',
    reason: `claude -p svarede ikke inden for ${Math.round(timeoutMs / 1000)}s (2 forsøg)`,
  };
}
