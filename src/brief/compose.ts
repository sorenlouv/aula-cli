/**
 * The arrangement call, and the one renderer both layouts share.
 *
 * The composer used to write the page's HTML itself, which meant generating
 * ~27 KB of markup a token at a time — half the runtime of `aula new`. Now it
 * returns a small JSON *plan* — ordering, section membership, rewording — and
 * the markup is built locally from tested parts. The model keeps the freedom
 * that matters (what leads, what waits, how it is phrased) and loses the one
 * that never did (typing out the `<div>`s). Quotes, dates, sources and links
 * are inserted by the renderer straight from validated signals, so the surface
 * on which a fact could be invented *shrinks* to the reworded text fields.
 */

import { escapeHtml } from '../html.ts';
import { buildDateSupport, DA_MONTHS, DA_WEEKDAYS, unsupportedDateClaims } from './dates.ts';
import { doneKeys } from './done.ts';
import { parseJsonLoosely, runClaude, withPreferences } from './llm.ts';
import type { RankedBrief, RankedSignal } from './types.ts';

function danishDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return `${DA_WEEKDAYS[date.getDay()]} ${date.getDate()}. ${DA_MONTHS[date.getMonth()]}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** What the composer is allowed to know: facts, already checked. */
function composePayload(brief: RankedBrief, topline: string | null, summaries: Record<string, string>, isNew: (key: string) => boolean) {
  const signal = (s: RankedSignal) => ({
    signalId: s.id,
    sourceId: s.sourceKey,
    tier: s.tier,
    kind: s.kind,
    titel: s.title,
    barn: s.child,
    dato: s.dueAt,
    datoDansk: s.dueAt ? danishDate(s.dueAt) : null,
    hastighed: s.urgency,
    citat: s.quote,
    hvorfor: s.why,
    kilde: `${s.source.kind === 'post' ? 'Opslag' : s.source.kind === 'thread' ? 'Besked' : s.source.kind === 'plan' ? 'Ugeplan' : 'Kalender'} «${s.source.title}»`,
    afsender: s.source.author,
    link: s.source.url,
    nyt: isNew(s.sourceKey),
    ogsaaFra: s.mergedSourceKeys.length,
    // The family's own weighting of the source, as the extractor read their
    // list — so the order within a section can follow it without the composer
    // re-deriving it from the prose.
    relevans: s.relevance,
  });

  const { input } = brief;
  return {
    idag: input.today,
    idagDansk: capitalise(danishDate(input.today)),
    uge: input.isoWeek,
    topline,
    born: input.family.children.map((c, i) => ({
      navn: c.firstName,
      farve: `c${i + 1}`,
      institution: c.institution,
      klasse: c.className,
      planlagtIdag: c.presence
        ? `${(c.presence.plannedEntry ?? '').slice(0, 5)}–${(c.presence.plannedExit ?? '').slice(0, 5)}`
        : null,
      status: c.presence?.statusDanish ?? null,
      resume: summaries[c.firstName] ?? null,
    })),
    kraeverHandling: brief.signals.filter((s) => s.tier === 'act').map(signal),
    kommende: brief.signals.filter((s) => s.tier === 'week').map(signal),
    baggrund: brief.signals.filter((s) => s.tier === 'context').map(signal),
    skjult: brief.signals
      .filter((s) => s.tier === 'hidden')
      .map((s) => ({ titel: s.title, kilde: s.source.title, grupper: s.source.groups })),
    ubrugteKilder: brief.unusedSources.map((item) => ({
      sourceId: item.key,
      titel: item.title,
      afsender: item.author,
      skrevet: item.at,
      raekkevidde: item.audience,
    })),
    albums: input.albums,
    datastatus: input.health,
    noter: brief.degraded,
    billeder: input.newMediaCount,
  };
}

const INSTRUCTIONS = `Du prioriterer og formulerer en dansk "Aula AI oversigt" til en travl forælder, der sjældent åbner Aula. Selve siden bygges lokalt af en fast skabelon — du bestemmer rækkefølge, sektion og ordlyd.

Input er JSON på stdin med FÆRDIGT VALIDEREDE fakta. Du må omarrangere, omformulere og prioritere — men du må ALDRIG tilføje fakta, datoer eller citater, der ikke står i inputtet. Citater, datoer, kilder, links og "Ny"-markeringer indsætter skabelonen selv.

Svar KUN med ét JSON-objekt. Ingen kodeblok. Ingen forklaring:
{
  "topline": "Én-to sætninger: dagens vigtigste konklusion først.",
  "handling": [{"signalId": "…", "titel": "kortere omskrivning (valgfri)", "hvorfor": "én konkret sætning (valgfri)"}],
  "kommende": [{"signalId": "…", "titel": "…", "hvorfor": "…"}],
  "tomHandling": "Rolig sætning til når 'handling' er tom (valgfri)"
}

Regler:
1. "handling" og "kommende" er signalId'er fra inputtets "kraeverHandling" og "kommende" — vigtigst først; din rækkefølge ER prioriteringen. "relevans" er familiens egen vægtning af kilden ("high" før "normal" før "low"), og den vejer tungere end din. Alt du udelader, vises alligevel nederst i sin sektion, så udeladelse er nedprioritering, aldrig sletning. Et punkt fra "baggrund" må promoveres, hvis det reelt beder om noget.
2. "topline": behold eller skærp den givne topline. Konklusionen først, detaljen bagefter.
3. "titel"/"hvorfor" udelades hvor inputtets formulering allerede er god; omskriv kun for at gøre det kortere, mere konkret eller imperativt.
4. Skriv alt på dansk. Hold det skimbart på 20 sekunder.`;

type ComposeResult = { html: string; problems: string[] };

type PlanEntry = { signalId: string; titel?: string; hvorfor?: string };

export type ComposePlan = {
  topline?: string;
  handling: PlanEntry[];
  kommende: PlanEntry[];
  tomHandling?: string;
};

/**
 * Reads whatever the model answered into a plan the renderer can trust:
 * unknown ids are dropped, hidden-tier ids are refused (what the family's list
 * hid is not the composer's to reopen), duplicates keep their first placement.
 */
export function parsePlan(raw: unknown, brief: RankedBrief): { plan: ComposePlan; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(brief.signals.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const dates = buildDateSupport(brief.input);

  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  // A rewording that asserts a date nothing vouches for loses only the
  // rewording — the signal's own validated text carries the card instead.
  const grounded = (value: string | undefined, where: string, signal?: RankedSignal) => {
    if (!value) return undefined;
    const invented = unsupportedDateClaims(value, dates, {
      dueAt: signal?.dueAt ?? null,
      ...(signal ? { sourceKey: signal.sourceKey } : {}),
    });
    if (invented.length === 0) return value;
    problems.push(`${where}: dato uden kilde: ${invented.map((d) => `"${d}"`).join(', ')}`);
    return undefined;
  };

  const entries = (value: unknown, field: string): PlanEntry[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`"${field}" er ikke en liste`);
      return [];
    }
    const out: PlanEntry[] = [];
    for (const item of value) {
      const id = (item as { signalId?: unknown } | null)?.signalId;
      if (typeof id !== 'string' || !byId.has(id)) {
        problems.push(`${field}: ukendt signalId ${JSON.stringify(id ?? item)}`);
        continue;
      }
      const signal = byId.get(id);
      if (signal?.tier === 'hidden') {
        problems.push(`${field}: ${id} er skjult støj og blev ikke vist`);
        continue;
      }
      if (placed.has(id)) continue;
      placed.add(id);
      const titel = grounded(text((item as { titel?: unknown }).titel), `${field} (${id}) titel`, signal);
      const hvorfor = grounded(text((item as { hvorfor?: unknown }).hvorfor), `${field} (${id}) hvorfor`, signal);
      out.push({ signalId: id, ...(titel ? { titel } : {}), ...(hvorfor ? { hvorfor } : {}) });
    }
    return out;
  };

  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const topline = grounded(text(obj.topline), 'topline');
  const tomHandling = grounded(text(obj.tomHandling), 'tomHandling');
  return {
    plan: {
      ...(topline ? { topline } : {}),
      handling: entries(obj.handling, 'handling'),
      kommende: entries(obj.kommende, 'kommende'),
      ...(tomHandling ? { tomHandling } : {}),
    },
    problems,
  };
}

/** A signal on its way onto the page, with the plan's rewording if any. */
type CardSpec = { signal: RankedSignal; titel?: string; hvorfor?: string };

type PageOptions = {
  topline?: string | null;
  summaries?: Record<string, string>;
  isNew?: (key: string) => boolean;
  note?: string;
  emptyAct?: string;
  /** Signal ids the plan already shows as cards, so details do not repeat them. */
  planned?: Set<string>;
};

/** Renders the model's plan with the same machinery the fallback uses. */
export function renderPlan(
  brief: RankedBrief,
  plan: ComposePlan,
  opts: { topline?: string | null; summaries?: Record<string, string>; isNew?: (key: string) => boolean } = {},
): string {
  const byId = new Map(brief.signals.map((s) => [s.id, s]));
  const spec = (entry: PlanEntry): CardSpec => ({
    signal: byId.get(entry.signalId) as RankedSignal,
    ...(entry.titel ? { titel: entry.titel } : {}),
    ...(entry.hvorfor ? { hvorfor: entry.hvorfor } : {}),
  });
  const planned = new Set([...plan.handling, ...plan.kommende].map((e) => e.signalId));
  // An omission in the plan is a deprioritisation, never a deletion: whatever
  // the ranker put in a visible tier still renders, after the planned cards.
  const restAct = brief.signals.filter((s) => s.tier === 'act' && !planned.has(s.id));
  const restWeek = brief.signals.filter((s) => s.tier === 'week' && !planned.has(s.id));
  return buildPage(
    brief,
    [...plan.handling.map(spec), ...restAct.map((signal) => ({ signal }))],
    [...plan.kommende.map(spec), ...restWeek.map((signal) => ({ signal }))],
    {
      topline: plan.topline ?? opts.topline ?? null,
      summaries: opts.summaries ?? {},
      ...(opts.isNew ? { isNew: opts.isNew } : {}),
      ...(plan.tomHandling ? { emptyAct: plan.tomHandling } : {}),
      planned,
    },
  );
}

export async function composePage(
  brief: RankedBrief,
  opts: {
    topline?: string | null;
    summaries?: Record<string, string>;
    isNew?: (key: string) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<ComposeResult> {
  const payload = composePayload(
    brief,
    opts.topline ?? null,
    opts.summaries ?? {},
    opts.isNew ?? (() => false),
  );
  // The extractor decides what is true; the composer decides what leads. Both
  // are places a wish can land — "billeder må gerne ligge nederst" is nothing
  // the extractor can act on and everything this call can.
  const answer = await runClaude(withPreferences(INSTRUCTIONS, brief.input.preferences), JSON.stringify(payload), {
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  const { plan, problems } = parsePlan(parseJsonLoosely(answer), brief);
  const html = renderPlan(brief, plan, {
    topline: opts.topline ?? null,
    summaries: opts.summaries ?? {},
    ...(opts.isNew ? { isNew: opts.isNew } : {}),
  });
  return { html, problems };
}

/**
 * The layout used when the composer fails twice: the same renderer, fed the
 * ranker's own order. Its job is to be *correct* — every required signal,
 * every health note, every source — on a day when the model did not answer.
 */
export function fallbackPage(
  brief: RankedBrief,
  opts: { topline?: string | null; summaries?: Record<string, string>; note?: string } = {},
): string {
  return buildPage(
    brief,
    brief.signals.filter((s) => s.tier === 'act').map((signal) => ({ signal })),
    brief.signals.filter((s) => s.tier === 'week').map((signal) => ({ signal })),
    {
      topline: opts.topline ?? null,
      summaries: opts.summaries ?? {},
      ...(opts.note ? { note: opts.note } : {}),
    },
  );
}

/** The one place page markup is written. Both layouts come through here. */
function buildPage(brief: RankedBrief, act: CardSpec[], week: CardSpec[], opts: PageOptions): string {
  const { input } = brief;
  const colour = new Map(input.family.children.map((c, i) => [c.firstName, `c${i + 1}`]));
  const card = ({ signal: s, titel, hvorfor }: CardSpec) => `
    <div class="card ${s.urgency === 'now' ? 'now' : 'soon'}" data-signal-id="${escapeHtml(s.id)}" data-source-id="${escapeHtml(s.sourceKey)}" data-done-keys="${escapeHtml(doneKeys(s).join(' '))}">
      <div class="row">
        ${s.dueAt ? `<span class="chip ${s.urgency === 'now' ? 'now' : 'soon'}">${escapeHtml(capitalise(danishDate(s.dueAt)))}</span>` : ''}
        ${opts.isNew?.(s.sourceKey) ? '<span class="chip new">Ny</span>' : ''}
        ${s.child ? `<span class="who"><span class="dot ${colour.get(s.child) ?? 'c1'}"></span>${escapeHtml(s.child)}</span>` : ''}
      </div>
      <p class="title">${escapeHtml(titel ?? s.title)}</p>
      ${hvorfor ?? s.why ? `<p class="why">${escapeHtml(hvorfor ?? s.why ?? '')}</p>` : ''}
      ${s.quote ? `<blockquote>«${escapeHtml(s.quote)}»</blockquote>` : ''}
      <div class="src">${escapeHtml(s.source.title)}${s.source.author ? ` · ${escapeHtml(s.source.author)}` : ''}${s.source.url ? ` · <a href="${escapeHtml(s.source.url)}">åbn i Aula</a>` : ''}</div>
      <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
    </div>`;

  const context = brief.signals.filter((s) => s.tier === 'context' && !opts.planned?.has(s.id));
  const hidden = brief.signals.filter((s) => s.tier === 'hidden');

  // A failed fetch must never look like a quiet week, so on a day with
  // warnings the datastatus panel sits right under the topline instead of at
  // the bottom.
  const degradedDay = input.health.some((h) => h.level === 'warn') || brief.degraded.length > 0;
  const datastatus = `<div class="panel" data-block="datastatus">
    ${input.health.map((h) => `<div class="st ${h.level === 'warn' ? 'bad' : ''}"><i>${h.level === 'warn' ? '⚠' : '○'}</i><span>${escapeHtml(h.message)}</span></div>`).join('')}
    ${brief.degraded.map((d) => `<div class="st bad"><i>⚠</i><span>${escapeHtml(d)}</span></div>`).join('')}
  </div>`;

  return `<div class="wrap">
  <header>
    <div>
      <h1>${escapeHtml(capitalise(danishDate(input.today)))}</h1>
      <div class="meta">Aula AI oversigt · uge ${escapeHtml(input.isoWeek)}${opts.note ? ` · ${escapeHtml(opts.note)}` : ''}</div>
    </div>
    <div class="kids">
      ${input.family.children
        .map(
          (c, i) =>
            `<div class="kid"><span class="dot c${i + 1}"></span><b>${escapeHtml(c.firstName)}</b><span>${escapeHtml(c.className ?? c.institution)}</span></div>`,
        )
        .join('')}
    </div>
  </header>
  <p class="topline">${escapeHtml(opts.topline ?? (act.length === 0 ? 'Intet kræver handling lige nu.' : `${act.length} ting kræver din opmærksomhed.`))}</p>

  ${degradedDay ? `<section><h2>Datastatus</h2>${datastatus}</section>` : ''}

  <section data-section="act"><h2>Kræver handling <span class="count" data-count>${act.length}</span></h2>
    ${act.map(card).join('')}
    <div class="panel" data-empty${act.length ? ' hidden' : ''}>${escapeHtml(opts.emptyAct ?? 'Intet kræver handling lige nu.')}</div>
    <button class="klaret" type="button" aria-expanded="false" data-klaret hidden></button>
  </section>

  ${week.length ? `<section data-section="week"><h2>Kommende <span class="count" data-count>${week.length}</span></h2>${week.map(card).join('')}<button class="klaret" type="button" aria-expanded="false" data-klaret hidden></button></section>` : ''}

  <section><h2>Per barn</h2><div class="grid">
    ${input.family.children
      .map(
        (c, i) => `<div class="cc"><h3><span class="dot c${i + 1}"></span>${escapeHtml(c.firstName)}</h3>
        <div class="sub">${escapeHtml([c.className, c.institution].filter(Boolean).join(' · '))}</div>
        ${opts.summaries?.[c.firstName] ? `<ul><li><i>·</i><span>${escapeHtml(opts.summaries[c.firstName] ?? '')}</span></li></ul>` : ''}
        ${c.presence ? `<div class="times">Planlagt i dag ${escapeHtml((c.presence.plannedEntry ?? '').slice(0, 5))}–${escapeHtml((c.presence.plannedExit ?? '').slice(0, 5))} · ${escapeHtml(c.presence.statusDanish)}</div>` : ''}
      </div>`,
      )
      .join('')}
  </div></section>

  ${
    input.albums.length
      ? `<section><h2>Galleri <span class="count">${input.albums.length}</span></h2><div class="chips">
      ${input.albums.map((a) => `<div class="tile"><b>${escapeHtml(a.title)}</b><span>${escapeHtml([a.at ? capitalise(danishDate(a.at)) : null, a.childNames.join(', ') || null].filter(Boolean).join(' · '))}</span></div>`).join('')}
    </div></section>`
      : ''
  }

  ${
    context.length || brief.unusedSources.length
      ? `<section><h2>Godt at vide</h2><details><summary>${context.length + brief.unusedSources.length} ting uden noget, du skal gøre</summary>
      ${context.map((s) => `<div class="di" data-source-id="${escapeHtml(s.sourceKey)}"><b>${escapeHtml(s.title)}</b>${s.quote ? `<p>«${escapeHtml(s.quote)}»</p>` : ''}</div>`).join('')}
      ${brief.unusedSources.map((i) => `<div class="di" data-source-id="${escapeHtml(i.key)}"><b>${escapeHtml(i.title)}</b><p>${escapeHtml(i.author ?? '')}</p></div>`).join('')}
    </details></section>`
      : ''
  }

  ${degradedDay ? '' : `<section><h2>Datastatus</h2>${datastatus}</section>`}

  ${hidden.length ? `<details class="muted"><summary>${hidden.length} skjult efter jeres ønsker</summary>${hidden.map((s) => `<div class="di"><b>${escapeHtml(s.title)}</b><p>${escapeHtml(s.source.author ?? s.source.groups.join(', '))}</p></div>`).join('')}</details>` : ''}

  <footer>Genereret lokalt af aula-cli · kun modelkald til Claude forlader maskinen</footer>
</div>`;
}
