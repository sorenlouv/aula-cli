/**
 * The `aula brief` pipeline.
 *
 *   collect → extract (rules ∪ model) → rank → compose → validate → publish
 *
 * Every stage after `collect` degrades rather than throws. A brief that is
 * missing the model's phrasing is still useful; a brief that failed to appear
 * is not, and the whole point is that not opening Aula stops costing anything.
 */

import type { AulaClient } from '../client.ts';
import { isoWeekString } from '../integrations/types.ts';
import { collect } from './collect.ts';
import { composePage, fallbackPage } from './compose.ts';
import { extractSignals } from './llm.ts';
import { publish, type PublishResult } from './publish.ts';
import { rank, signalsFromRules } from './rank.ts';
import { loadState, markSeen, pruneState, saveState, whichAreNew } from './state.ts';
import type { RankedBrief } from './types.ts';
import { validatePage, type Violation } from './validate.ts';

export type BriefOptions = {
  days?: number;
  isoWeek?: string;
  useModel?: boolean;
  useCache?: boolean;
  outDir?: string;
  pdf?: boolean;
  png?: boolean;
  now?: Date;
};

export type BriefRun = {
  brief: RankedBrief;
  topline: string | null;
  origin: 'model' | 'fallback';
  violations: Violation[];
  published: PublishResult;
  notes: string[];
};

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

  if (opts.useModel !== false) {
    try {
      const extracted = await extractSignals(input, { useCache: opts.useCache !== false });
      topline = extracted.topline;
      summaries = extracted.childSummaries;
      modelSignals = extracted.signals;
      for (const problem of extracted.problems) {
        notes.push(`Udtræk afvist: ${problem}`);
      }
    } catch (err) {
      notes.push(`Modellen kunne ikke køre (${(err as Error).message}) — kun reglerne blev brugt.`);
    }
  }

  const brief = rank(input, [...modelSignals, ...signalsFromRules(input, now)]);

  // ---------------------------------------------------------------- compose
  const state = loadState();
  const newKeys = whichAreNew(state, input.items.map((item) => item.key));
  const isNew = (key: string) => newKeys.has(key);

  let body = '';
  let origin: BriefRun['origin'] = 'fallback';
  let violations: Violation[] = [];

  if (opts.useModel !== false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const composed = await composePage(brief, { topline, summaries, isNew });
        const found = validatePage(composed.html, brief);
        if (found.length === 0) {
          body = composed.html;
          origin = 'model';
          violations = [];
          break;
        }
        violations = found;
        notes.push(
          `Layoutforsøg ${attempt + 1} afvist: ${found.map((v) => `${v.rule} (${v.detail})`).join('; ')}`,
        );
      } catch (err) {
        notes.push(`Layoutforsøg ${attempt + 1} fejlede: ${(err as Error).message}`);
      }
    }
  }

  if (!body) {
    body = fallbackPage(brief, {
      topline,
      summaries,
      note: opts.useModel === false ? undefined : 'reservelayout',
    });
    origin = 'fallback';
    // The fallback is held to the same standard as the model's output.
    violations = validatePage(body, brief);
  }

  // ---------------------------------------------------------------- publish
  const published = await publish(body, {
    day: input.today,
    // Stable on purpose. The page is republished to the same URL every day, and
    // a title that carried the date would read as a different page each time.
    // The date is in the page itself.
    title: 'Aula AI oversigt',
    ...(opts.outDir ? { dir: opts.outDir } : {}),
    ...(opts.pdf === true ? { pdf: true } : {}),
    ...(opts.png === true ? { png: true } : {}),
  });
  notes.push(...published.warnings);

  // Recorded only once the page exists, so a crash re-shows rather than hides.
  markSeen(state, input.items.map((item) => item.key), now);
  pruneState(state);
  state.lastRunAt = now.toISOString();
  state.lastGoodHtmlPath = published.htmlPath;
  saveState(state);

  return { brief, topline, origin, violations, published, notes };
}
