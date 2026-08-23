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
import { isRecord } from '../validation.ts';
import { buildDateSupport, DA_MONTHS, DA_WEEKDAYS, unsupportedDateClaims } from './dates.ts';
import { doneKeys } from './done.ts';
import { parseJsonLoosely, runClaude, withPreferences } from './llm.ts';
import type {
  ConversationMessage,
  RankedBrief,
  RankedSignal,
  SourceItem,
  SourceKind,
} from './types.ts';

function danishDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return `${DA_WEEKDAYS[date.getDay()]} ${date.getDate()}. ${DA_MONTHS[date.getMonth()]}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "12. aug · 14:32" — short enough to sit beside a sender's name. */
function messageWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getDate()}. ${DA_MONTHS[date.getMonth()]?.slice(0, 3) ?? ''} · ${time}`;
}

const flatten = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Source prose as paragraphs.
 *
 * `htmlToText` has already turned Aula's markup into blank-line-separated
 * blocks, so the shape is there to be honoured; a message pasted in as one wall
 * of text is exactly what makes the original hard to read in the first place.
 * Escaped, then broken — never the other way round.
 */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function messageBlock(message: ConversationMessage): string {
  const when = message.at ? messageWhen(message.at) : null;
  return `<div class="msg"><div class="msg-head"><b>${escapeHtml(message.from ?? 'Ukendt afsender')}</b>${
    when ? `<span>${escapeHtml(when)}</span>` : ''
  }</div>${paragraphs(message.text)}</div>`;
}

/**
 * The collapsible original, or nothing when there is nothing left to open.
 *
 * The brief is a summary, and a summary is only trustworthy if the thing it
 * summarises is one tap away — "why does it say that?" should never require
 * opening Aula. So every entry carries its source underneath it, collapsed,
 * because on most days most of them are not needed.
 *
 * `shown` is what the entry already puts on screen. A source whose whole text
 * is the sentence already quoted above gets no toggle at all: a more-block that
 * reveals what the reader just read is the kind of small lie that teaches them
 * to stop pressing things.
 */
function moreBlock(source: SourceItem, shown: string): string {
  const conversation = source.conversation;
  const messages = conversation?.messages ?? [];
  const body = flatten(messages.length ? messages.map((m) => m.text).join(' ') : source.text);
  if (!body || flatten(shown).includes(body)) return '';

  if (messages.length > 0) {
    const label =
      messages.length === 1
        ? 'Læs hele beskeden'
        : conversation?.truncated
          ? `Læs samtalen · ${messages.length} af ${conversation.total} beskeder`
          : `Læs hele samtalen · ${messages.length} beskeder`;
    // Said plainly rather than left to be inferred from a count: a partial
    // exchange presented as the whole one is the same failure as a quiet empty
    // week standing in for a failed fetch.
    //
    // Worded as "not all of them" rather than "the older ones", because both
    // ways of losing a message land here — `getThread` pages, and a message
    // whose body is empty (an attachment with no text) is dropped in
    // `collect.ts`. Naming the wrong cause would be its own small lie.
    const note = conversation?.truncated
      ? '<p class="msg-note">Ikke alle beskeder i tråden vises her — hele tråden står i Aula.</p>'
      : '';
    return `<details class="more"><summary>${escapeHtml(label)}</summary><div class="body">${messages
      .map(messageBlock)
      .join('')}${note}</div></details>`;
  }

  return `<details class="more"><summary>Læs mere</summary><div class="body">${paragraphs(source.text)}</div></details>`;
}

/**
 * What each kind of source is called on the page.
 *
 * `Egen kalender` earns its own label rather than falling in with `Kalender`:
 * the reader has to be able to tell "the school put this in Aula" from "we put
 * this in our own calendar" at a glance, and a private appointment mislabelled
 * as a school event is a small lie the rest of the page would then inherit.
 */
const SOURCE_LABEL: Record<SourceKind, string> = {
  post: 'Opslag',
  thread: 'Besked',
  plan: 'Ugeplan',
  event: 'Kalender',
  album: 'Album',
  personal: 'Egen kalender',
};

/** What the composer is allowed to know: facts, already checked. */
function composePayload(
  brief: RankedBrief,
  topline: string | null,
  summaries: Record<string, string>,
  isNew: (key: string) => boolean,
) {
  const signal = (s: RankedSignal) => ({
    signalId: s.id,
    sourceId: s.sourceKey,
    tier: s.tier,
    kind: s.kind,
    title: s.title,
    child: s.child,
    dueAt: s.dueAt,
    // Pre-rendered so the model never has to format a date itself, which is
    // one of the few ways it can still invent one.
    dueAtDanish: s.dueAt ? danishDate(s.dueAt) : null,
    urgency: s.urgency,
    quote: s.quote,
    why: s.why,
    source: `${SOURCE_LABEL[s.source.kind]} «${s.source.title}»`,
    author: s.source.author,
    link: s.source.url,
    isNew: isNew(s.sourceKey),
    alsoFrom: s.mergedSourceKeys.length,
    // The family's own weighting of the source, as the extractor read their
    // list — so the order within a section can follow it without the composer
    // re-deriving it from the prose.
    relevance: s.relevance,
  });

  const { input } = brief;
  return {
    today: input.today,
    todayDanish: capitalise(danishDate(input.today)),
    isoWeek: input.isoWeek,
    topline,
    children: input.family.children.map((c, i) => ({
      firstName: c.firstName,
      colour: `c${i + 1}`,
      institution: c.institution,
      className: c.className,
      plannedToday: c.presence
        ? `${(c.presence.plannedEntry ?? '').slice(0, 5)}–${(c.presence.plannedExit ?? '').slice(0, 5)}`
        : null,
      status: c.presence?.statusDanish ?? null,
      summary: summaries[c.firstName] ?? null,
    })),
    // Keyed by the same words as `Tier`, so a section in the payload and the
    // tier it came from are visibly the same concept.
    act: brief.signals.filter((s) => s.tier === 'act').map(signal),
    week: brief.signals.filter((s) => s.tier === 'week').map(signal),
    context: brief.signals.filter((s) => s.tier === 'context').map(signal),
    hidden: brief.signals
      .filter((s) => s.tier === 'hidden')
      .map((s) => ({ title: s.title, source: s.source.title, groups: s.source.groups })),
    unusedSources: brief.unusedSources.map((item) => ({
      sourceId: item.key,
      title: item.title,
      author: item.author,
      writtenAt: item.at,
      audience: item.audience,
    })),
    albums: input.albums,
    dataStatus: input.health,
    notes: brief.degraded,
    newMediaCount: input.newMediaCount,
  };
}

const INSTRUCTIONS = `Du prioriterer og formulerer en dansk "Aula AI oversigt" til en travl forælder, der sjældent åbner Aula. Selve siden bygges lokalt af en fast skabelon — du bestemmer rækkefølge, sektion og ordlyd.

Input er JSON på stdin med FÆRDIGT VALIDEREDE fakta. Du må omarrangere, omformulere og prioritere — men du må ALDRIG tilføje fakta, datoer eller citater, der ikke står i inputtet. Citater, datoer, kilder, links og "Ny"-markeringer indsætter skabelonen selv.

Svar KUN med ét JSON-objekt. Ingen kodeblok. Ingen forklaring:
{
  "topline": "Én-to sætninger: dagens vigtigste konklusion først.",
  "act": [{"signalId": "…", "title": "kortere omskrivning (valgfri)", "why": "én konkret sætning (valgfri)"}],
  "week": [{"signalId": "…", "title": "…", "why": "…"}],
  "emptyAct": "Rolig sætning til når 'act' er tom (valgfri)"
}

Feltnavnene er engelske; alt indhold du skriver, er dansk.

Regler:
1. "act" og "week" er signalId'er fra inputtets "act" og "week" — vigtigst først; din rækkefølge ER prioriteringen. "relevance" er familiens egen vægtning af kilden ("high" før "normal" før "low"), og den vejer tungere end din. Alt du udelader, vises alligevel nederst i sin sektion, så udeladelse er nedprioritering, aldrig sletning. Et punkt fra "context" må promoveres, hvis det reelt beder om noget.
2. "topline": behold eller skærp den givne topline. Konklusionen først, detaljen bagefter.
3. "title"/"why" udelades hvor inputtets formulering allerede er god; omskriv kun for at gøre det kortere, mere konkret eller imperativt.
4. En kilde mærket "Egen kalender" er kun en aftale, der skal vises ved siden af skolens egne ting. Sæt den aldrig i "act", og skriv ingen ny "title" eller "why" til den. Beregn ikke sammenstød mellem aftaler og skoledagen, og skriv aldrig, at der ikke er sammenstød.
5. Skriv alt på dansk. Hold det skimbart på 20 sekunder.`;

type ComposeResult = { html: string; problems: string[] };

type PlanEntry = { signalId: string; title?: string; why?: string };

export type ComposePlan = {
  topline?: string;
  act: PlanEntry[];
  week: PlanEntry[];
  emptyAct?: string;
};

/**
 * Reads whatever the model answered into a plan the renderer can trust:
 * unknown ids are dropped, hidden-tier ids are refused (what the family's list
 * hid is not the composer's to reopen), duplicates keep their first placement.
 */
export function parsePlan(
  raw: unknown,
  brief: RankedBrief,
): { plan: ComposePlan; problems: string[] } {
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
      const row = isRecord(item) ? item : {};
      const id = row.signalId;
      if (typeof id !== 'string' || !byId.has(id)) {
        problems.push(`${field}: ukendt signalId ${JSON.stringify(id ?? item)}`);
        continue;
      }
      const signal = byId.get(id);
      if (signal?.tier === 'hidden') {
        problems.push(`${field}: ${id} er skjult støj og blev ikke vist`);
        continue;
      }
      if (field === 'act' && signal?.source.kind === 'personal') {
        problems.push(`${field}: kalenderaftalen ${id} kan ikke blive til en handling`);
        continue;
      }
      if (placed.has(id)) continue;
      placed.add(id);
      const proposedTitle = text(row.title);
      const proposedWhy = text(row.why);
      if (signal?.source.kind === 'personal' && (proposedTitle || proposedWhy)) {
        problems.push(`${field}: kalenderaftalen ${id} vises ordret og blev ikke fortolket`);
      }
      const title =
        signal?.source.kind === 'personal'
          ? undefined
          : grounded(proposedTitle, `${field} (${id}) title`, signal);
      const why =
        signal?.source.kind === 'personal'
          ? undefined
          : grounded(proposedWhy, `${field} (${id}) why`, signal);
      out.push({ signalId: id, ...(title ? { title } : {}), ...(why ? { why } : {}) });
    }
    return out;
  };

  const obj = isRecord(raw) ? raw : {};
  const topline = grounded(text(obj.topline), 'topline');
  const emptyAct = grounded(text(obj.emptyAct), 'emptyAct');
  return {
    plan: {
      ...(topline ? { topline } : {}),
      act: entries(obj.act, 'act'),
      week: entries(obj.week, 'week'),
      ...(emptyAct ? { emptyAct } : {}),
    },
    problems,
  };
}

/** A signal on its way onto the page, with the plan's rewording if any. */
type CardSpec = { signal: RankedSignal; title?: string; why?: string };

type PageOptions = {
  topline?: string | null;
  summaries?: Record<string, string>;
  isNew?: (key: string) => boolean;
  note?: string;
  emptyAct?: string;
  /** Signal ids the plan already shows as cards, so details do not repeat them. */
  planned?: Set<string>;
  /** Thread summaries from the extraction, keyed by `sourceKey`. */
  conversations?: Record<string, string>;
};

/** Renders the model's plan with the same machinery the fallback uses. */
export function renderPlan(
  brief: RankedBrief,
  plan: ComposePlan,
  opts: {
    topline?: string | null;
    summaries?: Record<string, string>;
    conversations?: Record<string, string>;
    isNew?: (key: string) => boolean;
  } = {},
): string {
  const byId = new Map(brief.signals.map((s) => [s.id, s]));
  const spec = (entry: PlanEntry): CardSpec => {
    const signal = byId.get(entry.signalId);
    if (!signal) throw new Error(`Plan references unknown signal ${entry.signalId}`);
    return {
      signal,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.why ? { why: entry.why } : {}),
    };
  };
  const planned = new Set([...plan.act, ...plan.week].map((e) => e.signalId));
  // An omission in the plan is a deprioritisation, never a deletion: whatever
  // the ranker put in a visible tier still renders, after the planned cards.
  const restAct = brief.signals.filter((s) => s.tier === 'act' && !planned.has(s.id));
  const restWeek = brief.signals.filter((s) => s.tier === 'week' && !planned.has(s.id));
  return buildPage(
    brief,
    [...plan.act.map(spec), ...restAct.map((signal) => ({ signal }))],
    [...plan.week.map(spec), ...restWeek.map((signal) => ({ signal }))],
    {
      topline: plan.topline ?? opts.topline ?? null,
      summaries: opts.summaries ?? {},
      conversations: opts.conversations ?? {},
      ...(opts.isNew ? { isNew: opts.isNew } : {}),
      ...(plan.emptyAct ? { emptyAct: plan.emptyAct } : {}),
      planned,
    },
  );
}

export async function composePage(
  brief: RankedBrief,
  opts: {
    topline?: string | null;
    summaries?: Record<string, string>;
    conversations?: Record<string, string>;
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
  const answer = await runClaude(
    withPreferences(INSTRUCTIONS, brief.input.preferences),
    JSON.stringify(payload),
    {
      timeoutMs: opts.timeoutMs ?? 300_000,
    },
  );
  const { plan, problems } = parsePlan(parseJsonLoosely(answer), brief);
  const html = renderPlan(brief, plan, {
    topline: opts.topline ?? null,
    summaries: opts.summaries ?? {},
    conversations: opts.conversations ?? {},
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
  opts: {
    topline?: string | null;
    summaries?: Record<string, string>;
    conversations?: Record<string, string>;
    note?: string;
  } = {},
): string {
  return buildPage(
    brief,
    brief.signals.filter((s) => s.tier === 'act').map((signal) => ({ signal })),
    brief.signals.filter((s) => s.tier === 'week').map((signal) => ({ signal })),
    {
      topline: opts.topline ?? null,
      summaries: opts.summaries ?? {},
      conversations: opts.conversations ?? {},
      ...(opts.note ? { note: opts.note } : {}),
    },
  );
}

/** The one place page markup is written. Both layouts come through here. */
function buildPage(
  brief: RankedBrief,
  act: CardSpec[],
  week: CardSpec[],
  opts: PageOptions,
): string {
  const { input } = brief;
  const colour = new Map(input.family.children.map((c, i) => [c.firstName, `c${i + 1}`]));
  const card = ({ signal: s, title, why: reworded }: CardSpec) => {
    const why = reworded ?? s.why;
    // What a six-message exchange is *about*, so the card is not a single quote
    // the reader has to reconstruct a conversation from. Only threads long
    // enough to need one have it — see `CONVERSATION_MIN_MESSAGES`.
    const gist = opts.conversations?.[s.sourceKey];
    return `
    <div class="card ${s.urgency === 'now' ? 'now' : 'soon'}" data-signal-id="${escapeHtml(s.id)}" data-source-id="${escapeHtml(s.sourceKey)}" data-done-keys="${escapeHtml(doneKeys(s).join(' '))}">
      <div class="row">
        ${s.dueAt ? `<span class="chip ${s.urgency === 'now' ? 'now' : 'soon'}">${escapeHtml(capitalise(danishDate(s.dueAt)))}</span>` : ''}
        ${opts.isNew?.(s.sourceKey) ? '<span class="chip new">Ny</span>' : ''}
        ${s.child ? `<span class="who"><span class="dot ${colour.get(s.child) ?? 'c1'}"></span>${escapeHtml(s.child)}</span>` : ''}
      </div>
      <p class="title">${escapeHtml(title ?? s.title)}</p>
      ${why ? `<p class="why">${escapeHtml(why)}</p>` : ''}
      ${s.quote ? `<blockquote>«${escapeHtml(s.quote)}»</blockquote>` : ''}
      ${gist ? `<p class="gist">${escapeHtml(gist)}</p>` : ''}
      ${moreBlock(s.source, [title ?? s.title, why, s.quote, gist].filter(Boolean).join(' '))}
      <div class="src">${escapeHtml(s.source.title)}${s.source.author ? ` · ${escapeHtml(s.source.author)}` : ''}${s.source.url ? ` · <a href="${escapeHtml(s.source.url)}">${s.source.kind === 'personal' ? 'åbn i kalender' : 'åbn i Aula'}</a>` : ''}</div>
      <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
    </div>`;
  };

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
    <button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button>
  </section>

  ${week.length ? `<section data-section="week"><h2>Kommende <span class="count" data-count>${week.length}</span></h2>${week.map(card).join('')}<button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button></section>` : ''}

  <section><h2>Per barn</h2><div class="grid">
    ${input.family.children
      .map(
        (
          c,
          i,
        ) => `<div class="cc"><h3><span class="dot c${i + 1}"></span>${escapeHtml(c.firstName)}</h3>
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
      ${context
        .map((s) => {
          const gist = opts.conversations?.[s.sourceKey];
          return `<div class="di" data-source-id="${escapeHtml(s.sourceKey)}"><b>${escapeHtml(s.title)}</b>${s.quote ? `<p>«${escapeHtml(s.quote)}»</p>` : ''}${gist ? `<p class="gist">${escapeHtml(gist)}</p>` : ''}${moreBlock(s.source, [s.title, s.quote, gist].filter(Boolean).join(' '))}</div>`;
        })
        .join('')}
      ${brief.unusedSources
        .map((i) => {
          const gist = opts.conversations?.[i.key];
          return `<div class="di" data-source-id="${escapeHtml(i.key)}"><b>${escapeHtml(i.title)}</b><p>${escapeHtml(i.author ?? '')}</p>${gist ? `<p class="gist">${escapeHtml(gist)}</p>` : ''}${moreBlock(i, [i.title, gist].filter(Boolean).join(' '))}</div>`;
        })
        .join('')}
    </details></section>`
      : ''
  }

  ${degradedDay ? '' : `<section><h2>Datastatus</h2>${datastatus}</section>`}

  ${hidden.length ? `<details class="muted"><summary>${hidden.length} skjult efter jeres ønsker</summary>${hidden.map((s) => `<div class="di"><b>${escapeHtml(s.title)}</b><p>${escapeHtml(s.source.author ?? s.source.groups.join(', '))}</p></div>`).join('')}</details>` : ''}

  <footer>Genereret lokalt af aula-cli · kun modelkald til Claude forlader maskinen</footer>
</div>`;
}
