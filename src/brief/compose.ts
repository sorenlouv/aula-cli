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
import { localIsoDate } from '../integrations/types.ts';
import { isRecord } from '../validation.ts';
import {
  buildDateSupport,
  DA_MONTHS,
  DA_WEEKDAYS,
  intervalLabel,
  shortDayMonth,
  unsupportedDateClaims,
} from './dates.ts';
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

/**
 * "13. august", with the year only when it is not the year being read.
 *
 * The weekday is dropped on purpose: it earns its place on a chip naming a day
 * to act on, and is noise on an attribution line that is already dense.
 */
function dayMonth(iso: string, today: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const stamp = `${date.getDate()}. ${DA_MONTHS[date.getMonth()]}`;
  return String(year) === today.slice(0, 4) ? stamp : `${stamp} ${year}`;
}

/**
 * When the source is from — the fact that tells a reader whether to trust a
 * summary of it.
 *
 * A card can carry two dates and they mean opposite things: the chip is the day
 * something happens, this is the day somebody wrote it. So each kind says what
 * its own timestamp *is* rather than printing a bare date beside the other one:
 * a post was written, a thread's timestamp is its newest message, a weekly-plan
 * entry is not written at all but is *for* a day.
 *
 * Without it a quote can be read as current when it is not. The overnatning
 * post is the case that prompted this — a card quoting "vi talte om
 * overnatningen" reads as news until you know the thing was announced in July.
 *
 * `event` and `personal` get none: their timestamp is the entry itself, already
 * on the chip or in the row, and repeating it as attribution would say the
 * appointment was written on the day it happens.
 */
function sourceDateline(source: SourceItem, today: string): string | null {
  if (!source.at || source.kind === 'event' || source.kind === 'personal') return null;
  const day = dayMonth(source.at, today);
  if (!day) return null;
  if (source.kind === 'thread') {
    return (source.conversation?.messages.length ?? 0) > 1
      ? `seneste besked ${day}`
      : `skrevet ${day}`;
  }
  if (source.kind === 'plan') return `ugeplan for ${day}`;
  return `skrevet ${day}`;
}

/** "12. aug · 14:32" — short enough to sit beside a sender's name. */
function messageWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getDate()}. ${DA_MONTHS[date.getMonth()]?.slice(0, 3) ?? ''} · ${time}`;
}

const flatten = (value: string) => value.replace(/\s+/g, ' ').trim();

/** One of the family's own appointments, as opposed to anything from Aula. */
const isPersonal = (signal: RankedSignal) => signal.source.kind === 'personal';

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
function moreBlock(source: SourceItem, shown: string, today: string): string {
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

  // The same head a thread's messages carry, for a source that has no messages:
  // opening the original is exactly when "and when was this?" gets asked, and a
  // wall of prose with no date on it is what sent the reader to Aula to check.
  const dateline = sourceDateline(source, today);
  const head =
    source.author || dateline
      ? `<div class="msg-head">${source.author ? `<b>${escapeHtml(source.author)}</b>` : ''}${
          dateline ? `<span>${escapeHtml(dateline)}</span>` : ''
        }</div>`
      : '';
  return `<details class="more"><summary>Læs mere</summary><div class="body">${head}${paragraphs(source.text)}</div></details>`;
}

/**
 * What each kind of source is called in the composer's payload.
 *
 * `personal` is here for the type's completeness only: the family's own
 * appointments never reach the composer (see `composePayload`), and on the page
 * they have a section of their own, labelled *Egen kalender* in the heading
 * rather than per entry.
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
    //
    // The family's own appointments are left out altogether. They are not the
    // composer's to order or reword: the page folds them into one collapsed
    // list of their own (see `calendarSection`), so there is nothing for a
    // plan to decide about them — and a composer that cannot see them cannot
    // write a clash, or the absence of one, into a neighbouring card's "why".
    act: brief.signals.filter((s) => s.tier === 'act' && !isPersonal(s)).map(signal),
    week: brief.signals.filter((s) => s.tier === 'week' && !isPersonal(s)).map(signal),
    context: brief.signals.filter((s) => s.tier === 'context' && !isPersonal(s)).map(signal),
    hidden: brief.signals
      .filter((s) => s.tier === 'hidden' && !isPersonal(s))
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

/**
 * The plan's shape, built per run so it can name *this* run's signals.
 *
 * `signalId` is an enum of the ids the composer is actually allowed to place —
 * everything the payload showed it, which is every tier except `hidden` and
 * every source except the family's own calendar. Both exclusions were prose
 * rules with a refusal in `parsePlan` behind them, and both become unstateable
 * here: what the family asked to put away cannot be reopened, and an
 * appointment cannot be promoted into a task, because neither id exists to be
 * named. `parsePlan` keeps the refusals anyway — they are the guard for the
 * path where the flag is absent, and they cost nothing when they never fire.
 *
 * Optional fields are nullable-and-required rather than absent: a strict schema
 * is clearest when every key is present, and `text()` already reads null as
 * "not given". `topline` and `emptyAct` are optional in the same way.
 */
export function composeSchema(brief: RankedBrief) {
  const placeable = brief.signals
    .filter((s) => s.tier !== 'hidden' && !isPersonal(s))
    .map((s) => s.id);
  const entry = {
    type: 'object',
    properties: {
      signalId: placeable.length > 0 ? { enum: placeable } : { type: 'string' },
      title: {
        type: ['string', 'null'],
        description:
          'Omskrivning af punktets titel — kun for at gøre den kortere, mere konkret eller bydende. Null hvor inputtets formulering allerede er god.',
      },
      why: {
        type: ['string', 'null'],
        description:
          'Én konkret sætning om, hvorfor punktet betyder noget for familien. Null hvor inputtets "why" holder, eller titlen siger det hele.',
      },
    },
    required: ['signalId', 'title', 'why'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      topline: {
        type: ['string', 'null'],
        description:
          'Én-to sætninger: dagens vigtigste konklusion først, detaljen bagefter. Behold eller skærp den topline, du har fået; null for at beholde den som den er.',
      },
      act: {
        type: 'array',
        items: entry,
        description: 'Sektionen "Kræver handling", vigtigst først — rækkefølgen ER prioriteringen.',
      },
      week: {
        type: 'array',
        items: entry,
        description:
          'Sektionen "Kommende". Skabelonen viser den i datorækkefølge, så her bestemmer du ordlyden og kun rækkefølgen mellem punkter på samme dag.',
      },
      emptyAct: {
        type: ['string', 'null'],
        description:
          'Den rolige sætning, der vises, når intet kræver handling. Null for standarden.',
      },
    },
    required: ['topline', 'act', 'week', 'emptyAct'],
    additionalProperties: false,
  };
}

const INSTRUCTIONS = `Du prioriterer og formulerer en dansk "Aula AI oversigt" til en travl forælder, der sjældent åbner Aula. Selve siden bygges lokalt af en fast skabelon — du bestemmer rækkefølge og ordlyd. Svarets felter er beskrevet i skemaet; alt indhold du skriver, er dansk.

Input er JSON med færdigt validerede fakta. Du må omarrangere, omformulere og prioritere. Tilføj ikke fakta, datoer eller citater, der ikke står i inputtet — citater, datoer, kilder, links og "Ny"-markeringer indsætter skabelonen selv, og en dato i din tekst, som ingen kilde dækker, bliver fjernet igen.

Tre ting, som går på tværs af felterne:
- "relevance" er familiens egen vægtning af en kilde ("high" før "normal" før "low"), og den vejer tungere end din.
- Alt du udelader, vises alligevel — i "act" nederst i sektionen, i "week" på sin dato med inputtets egen ordlyd. Udeladelse er nedprioritering, aldrig sletning.
- Et punkt fra "context" må placeres i "act" eller "week", hvis det reelt beder om noget.

Hold det skimbart på 20 sekunder.`;

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
      // This and the appointment refusal below are now the schema's job too —
      // neither id is in the enum the model answers with (see `composeSchema`).
      // They stay because the schema is a flag on one call, and a renderer that
      // reopened what the family hid would be a silent failure, not a loud one.
      if (signal?.tier === 'hidden') {
        problems.push(`${field}: ${id} er skjult støj og blev ikke vist`);
        continue;
      }
      // The composer never sees the family's appointments (`composePayload`),
      // so an id naming one is a guess or a stale answer. The page places them
      // itself, verbatim, in the calendar fold — whatever the plan says.
      if (signal && isPersonal(signal)) {
        problems.push(`${field}: kalenderaftalen ${id} er ikke komponistens at placere`);
        continue;
      }
      if (placed.has(id)) continue;
      placed.add(id);
      const title = grounded(text(row.title), `${field} (${id}) title`, signal);
      const why = grounded(text(row.why), `${field} (${id}) why`, signal);
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
  // the ranker put in a visible tier still renders — after the planned cards
  // in Kræver handling, on its own date in Kommende, which `buildPage` orders.
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
      schema: composeSchema(brief),
    },
  );
  // Schema-checked by the CLI on the ordinary path; the loose parse is what
  // remains for an envelope that arrives without `structured_output`.
  const { plan, problems } = parsePlan(answer.structured ?? parseJsonLoosely(answer.text), brief);
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

/** "kl. 10:00–11:00" or "hele dagen", from the source's own fields. */
function whenLabel(source: SourceItem): string {
  const start = source.at ?? '';
  const end = source.endsAt ?? '';
  const startDay = start.slice(0, 10);
  return intervalLabel({
    startDay,
    endDay: end.slice(0, 10) || startDay,
    startTime: start.slice(11, 16) || null,
    endTime: end.slice(11, 16) || null,
    allDay: source.allDay ?? false,
  });
}

function daysFrom(today: string, isoDay: string): number {
  return Math.round(
    (Date.parse(`${isoDay}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000,
  );
}

/** "i dag", "i morgen", otherwise "onsdag 26/8" — short enough to sit in a summary line. */
function summaryDayLabel(isoDay: string, today: string): string {
  const offset = daysFrom(today, isoDay);
  if (offset === 0) return 'i dag';
  if (offset === 1) return 'i morgen';
  const date = new Date(`${isoDay}T00:00:00`);
  return `${DA_WEEKDAYS[date.getDay()]} ${shortDayMonth(isoDay)}`;
}

/**
 * How many days from today the calendar fold's summary always names —
 * today only. Anything further out is named only when it shares a day with
 * something the school asked for. Raising this to 2 names tomorrow as well.
 */
const CALENDAR_SUMMARY_DAYS = 1;

/**
 * The family's own appointments: one collapsed section, rows inside.
 *
 * An appointment is one line — title, time, which calendar — and the card
 * shape (quote, why, a *Læs mere* that could only repeat the line above it)
 * was six lines of chrome around it. Twenty of those was most of the page.
 * Rows grouped by day, folded shut by default, is the shape that matches the
 * information: the family already has a calendar app, and what this page adds
 * is the school's week beside it, not a second copy of it.
 *
 * The summary is what makes the fold useful *closed*. It names today's
 * appointments, and those on any day that also carries an Aula card in Kræver
 * handling or Kommende — so "Viggo gymnastik 17:10" appears beside the
 * Wednesday the forældremøde is on, without the page computing a clash or
 * claiming the absence of one. `anchoredDays` is that set of days. The reader
 * draws the conclusion, and knows what the arithmetic never could: how far the
 * dentist is, and whether a grandparent can fetch.
 *
 * Rows carry the same `data-*` as a card, so `validate.ts` holds them to the
 * same invariants and `done.ts` lets them be ticked off.
 */
function calendarSection(
  rows: RankedSignal[],
  anchoredDays: ReadonlySet<string>,
  today: string,
  isNew: ((key: string) => boolean) | undefined,
): string {
  if (rows.length === 0) return '';
  const dayOf = (s: RankedSignal) => s.dueAt ?? (s.source.at ?? '').slice(0, 10);
  const sorted = [...rows].sort(
    (a, b) =>
      (a.source.at ?? '').localeCompare(b.source.at ?? '') || a.title.localeCompare(b.title),
  );

  const byDay = new Map<string, RankedSignal[]>();
  for (const s of sorted) {
    const day = dayOf(s);
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }

  // The days the summary names: the first CALENDAR_SUMMARY_DAYS from today,
  // plus every day the school's own cards land on.
  const named = new Set<string>(anchoredDays);
  for (let offset = 0; offset < CALENDAR_SUMMARY_DAYS; offset++) {
    const day = new Date(`${today}T00:00:00`);
    day.setDate(day.getDate() + offset);
    named.add(localIsoDate(day));
  }
  const clauses = [...named]
    .sort()
    .filter((day) => byDay.has(day))
    .map((day) => {
      const items = (byDay.get(day) ?? []).map((s) => {
        const start = s.source.allDay ? '' : (s.source.at ?? '').slice(11, 16);
        return start ? `${s.title} ${start}` : s.title;
      });
      return `${summaryDayLabel(day, today)}: ${items.join(', ')}`;
    });
  const summary = clauses.length ? capitalise(clauses.join(' · ')) : 'Alle aftaler i perioden';

  const row = (s: RankedSignal) => `
      <div class="cal-row" data-signal-id="${escapeHtml(s.id)}" data-source-id="${escapeHtml(s.sourceKey)}" data-done-keys="${escapeHtml(doneKeys(s).join(' '))}">
        <span class="cal-when">${escapeHtml(whenLabel(s.source))}</span>
        <span class="cal-title">${escapeHtml(s.title)}</span>
        ${isNew?.(s.sourceKey) ? '<span class="chip new">Ny</span>' : ''}
        <span class="cal-src">${escapeHtml(s.source.author ?? '')}${s.source.url ? ` · <a href="${escapeHtml(s.source.url)}">åbn i kalender</a>` : ''}</span>
        <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
      </div>`;

  const body = [...byDay.entries()]
    .map(
      ([day, items]) =>
        `<div class="cal-day">${escapeHtml(capitalise(danishDate(day)))}</div>${items.map(row).join('')}`,
    )
    .join('');

  return `<section data-section="calendar"><h2>Egen kalender <span class="count" data-count>${rows.length}</span></h2>
    <details class="cal"><summary>${escapeHtml(summary)}</summary><div class="cal-body">${body}</div></details>
    <button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button>
  </section>`;
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
      ${moreBlock(s.source, [title ?? s.title, why, s.quote, gist].filter(Boolean).join(' '), input.today)}
      <div class="src">${escapeHtml([s.source.title, sourceDateline(s.source, input.today), s.source.author].filter(Boolean).join(' · '))}${s.source.url ? ` · <a href="${escapeHtml(s.source.url)}">åbn i Aula</a>` : ''}</div>
      <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
    </div>`;
  };

  // Kommende is the school's dated things, in date order. The plan's order
  // survives only within a day — a list called "upcoming" that the reader
  // cannot scan by date is not answering the question its heading asks. The
  // family's own appointments go to their fold instead. Two tails, each under
  // its own divider so it is visible why those cards differ: undated items
  // (mostly Kræver handling overflow), and then the past-dated — a card the
  // `important` or `high` floor kept on the page after its day went by.
  // Honest either way: the date stays on the chip, and the list the reader
  // scans for what is next is not led by what is over.
  // Every appointment the family has not asked to hide, whatever tier it landed
  // in. A `low` verdict on an appointment used to send it to the `context`
  // tier, which put the reader's own dentist visit inside "Godt at vide"
  // between two school posts — the scattering this fold exists to end. The
  // tiers rank *Aula* content by prominence; for an appointment the fold is
  // already the low-prominence home, so `week` and `context` belong in the same
  // list. `hidden` still is: that is the family saying no, not "less".
  const calendar = brief.signals.filter((s) => isPersonal(s) && s.tier !== 'hidden');
  const upcoming = week
    .filter((c) => !isPersonal(c.signal))
    .sort((a, b) => (a.signal.dueAt ?? '9999-99-99').localeCompare(b.signal.dueAt ?? '9999-99-99'));
  const dated = upcoming.filter((c) => c.signal.dueAt && c.signal.dueAt >= input.today);
  const undated = upcoming.filter((c) => !c.signal.dueAt);
  const past = upcoming.filter((c) => c.signal.dueAt && c.signal.dueAt < input.today);
  const anchoredDays = new Set(
    [...act, ...dated].map((c) => c.signal.dueAt).filter((d): d is string => Boolean(d)),
  );
  // A divider separates; it does not head a section that is all one kind.
  const kommende = [
    { label: null, cards: dated },
    { label: 'Uden fast dato', cards: undated },
    { label: 'Tidligere', cards: past },
  ]
    .filter((group) => group.cards.length > 0)
    .map((group, index) =>
      [
        index > 0 && group.label ? `<div class="divider">${group.label}</div>` : '',
        ...group.cards.map(card),
      ].join(''),
    )
    .join('');

  const context = brief.signals.filter(
    (s) => s.tier === 'context' && !isPersonal(s) && !opts.planned?.has(s.id),
  );
  const hidden = brief.signals.filter((s) => s.tier === 'hidden');

  // A failed fetch must never look like a quiet week, so a day where something
  // could not be *fetched* puts this panel right under the topline: the reader
  // has to know before they trust the page that a section is thin because Aula
  // refused it, not because the week is quiet.
  //
  // Only `health` warnings do that, and the distinction is the point. A
  // `degraded` note is about the overview itself — the model's answer was
  // partial, so the ranking fell back to the rules — and nothing is missing
  // from Aula because of it. Hoisting the whole panel for that put a status
  // report above the week on an ordinary morning, which is how a reader learns
  // to skip the block that matters on the morning a fetch really did fail.
  // Those notes still render, in the same panel, quietly at the foot.
  const fetchFailed = input.health.some((h) => h.level === 'warn');
  const datastatus = `<div class="panel" data-block="datastatus">
    ${input.health.map((h) => `<div class="st ${h.level === 'warn' ? 'bad' : ''}"><i>${h.level === 'warn' ? '⚠' : '○'}</i><span>${escapeHtml(h.message)}</span></div>`).join('')}
    ${brief.degraded.map((d) => `<div class="st bad"><i>⚠</i><span>${escapeHtml(d)}</span></div>`).join('')}
  </div>`;

  // Shut, it still has to say what it holds — a fold labelled only "Datastatus"
  // is a question rather than an answer. The count names the notes about the
  // overview itself, so the one case that is not simply "everything worked"
  // reads as such without being opened.
  const quibbles = brief.degraded.length;
  const datastatusSummary =
    quibbles > 0
      ? `Datastatus · alle kilder blev hentet · ${quibbles} bemærkning${quibbles === 1 ? '' : 'er'} om oversigten`
      : 'Datastatus · alle kilder blev hentet';

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

  ${fetchFailed ? `<section><h2>Datastatus</h2>${datastatus}</section>` : ''}

  <section data-section="act"><h2>Kræver handling <span class="count" data-count>${act.length}</span></h2>
    ${act.map(card).join('')}
    <div class="panel" data-empty${act.length ? ' hidden' : ''}>${escapeHtml(opts.emptyAct ?? 'Intet kræver handling lige nu.')}</div>
    <button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button>
  </section>

  ${
    upcoming.length
      ? `<section data-section="week"><h2>Kommende <span class="count" data-count>${upcoming.length}</span></h2>${kommende}<button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button></section>`
      : ''
  }

  ${calendarSection(calendar, anchoredDays, input.today, opts.isNew)}

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
          return `<div class="di" data-source-id="${escapeHtml(s.sourceKey)}"><b>${escapeHtml(s.title)}</b>${s.quote ? `<p>«${escapeHtml(s.quote)}»</p>` : ''}${gist ? `<p class="gist">${escapeHtml(gist)}</p>` : ''}${moreBlock(s.source, [s.title, s.quote, gist].filter(Boolean).join(' '), input.today)}<div class="src">${escapeHtml([sourceDateline(s.source, input.today), s.source.author].filter(Boolean).join(' · '))}</div></div>`;
        })
        .join('')}
      ${brief.unusedSources
        .map((i) => {
          const gist = opts.conversations?.[i.key];
          return `<div class="di" data-source-id="${escapeHtml(i.key)}"><b>${escapeHtml(i.title)}</b><p>${escapeHtml([sourceDateline(i, input.today), i.author].filter(Boolean).join(' · '))}</p>${gist ? `<p class="gist">${escapeHtml(gist)}</p>` : ''}${moreBlock(i, [i.title, gist].filter(Boolean).join(' '), input.today)}</div>`;
        })
        .join('')}
    </details></section>`
      : ''
  }

  ${hidden.length ? `<details class="muted"><summary>${hidden.length} skjult efter jeres ønsker</summary>${hidden.map((s) => `<div class="di"><b>${escapeHtml(s.title)}</b><p>${escapeHtml([sourceDateline(s.source, input.today), s.source.author ?? s.source.groups.join(', ')].filter(Boolean).join(' · '))}</p></div>`).join('')}</details>` : ''}

  ${fetchFailed ? '' : `<details class="muted"><summary>${escapeHtml(datastatusSummary)}</summary>${datastatus}</details>`}

  <footer>Genereret lokalt af aula-cli · kun modelkald til Claude forlader maskinen</footer>
</div>`;
}
