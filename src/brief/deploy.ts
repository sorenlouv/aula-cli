/**
 * Uploading the hosted copy of the brief.
 *
 * `publish.ts` writes files. This sends the same page to the Worker in
 * `src/hosting/`, which serves it behind the family's own login, so the shared link
 * shows today's brief rather than the day it was first set up. It is a
 * separate module because it is a separate kind of risk: writing to ~/.aula
 * always works, while this leg needs the network — and must never take the
 * brief down when it fails.
 *
 * It used to spawn `claude -p` and ask a model to call the Artifact tool,
 * which was the only way a launchd job could reach claude.ai hosting. That leg
 * needed an undocumented entrypoint variable, a `force` on every publish and a
 * model's prose as the only evidence of success. This is one HTTP request, and
 * its status code is the evidence.
 *
 * - **Opt-in by configuration.** Nothing leaves the machine until `hosting` is
 *   in `~/.aula/config.json`, and `aula publish <url>` is the only thing that
 *   writes it. The page carries health information about the children, so
 *   hosting has to be asked for — never inherited by cloning the repo.
 * - **It authenticates with a token, not as a person.** The family signs in
 *   with a code by mail; the upload carries the Worker's `UPLOAD_TOKEN` as a
 *   bearer token instead, which is the one route that takes it. The token sits
 *   in the config beside the URL, and that file is written `0600`.
 */

import { CONFIG_PATH, type HostingConfig, readConfig, updateConfig } from '../config.ts';
import { BRIEF_PATH, MAX_PAGE_BYTES } from '../hosting/protocol.ts';
import { cmd } from '../runtime.ts';
import { errorMessage } from '../validation.ts';

/** An upload is ~90 KB. A connection that has not answered by now will not. */
const TIMEOUT_MS = 30_000;

/**
 * The two ways a deploy does not happen are not the same event, and collapsing
 * them into one `skipped` is what let a lost target go unreported for days:
 * the run said `complete: true` and printed nothing while the shared link kept
 * showing the day it was last configured. `off` is what the caller asked for
 * and stays quiet; `unconfigured` is a fact about the installation that the
 * caller cannot see from the exit code, so it earns a note.
 */
export type DeployResult =
  | { status: 'ok'; url: string }
  /**
   * `retryable` is false when only a change of configuration can help — the
   * Worker refused the token or the page — so the schedule does not spend
   * three hours asking again.
   */
  | { status: 'failed'; reason: string; retryable: boolean }
  /** `--no-deploy`: no hosted copy was wanted this run. Silent by design. */
  | { status: 'off'; reason: string }
  /** No `hosting` in the config — hosting was never set up, or was lost. */
  | { status: 'unconfigured'; reason: string };

/** The configured target, or null when the brief stays local. */
export function readHosting(configPath = CONFIG_PATH): HostingConfig | null {
  return readConfig(configPath).hosting ?? null;
}

/**
 * The one writer of the preference. `null` turns hosting off.
 *
 * Merged rather than written whole: this file also holds the family's
 * calendars, and rebuilding it from the one field this module knows about
 * would delete them — user data lost in a command about hosting.
 */
export function setHosting(hosting: HostingConfig | null, configPath = CONFIG_PATH): void {
  updateConfig({ hosting: hosting ?? undefined }, configPath);
}

/**
 * Uploads `html` to the configured Worker — or to `opts.hosting`, which is how
 * `aula publish <url>` proves a new target works before saving it.
 *
 * Never throws: every outcome is a `DeployResult` the caller turns into a note,
 * because a brief that exists locally is worth more than a failed run.
 */
export async function deployBrief(
  html: string,
  opts: { hosting?: HostingConfig; configPath?: string; timeoutMs?: number } = {},
): Promise<DeployResult> {
  let hosting: HostingConfig | null;
  try {
    hosting = opts.hosting ?? readHosting(opts.configPath);
  } catch (err) {
    return { status: 'failed', reason: errorMessage(err), retryable: false };
  }
  if (!hosting) {
    return {
      status: 'unconfigured',
      reason: `Ingen hosted kopi er konfigureret. \`${cmd('publish <url>')}\` sætter den op.`,
    };
  }

  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_PAGE_BYTES) {
    return {
      status: 'failed',
      reason: `siden er ${bytes} bytes; den hostede kopi tager højst ${MAX_PAGE_BYTES}`,
      retryable: false,
    };
  }

  let response: Response;
  try {
    response = await fetch(new URL(BRIEF_PATH, hosting.url), {
      method: 'PUT',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        authorization: `Bearer ${hosting.token}`,
      },
      body: html,
      // Nothing at the right address redirects an upload, and a login page
      // somewhere else, followed, is a 200 of HTML — a failure that reads as a
      // success. So a redirect is the answer, and it is not followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    return {
      status: 'failed',
      reason: `${hosting.url} svarede ikke: ${errorMessage(err)}`,
      retryable: true,
    };
  }

  if (response.ok) return { status: 'ok', url: hosting.url };

  const { status } = response;
  if (status >= 300 && status < 400) {
    return {
      status: 'failed',
      reason: `${hosting.url} sendte uploaden videre (HTTP ${status}) — er det den rigtige adresse?`,
      retryable: false,
    };
  }
  if (status === 401) {
    return {
      status: 'failed',
      reason: `${hosting.url} afviste upload-nøglen (HTTP 401)`,
      retryable: false,
    };
  }
  const detail = (await response.text().catch(() => '')).trim().split('\n')[0]?.slice(0, 200);
  return {
    status: 'failed',
    reason: `${hosting.url} svarede HTTP ${status}${detail ? `: ${detail}` : ''}`,
    // A 4xx is a page or an address that will not change on its own. Only
    // the server's own trouble is worth another attempt.
    retryable: status >= 500 || status === 429 || status === 408,
  };
}
