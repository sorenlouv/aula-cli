/**
 * The `aula brief` pipeline.
 *
 *   collect → extract (model, or rules fallback) → rank → render → validate → publish → deploy
 *
 * Every stage after `collect` degrades rather than throws. A brief that is
 * missing the model's phrasing is still useful; a brief that failed to appear
 * is not, and the whole point is that not opening Aula stops costing anything.
 */

import { randomUUID } from 'node:crypto';
import type { AulaClient } from '../client.ts';
import { isoWeekString, localIsoDate } from '../integrations/types.ts';
import { CLAUDE_INSTALL_COMMAND, ClaudeMissingError } from '../llm/claude.ts';
import { collect, HISTORY_DAYS } from './collect.ts';
import { deployArtifact, type DeployResult } from './deploy.ts';
import { appendBriefLog, errorForBriefLog, sourceRevision } from './log.ts';
import { extractCards } from './llm.ts';
import { publish, type PublishResult } from './publish.ts';
import { cardsFromRules, rank } from './rank.ts';
import { renderPage, type PageOptions } from './render.ts';
import {
  loadState,
  markSeen,
  pruneState,
  recordDeploy,
  recordRun,
  saveState,
  whichAreNew,
} from './state.ts';
import type { Card, PersonalEventVerdict, RankedBrief } from './types.ts';
import { validatePage, type Violation } from './validate.ts';
import { errorMessage } from '../validation.ts';

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
   * Nothing retryable degraded: the model ran where asked, every required
   * source read completed, and the hosted copy was refreshed where configured.
   * The scheduler stops at the first complete run — see `--catch-up` in cli.ts.
   */
  complete: boolean;
  /**
   * Whether running again could plausibly do better.
   *
   * False when the run was stopped by something a retry cannot change — today
   * only a missing `claude`. The morning schedule retries every 15 minutes for
   * three hours, so an incomplete run normally *is* worth repeating and the
   * output says so; saying it when the cause is a program that is not
   * installed sends the reader off to wait for a fix that will never arrive.
   */
  retryable: boolean;
};

/**
 * Stable on purpose. The page is republished to the same URL every day, and a
 * title that carried the date would read as a different page each time — the
 * date is in the page itself.
 */
export const BRIEF_TITLE = 'Aula AI oversigt';

export function isBriefRunComplete(opts: {
  modelWasRequested: boolean;
  extractionRan: boolean;
  origin: BriefRun['origin'];
  deploymentFailed: boolean;
  retryableFetchFailures: boolean;
  violations: readonly Violation[];
}): boolean {
  return (
    (!opts.modelWasRequested || (opts.extractionRan && opts.origin === 'model')) &&
    !opts.deploymentFailed &&
    !opts.retryableFetchFailures &&
    opts.violations.length === 0
  );
}

export function pageViolationMessages(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `Sidekontrol: ${violation.rule} — ${violation.detail}`);
}

export async function runBrief(client: AulaClient, opts: BriefOptions = {}): Promise<BriefRun> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? HISTORY_DAYS;
  const isoWeek = opts.isoWeek ?? isoWeekString(now);
  const notes: string[] = [];
  const runId = randomUUID();
  const revision = sourceRevision();
  const startedAt = performance.now();
  const phaseMs: Record<string, number> = {};
  const log = (event: Parameters<typeof appendBriefLog>[0]['event'], details: unknown) =>
    appendBriefLog(
      {
        at: new Date().toISOString(),
        event,
        day: localIsoDate(now),
        isoWeek,
        model: process.env.AULA_BRIEF_MODEL ?? null,
        effort: process.env.AULA_BRIEF_EFFORT ?? null,
        useCache: opts.useCache !== false,
        details: { runId, ...(details as Record<string, unknown>) },
      },
      undefined,
      revision,
    );
  const phase = (name: string, phaseStartedAt: number, details: Record<string, unknown> = {}) => {
    const elapsedMs = Math.round(performance.now() - phaseStartedAt);
    phaseMs[name] = elapsedMs;
    log('brief.phase.finished', { phase: name, elapsedMs, ...details });
    return elapsedMs;
  };

  log('brief.run.started', {
    days,
    deploy: opts.deploy !== false,
    useModel: opts.useModel !== false,
  });

  const collectStartedAt = performance.now();
  const input = await collect(client, {
    days,
    isoWeek,
    now,
    onPhase: (name, elapsedMs) => {
      phaseMs[name] = elapsedMs;
      log('brief.phase.finished', { phase: name, elapsedMs });
    },
  });
  phase('collect', collectStartedAt, {
    sourceCount: input.items.length,
    personalEventCount: input.items.filter((item) => item.kind === 'personal').length,
  });

  // ------------------------------------------------------------- the model
  let topline: string | null = null;
  let summaries: Record<string, string> = {};
  // null until the model has answered: the rules are then the cards, not a
  // supplement to them — see `rank`.
  let modelCards: Card[] | null = null;
  let personalEvents: PersonalEventVerdict[] | null = null;
  let hidden: string[] = [];
  let extractionRan = opts.useModel === false;
  let supplementRules = false;
  let extractionStatus: string | null = null;
  let overviewWarning: string | null = null;
  let extractionTelemetry: unknown = null;
  /** Set when the run failed on something a later attempt cannot fix. */
  let dependencyMissing = false;

  if (opts.useModel !== false) {
    const extractStartedAt = performance.now();
    try {
      const extracted = await extractCards(input, { useCache: opts.useCache !== false });
      extractionTelemetry = extracted.telemetry ?? null;
      phase('extract', extractStartedAt, { extraction: extractionTelemetry });
      topline = extracted.topline;
      summaries = extracted.childSummaries;
      modelCards = extracted.cards;
      personalEvents = extracted.personalEvents;
      hidden = extracted.hidden;
      extractionRan = extracted.problems.length === 0;
      supplementRules = extracted.problems.length > 0;
      if (extracted.problems.length > 0) {
        extractionStatus =
          `Modellens svar var ufuldstændigt (${extracted.problems.length} fejl), ` +
          'så siden bruger de validerede kort og reglerne som reserve for resten.';
        const logged = log('brief.model.incomplete', {
          event: 'brief.model.incomplete',
          problemCount: extracted.problems.length,
          problems: extracted.problems,
          extraction: extractionTelemetry,
        });
        notes.push(
          logged.ok
            ? `Udviklerlog: ${logged.path}`
            : `Udviklerloggen kunne ikke skrives til ${logged.path}: ${logged.error}`,
        );
      }
      for (const problem of extracted.problems) {
        notes.push(`Udtræk afvist: ${problem}`);
      }
    } catch (err) {
      phase('extract', extractStartedAt, { error: errorForBriefLog(err) });
      // A missing `claude` is not a transient model failure: it will still be
      // missing tomorrow morning, so "try again later" is the one piece of
      // advice guaranteed not to help. Name the dependency instead.
      const missing = err instanceof ClaudeMissingError;
      dependencyMissing ||= missing;
      overviewWarning = missing
        ? 'Claude er ikke installeret, og oversigten skrives med den. Oversigten er ' +
          'derfor kun bygget med simple regler og kan mangle vigtige punkter. ' +
          'Installér Claude, og dan oversigten igen.'
        : 'Modellen kunne ikke prioritere indholdet. Oversigten er derfor kun bygget med ' +
          'simple regler og kan mangle vigtige punkter eller have en mindre nyttig rækkefølge. ' +
          'Prøv at generere den igen senere.';
      notes.push(
        missing
          ? `Claude mangler — installér med: ${CLAUDE_INSTALL_COMMAND}`
          : `Modellen kunne ikke køre (${errorMessage(err)}) — kun reglerne blev brugt.`,
      );
      const logged = log('brief.model.failed', errorForBriefLog(err));
      notes.push(
        logged.ok
          ? `Udviklerlog: ${logged.path}`
          : `Udviklerloggen kunne ikke skrives til ${logged.path}: ${logged.error}`,
      );
    }
  }

  const brief = rank(input, {
    model: modelCards,
    personalEvents,
    rules: cardsFromRules(input, now),
    hidden,
    supplementRules,
  });
  if (extractionStatus) brief.degraded.push(extractionStatus);

  // ----------------------------------------------------------------- render
  const renderStartedAt = performance.now();
  const state = loadState();
  const newKeys = whichAreNew(
    state,
    input.items.map((item) => item.key),
    now,
  );
  const isNew = (key: string) => newKeys.has(key);

  const origin: BriefRun['origin'] = modelCards === null ? 'fallback' : 'model';
  const pageOptions: PageOptions = {
    topline,
    summaries,
    isNew,
    generatedAt: now,
    ...(overviewWarning ? { overviewWarning } : {}),
    ...(origin === 'fallback' && opts.useModel !== false ? { note: 'kun reglerne' } : {}),
  };
  let body = renderPage(brief, pageOptions);
  // The page is held to its invariants whoever wrote the cards.
  const violations = validatePage(body, brief);
  for (const v of violations) {
    notes.push(`Siden: ${v.rule} (${v.detail})`);
  }
  brief.degraded.push(...pageViolationMessages(violations));
  if (violations.length > 0) {
    // Publish the usable page, but make its own validation failure visible in
    // Datastatus. The scheduler will retry because completion is gated below.
    body = renderPage(brief, pageOptions);
  }
  phase('render', renderStartedAt, { pageViolationCount: violations.length });

  // ---------------------------------------------------------------- publish
  const publishStartedAt = performance.now();
  const published = await publish(body, {
    day: input.today,
    title: BRIEF_TITLE,
    ...(opts.outDir ? { dir: opts.outDir } : {}),
    ...(opts.pdf === true ? { pdf: true } : {}),
    ...(opts.png === true ? { png: true } : {}),
  });
  notes.push(...published.warnings);
  phase('publish', publishStartedAt, { warningCount: published.warnings.length });

  // Local first, hosted second. The file on disk is the brief; the artifact is
  // a convenience on top of it, so a deploy that fails is a note on an
  // otherwise good run rather than a failed one.
  let deployment: DeployResult = { status: 'skipped', reason: 'slået fra med --no-deploy' };
  const deployStartedAt = performance.now();
  if (opts.deploy !== false) {
    deployment = await deployArtifact(published.artifactPath, { title: BRIEF_TITLE });
    if (deployment.status === 'failed') {
      notes.push(`Artifact blev ikke opdateret: ${deployment.reason}`);
    }
    if (deployment.status === 'ok') recordDeploy(state, deployment.url, now);
  }
  phase('deploy', deployStartedAt, { status: deployment.status });

  // A run counts as complete only when nothing retryable had to be papered over:
  // the model's extraction ran, its page passed validation, and the hosted copy
  // — where one is configured — was actually refreshed. With `--no-llm` the
  // rules-only page is what was asked for, so it is complete on its own terms.
  const complete = isBriefRunComplete({
    modelWasRequested: opts.useModel !== false,
    extractionRan,
    origin,
    deploymentFailed: deployment.status === 'failed',
    retryableFetchFailures: input.health.some((note) => note.retryable === true),
    violations,
  });

  // Recorded only once the page exists, so a crash re-shows rather than hides.
  markSeen(
    state,
    input.items.map((item) => item.key),
    now,
  );
  pruneState(state);
  recordRun(state, { day: input.today, complete }, now);
  saveState(state);

  log('brief.run.finished', {
    complete,
    origin,
    totalMs: Math.round(performance.now() - startedAt),
    phaseMs,
    extraction: extractionTelemetry,
    deployment: { status: deployment.status },
  });

  return {
    brief,
    topline,
    origin,
    published,
    deployment,
    notes,
    complete,
    retryable: !dependencyMissing,
  };
}
