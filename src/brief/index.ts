/**
 * The `aula brief` pipeline.
 *
 *   collect → extract (rules ∪ model) → rank → compose → validate → publish → deploy
 *
 * Every stage after `collect` degrades rather than throws. A brief that is
 * missing the model's phrasing is still useful; a brief that failed to appear
 * is not, and the whole point is that not opening Aula stops costing anything.
 */

import type { AulaClient } from '../client.ts';
import { isoWeekString } from '../integrations/types.ts';
import { collect } from './collect.ts';
import { composePage, fallbackPage } from './compose.ts';
import { deployArtifact, type DeployResult } from './deploy.ts';
import { extractSignals } from './llm.ts';
import { publish, type PublishResult } from './publish.ts';
import { rank, signalsFromRules } from './rank.ts';
import {
  loadState,
  markSeen,
  pruneState,
  recordDeploy,
  recordRun,
  saveState,
  whichAreNew,
} from './state.ts';
import type { RankedBrief, Relevance } from './types.ts';
import { validatePage } from './validate.ts';

export type BriefOptions = {
  days?: number;
  isoWeek?: string;
  useModel?: boolean;
  useCache?: boolean;
  outDir?: string;
  pdf?: boolean;
  png?: boolean;
  deploy?: boolean;
  now?: Date;
};

export type BriefRun = {
  brief: RankedBrief;
  topline: string | null;
  origin: 'model' | 'fallback';
  published: PublishResult;
  deployment: DeployResult;
  notes: string[];
  /**
   * Nothing degraded: the model ran where asked and the hosted copy was
   * refreshed where one is configured. The scheduler's retries through the
   * morning stop at the first complete run — see `--catch-up` in cli.ts.
   */
  complete: boolean;
};

/**
 * Stable on purpose. The page is republished to the same URL every day, and a
 * title that carried the date would read as a different page each time — the
 * date is in the page itself.
 */
export const BRIEF_TITLE = 'Aula AI oversigt';

export async function runBrief(client: AulaClient, opts: BriefOptions = {}): Promise<BriefRun> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 14;
  const isoWeek = opts.isoWeek ?? isoWeekString(now);
  const notes: string[] = [];

  const input = await collect(client, { days, isoWeek, now });

  // ------------------------------------------------------------- extraction
  let topline: string | null = null;
  let summaries: Record<string, string> = {};
  let modelSignals: ReturnType<typeof signalsFromRules> = [];
  // The family's list, as the model read it per source. Empty on the
  // rules-only path, which then hides nothing — see `rank`.
  let relevance: Record<string, Relevance> = {};
  let extractionRan = opts.useModel === false;

  if (opts.useModel !== false) {
    try {
      const extracted = await extractSignals(input, { useCache: opts.useCache !== false });
      topline = extracted.topline;
      summaries = extracted.childSummaries;
      modelSignals = extracted.signals;
      relevance = extracted.relevance;
      extractionRan = true;
      for (const problem of extracted.problems) {
        notes.push(`Udtræk afvist: ${problem}`);
      }
    } catch (err) {
      notes.push(`Modellen kunne ikke køre (${(err as Error).message}) — kun reglerne blev brugt.`);
    }
  }

  const brief = rank(input, [...modelSignals, ...signalsFromRules(input, now)], relevance);

  // ---------------------------------------------------------------- compose
  const state = loadState();
  const newKeys = whichAreNew(state, input.items.map((item) => item.key), now);
  const isNew = (key: string) => newKeys.has(key);

  let body = '';
  let origin: BriefRun['origin'] = 'fallback';

  if (opts.useModel !== false) {
    try {
      const composed = await composePage(brief, { topline, summaries, isNew });
      for (const problem of composed.problems) {
        notes.push(`Layoutplan: ${problem}`);
      }
      const found = validatePage(composed.html, brief);
      if (found.length === 0) {
        body = composed.html;
        origin = 'model';
      } else {
        notes.push(
          `Layout afvist: ${found.map((v) => `${v.rule} (${v.detail})`).join('; ')}`,
        );
      }
    } catch (err) {
      notes.push(`Layout fejlede: ${(err as Error).message}`);
    }
  }

  if (!body) {
    body = fallbackPage(brief, {
      topline,
      summaries,
      note: opts.useModel === false ? undefined : 'reservelayout',
    });
    // The fallback is held to the same standard as the model's output.
    for (const v of validatePage(body, brief)) {
      notes.push(`Reservelayout: ${v.rule} (${v.detail})`);
    }
  }

  // ---------------------------------------------------------------- publish
  const published = await publish(body, {
    day: input.today,
    title: BRIEF_TITLE,
    ...(opts.outDir ? { dir: opts.outDir } : {}),
    ...(opts.pdf === true ? { pdf: true } : {}),
    ...(opts.png === true ? { png: true } : {}),
  });
  notes.push(...published.warnings);

  // Local first, hosted second. The file on disk is the brief; the artifact is
  // a convenience on top of it, so a deploy that fails is a note on an
  // otherwise good run rather than a failed one.
  let deployment: DeployResult = { status: 'skipped', reason: 'slået fra med --no-deploy' };
  if (opts.deploy !== false) {
    deployment = await deployArtifact(published.artifactPath, { title: BRIEF_TITLE });
    if (deployment.status === 'failed') {
      notes.push(`Artifact blev ikke opdateret: ${deployment.reason}`);
    }
    if (deployment.status === 'ok') recordDeploy(state, deployment.url, now);
  }

  // A run counts as complete only when nothing had to be papered over: the
  // model's extraction ran, its layout passed validation, and the hosted copy
  // — where one is configured — was actually refreshed. With `--no-llm` the
  // rules-only page is what was asked for, so it is complete on its own terms.
  const complete =
    (opts.useModel === false || (extractionRan && origin === 'model')) && deployment.status !== 'failed';

  // Recorded only once the page exists, so a crash re-shows rather than hides.
  markSeen(state, input.items.map((item) => item.key), now);
  pruneState(state);
  recordRun(state, { day: input.today, complete }, now);
  saveState(state);

  return { brief, topline, origin, published, deployment, notes, complete };
}
