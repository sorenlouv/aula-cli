/**
 * The model calls, and the validation that makes them safe to trust.
 *
 * Two separate calls, and only the first one ever sees Aula content:
 *
 *  1. `extractSignals` reads the payload and returns facts.
 *  2. `compose` (in `compose.ts`) receives only *validated* facts and designs
 *     the page.
 *
 * That split is what lets the composer have real freedom over layout: it cannot
 * invent a deadline it was never shown. Everything here exists to make step 1's
 * output checkable — above all the rule that a quote must appear literally in
 * the source it cites.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDateSupport, dueAtSupported, unsupportedDateClaims } from './dates.ts';
import { BRIEF_DIR } from './state.ts';
import type { BriefInput, Signal, SignalKind, Urgency } from './types.ts';

const CACHE_DIR = join(BRIEF_DIR, 'cache');
const KINDS: ReadonlySet<string> = new Set<SignalKind>([
  'action', 'deadline', 'event', 'bring', 'info', 'social',
]);
const URGENCIES: ReadonlySet<string> = new Set<Urgency>(['now', 'week', 'later', 'fyi']);

export class LlmUnavailableError extends Error {}

/**
 * Runs `claude -p` with tools disabled, data on stdin.
 *
 * Tools are off deliberately, and this matters more here than the phrase
 * suggests: everything on stdin is Danish prose written by school staff and
 * other parents, none of it trusted, and the scheduled run happens at 06:30
 * with nobody watching. A model that can reach Bash from inside that prompt is
 * reading attacker-controlled instructions with `~/.aula/tokens.json` and
 * `~/.aula/.token-key` in reach. The validators in `validateExtraction` are no
 * help against it — they constrain the JSON that comes back, not what the model
 * did on the way.
 *
 * **`--allowed-tools ''` does not do this**, which is what this code used to
 * pass. That flag filters a permission allowlist; it does not remove the
 * built-in tools, and a child agent spawned with it will still happily run
 * Bash. Verified against the installed CLI with a nonce the model could only
 * produce by reading a file: `--allowed-tools ''` returned the nonce,
 * `--tools ''` returned `NO_TOOLS`. `--tools` is the flag that takes the
 * built-in set away; `--strict-mcp-config` then stops any configured MCP server
 * putting tools back, since `--tools` governs only the built-ins.
 *
 * If this ever needs changing, re-run that probe rather than reading the help
 * text — the failure is silent and looks exactly like success.
 */
export async function runClaude(
  instructions: string,
  stdin: string,
  opts: { timeoutMs?: number; model?: string; effort?: string } = {},
): Promise<string> {
  // Which model (and how hard it thinks) is the quality/speed dial for the
  // whole brief. Per-call opts win; the env vars are the user's standing choice.
  const model = opts.model ?? process.env.AULA_BRIEF_MODEL;
  const effort = opts.effort ?? process.env.AULA_BRIEF_EFFORT;
  const proc = Bun.spawn(
    [
      'claude', '-p', instructions, '--tools', '', '--strict-mcp-config',
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
    {
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? 240_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new LlmUnavailableError(`claude -p exited ${code}: ${err.trim() || '(no stderr)'}`);
    }
    return out.trim();
  } finally {
    clearTimeout(timeout);
  }
}

/** Models like to wrap JSON in prose or a fence however firmly told not to. */
export function parseJsonLoosely(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost {...} in the response.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object found in model output.');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

/** Whitespace-insensitive containment. Aula's HTML flattening leaves odd runs of spaces. */
function containsQuote(haystack: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return flat(haystack).includes(flat(needle));
}

export type ExtractResult = {
  topline: string | null;
  signals: Signal[];
  childSummaries: Record<string, string>;
  problems: string[];
};

/**
 * Checks a model response against the input it was given.
 *
 * Anything that fails is dropped and reported rather than repaired: a signal
 * whose quote cannot be found is exactly the case this is here to catch, and
 * silently keeping it with the quote removed would defeat the purpose.
 */
export function validateExtraction(input: BriefInput, parsed: unknown): ExtractResult {
  const problems: string[] = [];
  const signals: Signal[] = [];
  const byKey = new Map(input.items.map((item) => [item.key, item]));
  const firstNames = new Set(input.family.children.map((c) => c.firstName));
  const dates = buildDateSupport(input);

  const root = (parsed ?? {}) as Record<string, unknown>;
  const rawSignals = Array.isArray(root.signals) ? root.signals : [];

  for (const [index, entry] of rawSignals.entries()) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const sourceKey = typeof row.sourceKey === 'string' ? row.sourceKey : '';
    const source = byKey.get(sourceKey);
    if (!source) {
      problems.push(`signals[${index}]: ukendt sourceKey "${sourceKey}"`);
      continue;
    }

    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) {
      problems.push(`signals[${index}]: mangler title`);
      continue;
    }

    const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
    if (quote && !containsQuote(source.text, quote)) {
      problems.push(
        `signals[${index}] ("${title}"): quote findes ikke ordret i ${sourceKey}`,
      );
      continue;
    }

    const kind = typeof row.kind === 'string' && KINDS.has(row.kind) ? (row.kind as SignalKind) : 'info';
    const urgency =
      typeof row.urgency === 'string' && URGENCIES.has(row.urgency) ? (row.urgency as Urgency) : 'later';

    let dueAt: string | null = null;
    if (typeof row.dueAt === 'string' && row.dueAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueAt) || !Number.isFinite(Date.parse(row.dueAt))) {
        problems.push(`signals[${index}] ("${title}"): dueAt "${row.dueAt}" er ikke en dato`);
        continue;
      }
      if (!dueAtSupported(row.dueAt, sourceKey, dates)) {
        problems.push(
          `signals[${index}] ("${title}"): dueAt ${row.dueAt} har ingen støtte i kilderne`,
        );
        continue;
      }
      dueAt = row.dueAt;
    }

    const why = typeof row.why === 'string' && row.why.trim() ? row.why.trim() : null;
    const inventedDates = unsupportedDateClaims(`${title} ${why ?? ''}`, dates, { dueAt, sourceKey });
    if (inventedDates.length > 0) {
      problems.push(
        `signals[${index}] ("${title}"): dato uden kilde: ${inventedDates.map((d) => `"${d}"`).join(', ')}`,
      );
      continue;
    }

    const child = typeof row.child === 'string' && firstNames.has(row.child) ? row.child : null;

    signals.push({
      id: `model:${index}`,
      kind,
      title,
      child,
      dueAt,
      urgency,
      quote: quote || null,
      why,
      sourceKey,
      origin: 'model',
      concernsChild: row.concernsChild === true,
    });
  }

  const summaries: Record<string, string> = {};
  const rawSummaries = (root.childSummaries ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(rawSummaries)) {
    if (firstNames.has(name) && typeof value === 'string' && value.trim()) {
      const invented = unsupportedDateClaims(value, dates);
      if (invented.length > 0) {
        problems.push(`childSummaries.${name}: dato uden kilde: ${invented.map((d) => `"${d}"`).join(', ')}`);
        continue;
      }
      summaries[name] = value.trim();
    }
  }

  let topline = typeof root.topline === 'string' && root.topline.trim() ? root.topline.trim() : null;
  if (topline) {
    const invented = unsupportedDateClaims(topline, dates);
    if (invented.length > 0) {
      problems.push(`topline: dato uden kilde: ${invented.map((d) => `"${d}"`).join(', ')}`);
      topline = null;
    }
  }

  return {
    topline,
    signals,
    childSummaries: summaries,
    problems,
  };
}

/** The payload the model sees. Trimmed, but never summarised before it gets there. */
function extractionPayload(input: BriefInput) {
  return {
    idag: input.today,
    uge: input.isoWeek,
    born: input.family.children.map((c) => ({
      navn: c.firstName,
      fuldeNavn: c.name,
      institution: c.institution,
      klasse: c.className,
    })),
    kilder: input.items.map((item) => ({
      sourceKey: item.key,
      type: item.kind,
      titel: item.title,
      skrevet: item.at,
      afsender: item.author,
      grupper: item.groups,
      handlerOm: item.childNames,
      raekkevidde: item.audience,
      tekst: item.text.length > 4000 ? `${item.text.slice(0, 4000)}…` : item.text,
    })),
  };
}

const INSTRUCTIONS = `Du læser Aula-indhold for en dansk familie og udtrækker de ting, en travl forælder skal vide.

Input er JSON på stdin: dagens dato, børnene, og en liste af kilder med fuld tekst.

Svar KUN med JSON i præcis denne form, uden kodeblok og uden forklaring udenom:
{
  "topline": "én dansk sætning om ugens tilstand",
  "signals": [
    {
      "kind": "action|deadline|event|bring|info|social",
      "title": "kort dansk titel, bydeform hvis det er noget der skal gøres",
      "child": "barnets fornavn, eller null hvis det gælder alle/ingen bestemt",
      "dueAt": "YYYY-MM-DD eller null",
      "urgency": "now|week|later|fyi",
      "quote": "ORDRET tekststump fra kildens tekst, som belæg",
      "why": "kort: hvorfor det betyder noget for netop denne familie",
      "concernsChild": true/false,
      "sourceKey": "kildens sourceKey"
    }
  ],
  "childSummaries": { "Fornavn": "1-2 sætninger om hvad der sker for barnet" }
}

Ufravigelige regler:
- "quote" SKAL være en ordret sammenhængende tekststump fra netop den kildes "tekst". Find du ikke belæg, så udelad signalet.
- "sourceKey" SKAL være en af de kilder du fik. Opfind aldrig et.
- Opfind aldrig datoer. Står der ingen dato, sæt dueAt til null.
- Er samme sag sendt flere gange (fx samme møde i to tråde, eller samme tilbud fra to institutioner), så lav ÉT signal for den vigtigste kilde.
- "concernsChild" er det vigtigste felt du udfylder. Sæt det til true, når beskeden kræver noget af forældrene VEDRØRENDE deres eget barn — tilmelding af barnet, noget barnet skal have med, en dag barnet skal møde anderledes, en aflysning der rammer barnets dag. Sæt det til false, når det er et TILBUD, forældrene kan vælge til: kurser, forløb, netværk, temaaftener, foredrag.
- Om rækkevidde:
  - "class" og "child" er skrevet af nogen, der kender barnet. Næsten altid relevant.
  - "institution" er sendt til hele skolen eller hele huset. Her afgør concernsChild alt: skolefoto hele klassen skal med til er relevant; et forældrekursus er ikke. Vær ikke afvisende over for en institutionsbesked, bare fordi den er sendt bredt ud — spørg, om den handler om barnets skoledag.
  - "municipal" er sendt til alle forældre i kommunen. Aldrig relevant. Tag dem med som kind "info" og concernsChild false.
- Vær særligt opmærksom på ting der skal medbringes, afleveres, tilmeldes eller besvares, og på faste ugentlige aftaler der lige er indført.
- Skriv alt på dansk.`;

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
export async function extractSignals(
  input: BriefInput,
  opts: { useCache?: boolean; timeoutMs?: number; model?: string; effort?: string } = {},
): Promise<ExtractResult> {
  const payload = extractionPayload(input);
  const key = cacheKey(payload);
  const cachePath = join(CACHE_DIR, `extract-${key}.json`);

  if (opts.useCache !== false) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      return validateExtraction(input, cached);
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
  const answer = await runClaude(INSTRUCTIONS, body, {
    timeoutMs: opts.timeoutMs ?? 240_000,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });

  let parsed: unknown;
  try {
    parsed = parseJsonLoosely(answer);
  } catch {
    // The model answered, but not with JSON. The rules layer still carries the
    // brief; reporting it as a problem beats passing it off as an empty result.
    return {
      topline: null,
      signals: [],
      childSummaries: {},
      problems: ['modellens svar kunne ikke læses som JSON'],
    };
  }
  let result = validateExtraction(input, parsed);

  if (result.problems.length > 0) {
    const retry = `${INSTRUCTIONS}

Dit forrige svar havde disse fejl. Ret dem og svar igen med det fulde JSON:
${result.problems.map((p) => `- ${p}`).join('\n')}`;
    try {
      const second = await runClaude(retry, body, {
        timeoutMs: opts.timeoutMs ?? 240_000,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
      });
      const reparsed = validateExtraction(input, parseJsonLoosely(second));
      // Keep the retry only if it is genuinely better.
      if (reparsed.problems.length < result.problems.length) {
        result = reparsed;
        parsed = parseJsonLoosely(second);
      }
    } catch {
      // Keep the first result; the caller degrades gracefully.
    }
  }

  // A run told to ignore the cache must not author it either — otherwise a
  // `--no-cache` run (or a model comparison) pins its answer for whoever runs
  // next inside the content window.
  if (opts.useCache !== false) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(parsed, null, 2));
    } catch {
      // A brief that cannot cache is still a brief.
    }
  }
  return result;
}
