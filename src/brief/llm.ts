/**
 * The model call, and the validation that makes it safe to trust.
 *
 * One call. It reads the payload — every source, with text — and answers in a
 * schema: the cards, finished; one verdict per personal appointment; the
 * topline; a line per child; and the Aula sources to keep off the page. The
 * page is then built locally from that answer.
 *
 * The request itself lives in `llm/requests/brief-extraction.ts`. This module
 * runs it, caches complete answers, and checks what a JSON schema cannot — for
 * example, whether a date the model wrote actually stands in its source. A
 * card that fails is dropped and reported, never quietly repaired.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDateSupport,
  dueAtSupported,
  findRecurringWeekdays,
  overviewWindow,
  unsupportedDateClaims,
} from './dates.ts';
import { BRIEF_DIR } from './state.ts';
import type { BriefInput, Card, PersonalEventVerdict } from './types.ts';
import { isRecord, parseIsoDateParts } from '../validation.ts';
import { runClaude } from '../llm/claude.ts';
import { briefExtractionRequest } from '../llm/requests/brief-extraction.ts';

export { modelEffortArgs, parseClaudeJson, runClaude, spawnClaude } from '../llm/claude.ts';
export type { ClaudeExit, ClaudeReply } from '../llm/claude.ts';
export {
  briefExtractionRequest,
  extractionInstructions,
  extractionPayload,
  extractionSchema,
  withPreferences,
} from '../llm/requests/brief-extraction.ts';

const CACHE_DIR = join(BRIEF_DIR, 'cache');
const CACHE_FILE_LIMIT = 32;
/**
 * Bumped whenever the answer's shape changes. It is part of the cache key, so
 * an entry written under the old contract is simply not found rather than
 * read back with a field missing — the first run after an upgrade must not
 * spend its day on yesterday's answer shape.
 */
const CONTRACT_VERSION = 7;
/** Whitespace-insensitive containment. Aula's HTML flattening leaves odd runs of spaces. */
export type ExtractResult = {
  topline: string | null;
  cards: Card[];
  personalEvents: PersonalEventVerdict[];
  childSummaries: Record<string, string>;
  /** Aula source keys the model kept off the page. Listed in the muted foot. */
  hidden: string[];
  problems: string[];
};

const EMPTY: ExtractResult = {
  topline: null,
  cards: [],
  personalEvents: [],
  childSummaries: {},
  hidden: [],
  problems: [],
};

/**
 * Checks a model response against the input it was given.
 *
 * The shape is the schema's job, so what is left to check is what a schema
 * cannot know: whether a date the model wrote is in the text it cites, and
 * whether the fixed-length personal verdict list names every appointment once.
 * A card's `date` must be supported by at least one of its sources; a date
 * named in its title, summary or reason must be supported by at least one of
 * them too. A card or verdict that fails is dropped and reported.
 *
 * The topline and the per-child lines are checked against every source at
 * once (they are about the week, not one card) and dropped on failure; the
 * page has a plain fallback for each.
 */
export function validateExtraction(input: BriefInput, parsed: unknown): ExtractResult {
  if (!isRecord(parsed)) return { ...EMPTY, problems: ['svaret var ikke et objekt'] };
  const problems: string[] = [];
  const items = new Map(input.items.map((item) => [item.key, item]));
  const firstNames = new Set(input.family.children.map((c) => c.firstName));
  // Anthropic's structured-output contract explicitly permits string enum and
  // const values to differ only in capitalization. Recover the input's exact
  // spelling before any lookup or before a key reaches the rendered page.
  const byCase = (values: Iterable<string>) =>
    new Map([...values].map((value) => [value.toLocaleLowerCase('da-DK'), value]));
  const itemKeysByCase = byCase(items.keys());
  const firstNamesByCase = byCase(firstNames);
  const canonicalItemKey = (value: string) =>
    items.has(value) ? value : (itemKeysByCase.get(value.toLocaleLowerCase('da-DK')) ?? value);
  const canonicalFirstName = (value: string) =>
    firstNames.has(value) ? value : firstNamesByCase.get(value.toLocaleLowerCase('da-DK'));
  const support = buildDateSupport(input);

  // A claim is unsupported only if *none* of the card's sources supports it —
  // a merged card routinely quotes a day one source dated and another echoed.
  const unsupportedAcross = (text: string, sourceKeys: string[], date: string | null) => {
    const perSource = sourceKeys.map(
      (sourceKey) => new Set(unsupportedDateClaims(text, support, { dueAt: date, sourceKey })),
    );
    const first = perSource[0] ?? new Set<string>();
    return [...first].filter((claim) => perSource.every((bad) => bad.has(claim)));
  };

  const cards: Card[] = [];
  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  if (!Array.isArray(parsed.cards)) problems.push('"cards" mangler eller er ikke en liste');
  for (const [index, raw] of rawCards.entries()) {
    if (!isRecord(raw)) {
      problems.push(`cards[${index}] er ikke et objekt`);
      continue;
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const label = `cards[${index}] ("${title || '?'}")`;
    if (!title) {
      problems.push(`${label}: title mangler`);
      continue;
    }
    const sourceKeys = Array.isArray(raw.sourceKeys)
      ? raw.sourceKeys.filter((key): key is string => typeof key === 'string').map(canonicalItemKey)
      : [];
    const unknown = sourceKeys.filter((key) => !items.has(key));
    if (sourceKeys.length === 0 || unknown.length > 0) {
      problems.push(
        `${label}: sourceKeys ${sourceKeys.length === 0 ? 'mangler' : `ukendt: ${unknown.join(', ')}`}`,
      );
      continue;
    }
    if (sourceKeys.some((key) => items.get(key)?.kind === 'personal')) {
      problems.push(`${label}: en kalenderaftale bliver ikke til et kort`);
      continue;
    }
    let date: string | null = null;
    if (typeof raw.date === 'string' && raw.date.trim()) {
      const iso = parseIsoDateParts(raw.date.trim().slice(0, 10));
      if (!iso) {
        problems.push(`${label}: date "${raw.date}" er ikke en dato`);
        continue;
      }
      if (!sourceKeys.some((key) => dueAtSupported(iso.iso, key, support))) {
        problems.push(`${label}: date ${iso.iso} har ikke belæg i nogen af kortets kilder`);
        continue;
      }
      date = iso.iso;
    }
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null;
    const invented = unsupportedAcross([title, summary, reason ?? ''].join(' '), sourceKeys, date);
    if (invented.length > 0) {
      problems.push(
        `${label}: dato uden belæg i kortets kilder: ${invented.map((d) => `"${d}"`).join(', ')}`,
      );
      continue;
    }
    const recurring = raw.recurring === true;
    if (recurring) {
      const cardDays = new Set(findRecurringWeekdays(`${title}\n${summary}`));
      const sourceDays = new Set(
        sourceKeys.flatMap((key) => {
          const source = items.get(key)!;
          return findRecurringWeekdays(`${source.title}\n${source.text}`);
        }),
      );
      const cardSourceDays = [...cardDays].filter((day) => sourceDays.has(day));
      const datedWeekday = date ? parseIsoDateParts(date)?.weekday : undefined;
      const candidates = (cardSourceDays.length > 0 ? cardSourceDays : [...sourceDays]).filter(
        (day) => datedWeekday === undefined || day === datedWeekday,
      );
      if (candidates.length !== 1) {
        problems.push(`${label}: recurring har ikke én fast ugedag i kortets kilder`);
        continue;
      }
    }
    const children = Array.isArray(raw.children)
      ? raw.children
          .filter((name): name is string => typeof name === 'string')
          .map(canonicalFirstName)
          .filter((name): name is string => name !== undefined)
      : [];
    const needsAction = raw.needsAction === true;
    const actionableNow = raw.actionableNow === true;
    if (actionableNow && !needsAction) {
      problems.push(`${label}: actionableNow=true kræver needsAction=true`);
      continue;
    }
    cards.push({
      id: `model:${index}`,
      title,
      summary,
      children,
      date,
      recurring,
      needsAction,
      actionableNow,
      reason,
      sourceKeys,
      origin: 'model',
    });
  }

  // Every personal appointment needs an explicit verdict. A missing decision
  // is not interpreted as irrelevant: the ranker shows unaccounted-for events
  // with deterministic source text, while this problem keeps the run
  // incomplete and out of the cache.
  const personalKeys = input.items
    .filter((item) => item.kind === 'personal')
    .map((item) => item.key);
  const expectedPersonal = new Set(personalKeys);
  const seenPersonal = new Set<string>();
  const personalEvents: PersonalEventVerdict[] = [];
  const rawPersonal = Array.isArray(parsed.personalEvents) ? parsed.personalEvents : [];
  if (!Array.isArray(parsed.personalEvents)) {
    problems.push('"personalEvents" mangler eller er ikke en liste');
  }
  for (const [index, raw] of rawPersonal.entries()) {
    if (!isRecord(raw)) {
      problems.push(`personalEvents[${index}] er ikke et objekt`);
      continue;
    }
    const sourceKey = typeof raw.sourceKey === 'string' ? canonicalItemKey(raw.sourceKey) : '';
    const label = `personalEvents[${index}] (${sourceKey || '?'})`;
    if (!expectedPersonal.has(sourceKey)) {
      problems.push(`${label}: sourceKey er ikke en personlig kalenderaftale`);
      continue;
    }
    if (seenPersonal.has(sourceKey)) {
      problems.push(`${label}: kalenderaftalen har mere end én relevansvurdering`);
      continue;
    }
    seenPersonal.add(sourceKey);
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (typeof raw.relevant !== 'boolean' || !summary || !reason) {
      problems.push(`${label}: relevant, summary eller reason mangler`);
      continue;
    }
    const invented = unsupportedDateClaims(`${summary} ${reason}`, support, { sourceKey });
    if (invented.length > 0) {
      problems.push(
        `${label}: dato uden belæg i kalenderaftalen: ${invented.map((d) => `"${d}"`).join(', ')}`,
      );
      continue;
    }
    personalEvents.push({ sourceKey, relevant: raw.relevant, summary, reason });
  }
  const missingPersonal = personalKeys.filter((key) => !seenPersonal.has(key));
  if (missingPersonal.length > 0) {
    problems.push(
      `personalEvents mangler relevansvurdering for ${missingPersonal.length} kalenderaftale${missingPersonal.length === 1 ? '' : 'r'}: ${missingPersonal.join(', ')}`,
    );
  }

  const grounded = (value: unknown, where: string): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    // The prompt supplies this boundary and asks the overview prose to respect
    // it. It is system-grounded context for topline/child summaries, but not a
    // source-grounded date that a card may borrow.
    const bad = unsupportedDateClaims(value, support, {
      dueAt: overviewWindow(input.today).through,
    });
    if (bad.length === 0) return value.trim();
    problems.push(`${where}: dato uden belæg: ${bad.map((d) => `"${d}"`).join(', ')}`);
    return null;
  };
  const topline = grounded(parsed.topline, 'topline');

  const childSummaries: Record<string, string> = {};
  if (isRecord(parsed.childSummaries)) {
    for (const [name, value] of Object.entries(parsed.childSummaries)) {
      if (!firstNames.has(name)) continue;
      const text = grounded(value, `childSummaries.${name}`);
      if (text) childSummaries[name] = text;
    }
  }

  const hidden: string[] = [];
  if (Array.isArray(parsed.hidden)) {
    for (const rawKey of parsed.hidden) {
      if (typeof rawKey !== 'string') continue;
      const key = canonicalItemKey(rawKey);
      const item = items.get(key);
      if (!item) continue;
      if (item.kind === 'personal') {
        problems.push(`hidden: kalenderaftalen ${key} skal vurderes i personalEvents`);
        continue;
      }
      hidden.push(key);
    }
  }

  return { topline, cards, personalEvents, childSummaries, hidden, problems };
}

function cacheKey(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/**
 * One extraction pass, with a single corrective retry.
 *
 * A retry is worth exactly one attempt: the failures that survive a round of
 * "here is what was wrong with your last answer" are not the kind another go
 * fixes, and the rules layer is a perfectly serviceable floor.
 */
export async function extractCards(
  input: BriefInput,
  opts: { useCache?: boolean; timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const payload = briefExtractionRequest.payload(input);
  const instructions = briefExtractionRequest.instructions(input);
  const schema = briefExtractionRequest.schema(input);
  // The whole question is part of the key, not just the data it is asked about.
  //
  // The preferences are the obvious half: keyed on the payload alone, a run made
  // minutes after `aula remember` would answer from an entry that never saw the
  // new wish — the feature would look broken exactly when it was being tried out.
  //
  // The prompt itself is the half that bit. `instructions` used to be absent
  // here, so editing the prompt changed nothing for any input already cached.
  // The schema belongs here too: field descriptions carry semantic policy, so
  // tuning one must invalidate the answer written under its old wording.
  const key = cacheKey({ contract: CONTRACT_VERSION, payload, instructions, schema });
  const cachePath = join(CACHE_DIR, `extract-${key}.json`);

  if (opts.useCache !== false) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      const validated = validateExtraction(input, cached);
      if (validated.problems.length === 0) return validated;
    } catch {
      // No usable cache entry; fall through and call the model.
    }
  }

  const body = JSON.stringify(payload);

  // A model that could not run is not a model that found nothing, and the
  // difference has to survive: swallowing it here made a missing `claude`
  // binary indistinguishable from a quiet day, with no note on the page saying
  // the brief was built by the rules alone. runBrief catches this and degrades,
  // so letting it through still produces a brief — it just produces an honest
  // one. Nothing is written to the cache on this path either; a 06:30 outage
  // must not pin a degraded brief for the rest of the day.
  const call = { timeoutMs: opts.timeoutMs ?? 240_000, schema };
  const answer = await runClaude(instructions, body, call);

  // `runClaude` requires the schema-checked tool parameters. Unstructured text
  // is never accepted as a second contract: a missing structured result is a
  // transport failure and the caller honestly falls back to rules.
  let parsed = answer.structured;
  let result = validateExtraction(input, parsed);

  // The shape and the source keys are the schema's, so a second pass only ever
  // fixes the one thing checked against the sources themselves: a date that is
  // not in the text it was said to come from.
  if (result.problems.length > 0) {
    const retry = `${instructions}

Dit forrige svar havde disse fejl. Ret dem, og svar igen med det hele:
${result.problems.map((p) => `- ${p}`).join('\n')}`;
    try {
      const second = await runClaude(retry, body, call);
      const secondParsed = second.structured;
      const reparsed = validateExtraction(input, secondParsed);
      // A corrective answer may fix the named date and forget valid cards or
      // calendar verdicts. Fewer problems is better only when it preserves both
      // kinds of survivor; otherwise the first partial answer is more useful.
      if (
        reparsed.problems.length < result.problems.length &&
        reparsed.cards.length >= result.cards.length &&
        reparsed.personalEvents.length >= result.personalEvents.length
      ) {
        result = reparsed;
        parsed = secondParsed;
      }
    } catch {
      // Keep the first result; the caller degrades gracefully.
    }
  }

  // A run told to ignore the cache must not author it either — otherwise a
  // `--no-cache` run (or a model comparison) pins its answer for whoever runs
  // next inside the content window. Invalid/partial answers are not cached
  // either: the next run deserves another chance to obtain every verdict.
  if (opts.useCache !== false && result.problems.length === 0) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(parsed, null, 2));
      pruneExtractionCache(cachePath);
    } catch {
      // A brief that cannot cache is still a brief.
    }
  }
  return result;
}

function pruneExtractionCache(keepPath: string): void {
  const files = readdirSync(CACHE_DIR)
    .filter((name) => /^extract-[a-f0-9]+\.json$/.test(name))
    .map((name) => {
      const path = join(CACHE_DIR, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(CACHE_FILE_LIMIT)) {
    if (file.path !== keepPath) unlinkSync(file.path);
  }
}
