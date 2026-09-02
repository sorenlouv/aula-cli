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
import { ClaudeRunError, runClaude, type ClaudeAttempt } from '../llm/claude.ts';
import {
  briefCardRepairRequest,
  type CardRepairCandidate,
} from '../llm/requests/brief-card-repair.ts';
import { briefExtractionRequest } from '../llm/requests/brief-extraction.ts';

export {
  modelEffortArgs,
  parseClaudeJson,
  parseClaudeStreamJson,
  runClaude,
  spawnClaude,
} from '../llm/claude.ts';
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
 * How long one extraction call may take, measured rather than guessed.
 *
 * A high-effort extraction of ~55 sources takes about four and a half minutes.
 * The old 300s ceiling therefore left roughly thirty seconds of headroom: the
 * scheduled run on 2026-09-02 finished its model call in 266s, and two runs
 * that overlapped later the same morning both crossed 300s, timed out on both
 * attempts, and spent ten minutes each to produce a rules-only page. A ceiling
 * that close to the normal case does not catch stalls, it converts a slow
 * morning into a degraded brief.
 *
 * Doubling it is deliberate: a genuine stall is caught by the same timeout one
 * attempt later, and the scheduler's own budget (see `scheduled-brief.ts`)
 * bounds the day regardless of how long a single call takes.
 */
const EXTRACTION_TIMEOUT_MS = 600_000;

/**
 * `AULA_BRIEF_TIMEOUT` in seconds, for a machine or model where the default is
 * wrong. `aula schedule` bakes it into the agent alongside the model and effort
 * it already carries — launchd hands the job no shell environment.
 */
function extractionTimeoutMs(): number {
  const seconds = Number(process.env.AULA_BRIEF_TIMEOUT);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : EXTRACTION_TIMEOUT_MS;
}
/**
 * Bumped whenever the answer's shape changes. It is part of the cache key, so
 * an entry written under the old contract is simply not found rather than
 * read back with a field missing — the first run after an upgrade must not
 * spend its day on yesterday's answer shape.
 */
const CONTRACT_VERSION = 8;
/** Whitespace-insensitive containment. Aula's HTML flattening leaves odd runs of spaces. */
export type ExtractResult = {
  topline: string | null;
  cards: Card[];
  personalEvents: PersonalEventVerdict[];
  childSummaries: Record<string, string>;
  /** Aula source keys the model kept off the page. Listed in the muted foot. */
  hidden: string[];
  problems: string[];
  /** Numeric request/transport metadata for the private developer log. */
  telemetry?: ExtractionTelemetry;
};

export type ExtractionTelemetry = {
  cacheHit: boolean;
  sourceCount: number;
  personalEventCount: number;
  payloadChars: number;
  instructionsChars: number;
  schemaChars: number;
  primaryAttempts: ClaudeAttempt[];
  repair?: {
    candidateCount: number;
    requestChars: number;
    attempts: ClaudeAttempt[];
  };
  initialProblemCount: number;
  finalProblemCount: number;
};

const EMPTY: ExtractResult = {
  topline: null,
  cards: [],
  personalEvents: [],
  childSummaries: {},
  hidden: [],
  problems: [],
};

type ValidationResult = ExtractResult & { repairCandidates: CardRepairCandidate[] };

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
  const { repairCandidates: _repairCandidates, ...result } = validateExtractionDetailed(
    input,
    parsed,
  );
  return result;
}

/** Internal validation keeps only safe-to-repair card snapshots beside the public result. */
function validateExtractionDetailed(input: BriefInput, parsed: unknown): ValidationResult {
  if (!isRecord(parsed)) {
    return { ...EMPTY, problems: ['svaret var ikke et objekt'], repairCandidates: [] };
  }
  const problems: string[] = [];
  const repairCandidates: CardRepairCandidate[] = [];
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
  const cardSnapshot = (
    raw: Record<string, unknown>,
    sourceKeys: string[],
  ): Record<string, unknown> => ({
    title: raw.title,
    summary: raw.summary,
    children: raw.children,
    date: raw.date,
    recurring: raw.recurring,
    needsAction: raw.needsAction,
    actionableNow: raw.actionableNow,
    reason: raw.reason,
    sourceKeys,
  });
  const rejectedDateCard = (
    cardIndex: number,
    raw: Record<string, unknown>,
    sourceKeys: string[],
    problem: string,
  ) => {
    problems.push(problem);
    repairCandidates.push({
      cardIndex,
      problem,
      card: cardSnapshot(raw, sourceKeys),
      sourceKeys,
    });
  };
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
        rejectedDateCard(
          index,
          raw,
          sourceKeys,
          `${label}: date ${iso.iso} har ikke belæg i nogen af kortets kilder`,
        );
        continue;
      }
      date = iso.iso;
    }
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null;
    const invented = unsupportedAcross([title, summary, reason ?? ''].join(' '), sourceKeys, date);
    if (invented.length > 0) {
      rejectedDateCard(
        index,
        raw,
        sourceKeys,
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

  return { topline, cards, personalEvents, childSummaries, hidden, problems, repairCandidates };
}

function cacheKey(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function sameStringArray(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === 'string' && value === right[index])
  );
}

/** A card repair may only replace the rejected slot and keep its original semantics. */
function mergeCardRepairs(
  parsed: unknown,
  candidates: CardRepairCandidate[],
  repaired: unknown,
): unknown {
  if (!isRecord(parsed) || !Array.isArray(parsed.cards)) return null;
  if (!isRecord(repaired) || !Array.isArray(repaired.repairs)) return null;
  if (repaired.repairs.length !== candidates.length) return null;

  const byIndex = new Map(candidates.map((candidate) => [candidate.cardIndex, candidate]));
  const replacements = new Map<number, Record<string, unknown>>();
  for (const raw of repaired.repairs) {
    if (
      !isRecord(raw) ||
      typeof raw.cardIndex !== 'number' ||
      !Number.isInteger(raw.cardIndex) ||
      !isRecord(raw.card)
    ) {
      return null;
    }
    const cardIndex = raw.cardIndex;
    const candidate = byIndex.get(cardIndex);
    if (!candidate || replacements.has(cardIndex)) return null;
    if (
      !sameStringArray(raw.card.sourceKeys, candidate.sourceKeys) ||
      !sameStringArray(raw.card.children, candidate.card.children) ||
      raw.card.recurring !== candidate.card.recurring ||
      raw.card.needsAction !== candidate.card.needsAction ||
      raw.card.actionableNow !== candidate.card.actionableNow
    ) {
      return null;
    }
    replacements.set(cardIndex, {
      ...raw.card,
      children: candidate.card.children,
      sourceKeys: candidate.sourceKeys,
    });
  }
  if (replacements.size !== candidates.length) return null;

  const cards = [...parsed.cards];
  for (const [index, card] of replacements) cards[index] = card;
  return { ...parsed, cards };
}

/**
 * One full extraction pass, followed only by a source-bounded repair for cards
 * rejected by date grounding. Re-ranking every source to repair one date made
 * the common validation edge cost another complete high-effort model turn.
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
  const telemetryBase = {
    sourceCount: input.items.length,
    personalEventCount: input.items.filter((item) => item.kind === 'personal').length,
    payloadChars: JSON.stringify(payload).length,
    instructionsChars: instructions.length,
    schemaChars: JSON.stringify(schema).length,
  };

  if (opts.useCache !== false) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      const validated = validateExtraction(input, cached);
      if (validated.problems.length === 0) {
        return {
          ...validated,
          telemetry: {
            ...telemetryBase,
            cacheHit: true,
            primaryAttempts: [],
            initialProblemCount: 0,
            finalProblemCount: 0,
          },
        };
      }
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
  const call = {
    timeoutMs: opts.timeoutMs ?? extractionTimeoutMs(),
    schema,
    purpose: 'brief' as const,
  };
  const answer = await runClaude(instructions, body, call);

  // `runClaude` requires the schema-checked tool parameters. Unstructured text
  // is never accepted as a second contract: a missing structured result is a
  // transport failure and the caller honestly falls back to rules.
  let parsed = answer.structured;
  let validated = validateExtractionDetailed(input, parsed);
  const initialProblemCount = validated.problems.length;
  let repairTelemetry: ExtractionTelemetry['repair'];

  // A date-only rejection retains all the ranking work that did validate. Its
  // repair sees only that card and its current citations, runs once at the
  // low-cost repair setting, and still faces the full production validator.
  if (
    validated.repairCandidates.length > 0 &&
    validated.repairCandidates.length === validated.problems.length
  ) {
    const repairInput = { input, candidates: validated.repairCandidates };
    const repairPayload = briefCardRepairRequest.payload(repairInput);
    const repairInstructions = briefCardRepairRequest.instructions(repairInput);
    const repairSchema = briefCardRepairRequest.schema(repairInput);
    repairTelemetry = {
      candidateCount: validated.repairCandidates.length,
      requestChars:
        JSON.stringify(repairPayload).length +
        repairInstructions.length +
        JSON.stringify(repairSchema).length,
      attempts: [],
    };
    try {
      const repair = await runClaude(repairInstructions, JSON.stringify(repairPayload), {
        timeoutMs: Math.min(opts.timeoutMs ?? extractionTimeoutMs(), 120_000),
        schema: repairSchema,
        maxAttempts: 1,
        purpose: 'repair',
      });
      repairTelemetry.attempts = repair.attempts;
      const merged = mergeCardRepairs(parsed, validated.repairCandidates, repair.structured);
      if (merged !== null) {
        const repaired = validateExtractionDetailed(input, merged);
        if (repaired.problems.length === 0) {
          parsed = merged;
          validated = repaired;
        }
      }
    } catch (error) {
      if (error instanceof ClaudeRunError) {
        repairTelemetry.attempts = error.details.attempts.map(
          ({ code, timedOut, stoppedAfterOutput, durationMs }) => ({
            code,
            timedOut,
            stoppedAfterOutput,
            durationMs,
          }),
        );
      }
      // Keep the first result; a failed small repair is visible and retryable.
    }
  }

  // A run told to ignore the cache must not author it either — otherwise a
  // `--no-cache` run (or a model comparison) pins its answer for whoever runs
  // next inside the content window. Invalid/partial answers are not cached
  // either: the next run deserves another chance to obtain every verdict.
  if (opts.useCache !== false && validated.problems.length === 0) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(parsed, null, 2));
      pruneExtractionCache(cachePath);
    } catch {
      // A brief that cannot cache is still a brief.
    }
  }
  const { repairCandidates: _repairCandidates, ...result } = validated;
  return {
    ...result,
    telemetry: {
      ...telemetryBase,
      cacheHit: false,
      primaryAttempts: answer.attempts,
      ...(repairTelemetry ? { repair: repairTelemetry } : {}),
      initialProblemCount,
      finalProblemCount: result.problems.length,
    },
  };
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
