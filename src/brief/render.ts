/**
 * The page, built locally from the model's cards and calendar verdicts.
 *
 * The model decides what the Aula cards are and which personal appointments
 * are relevant. This file decides nothing about content. It draws full and
 * compact cards in the order `rank.ts` gave them, keeps every source one tap
 * away, and keeps the sections in the same places every morning.
 *
 * There used to be a second model call here that ordered and reworded the
 * cards. It went when the first call started writing them finished: ordering
 * is by date and needs no model, and rewording what was just written well is
 * a second chance to write it badly.
 */

import { escapeHtml } from '../html.ts';
import { DA_MONTHS, DA_WEEKDAYS, intervalLabel } from './dates.ts';
import { doneKeys } from './done.ts';
import type {
  ConversationMessage,
  RankedBrief,
  RankedCard,
  RankedPersonalEvent,
  RankedTimelineEntry,
  SourceItem,
} from './types.ts';

function danishDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return `${DA_WEEKDAYS[date.getDay()]} ${date.getDate()}. ${DA_MONTHS[date.getMonth()]}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function daysFrom(today: string, isoDay: string): number {
  return Math.round(
    (Date.parse(`${isoDay}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000,
  );
}

/** The chip on a card: "I dag", "I morgen", otherwise the full day. */
function chipLabel(isoDay: string, today: string): string {
  const offset = daysFrom(today, isoDay);
  if (offset === 0) return 'I dag';
  if (offset === 1) return 'I morgen';
  return capitalise(danishDate(isoDay));
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
 * `event` and `personal` get none: their timestamp is the entry itself.
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

/** The link text for a source, by where it lives. */
function openLabel(source: SourceItem): string {
  return source.kind === 'personal' ? 'åbn i kalender' : 'åbn i Aula';
}

/**
 * One source, opened: a head naming it and when it is from, then the original —
 * every message of a thread, oldest first, or the post's own paragraphs.
 *
 * A partial thread says so rather than passing for the whole: `getThread`
 * pages, and a message with no text (an attachment alone) is dropped in
 * `collect.ts`; either way the reader is told not all of it is here.
 */
function sourceBlock(source: SourceItem, today: string): string {
  const messages = source.conversation?.messages ?? [];
  const head = `<div class="msg-head"><b>${escapeHtml(source.title)}</b><span>${escapeHtml(
    [sourceDateline(source, today), source.author].filter(Boolean).join(' · '),
  )}</span>${source.url ? `<a href="${escapeHtml(source.url)}">${openLabel(source)}</a>` : ''}</div>`;
  if (messages.length > 0) {
    const note = source.conversation?.truncated
      ? `<p class="msg-note">Ikke alle beskeder i tråden vises her (${messages.length} af ${source.conversation.total}) — hele tråden står i Aula.</p>`
      : '';
    return `<div class="src-block">${head}${messages.map(messageBlock).join('')}${note}</div>`;
  }
  return `<div class="src-block">${head}${paragraphs(source.text)}</div>`;
}

/**
 * The fold under a card: why it is on the page, then every source it rests on.
 *
 * A summary is only trustworthy if the thing it summarises is one tap away, so
 * every card carries its originals underneath it, collapsed. Skipped when there
 * is nothing left to open — a rule-made card whose summary *is* the whole
 * source, and no reason to show — because a more-block that reveals what the
 * reader just read teaches them to stop pressing things.
 */
function moreBlock(card: RankedCard, today: string): string {
  const shown = flatten(`${card.title} ${card.summary}`);
  const unseen = card.sources.filter((source) => {
    const body = flatten(
      source.conversation?.messages.length
        ? source.conversation.messages.map((m) => m.text).join(' ')
        : source.text,
    );
    return body.length > 0 && !shown.includes(body);
  });
  if (unseen.length === 0 && !card.reason) return '';
  const messages = card.sources[0]?.conversation?.messages.length ?? 0;
  const label =
    card.sources.length === 1
      ? messages > 1
        ? `Læs hele samtalen · ${messages} beskeder`
        : 'Læs mere'
      : `Læs mere · ${card.sources.length} kilder`;
  const reason = card.reason
    ? `<p class="reason"><b>Vist fordi:</b> ${escapeHtml(card.reason)}</p>`
    : '';
  return `<details class="more"><summary>${escapeHtml(label)}</summary><div class="body">${reason}${card.sources
    .map((source) => sourceBlock(source, today))
    .join('')}</div></details>`;
}

/** The one-line attribution under a card. */
function sourceLine(card: RankedCard, today: string): string {
  const [first] = card.sources;
  if (!first) return '';
  if (card.sources.length === 1) {
    return `${escapeHtml([first.title, sourceDateline(first, today), first.author].filter(Boolean).join(' · '))}${first.url ? ` · <a href="${escapeHtml(first.url)}">${openLabel(first)}</a>` : ''}`;
  }
  // Several sources: say how many and when the newest is from; the fold above
  // names each one with its own link.
  const newest = card.sources
    .map((source) => source.at ?? '')
    .filter(Boolean)
    .sort()
    .at(-1);
  const when = newest ? `seneste skrevet ${dayMonth(newest, today)}` : null;
  return `${escapeHtml([`${card.sources.length} kilder`, when].filter(Boolean).join(' · '))}${first.url ? ` · <a href="${escapeHtml(first.url)}">${openLabel(first)}</a>` : ''}`;
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

export type PageOptions = {
  topline?: string | null;
  summaries?: Record<string, string>;
  isNew?: (key: string) => boolean;
  /** The run timestamp, kept stable across validation and a second render. */
  generatedAt?: Date;
  /** A parent-facing failure that must stay visible without opening a fold. */
  overviewWarning?: string;
  /** Shown in the header's meta line — "kun reglerne" on a day without a model. */
  note?: string;
};

function generatedWhen(value: Date): string {
  if (Number.isNaN(value.getTime())) return 'ukendt tidspunkt';
  const day = value.getDate();
  const month = DA_MONTHS[value.getMonth()] ?? '';
  const year = value.getFullYear();
  const time = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  return `${day}. ${month} ${year} kl. ${time}`;
}

/** The one place page markup is written. */
export function renderPage(brief: RankedBrief, opts: PageOptions = {}): string {
  const { input } = brief;
  const today = input.today;
  const colour = new Map(input.family.children.map((c, i) => [c.firstName, `c${i + 1}`]));

  const card = (c: RankedCard) => `
    <div class="card ${c.needsAction ? 'act' : ''}" data-signal-id="${escapeHtml(c.id)}" data-source-id="${escapeHtml(c.sourceKeys[0] ?? '')}" data-done-keys="${escapeHtml(doneKeys(c).join(' '))}">
      <div class="row">
        ${c.date ? `<span class="chip ${c.date === today ? 'now' : 'soon'}">${escapeHtml(chipLabel(c.date, today))}</span>` : ''}
        ${c.recurrenceWeekday !== null ? `<span class="chip recurring">Gentages hver ${escapeHtml(DA_WEEKDAYS[c.recurrenceWeekday] ?? '')}</span>` : ''}
        ${c.needsAction ? '<span class="chip act">Skal gøres</span>' : ''}
        ${c.sourceKeys.some((key) => opts.isNew?.(key)) ? '<span class="chip new">Ny</span>' : ''}
        ${c.children.map((name) => `<span class="who"><span class="dot ${colour.get(name) ?? 'c1'}"></span>${escapeHtml(name)}</span>`).join('')}
      </div>
      <p class="title">${escapeHtml(c.title)}</p>
      ${c.summary ? `<p class="summary">${escapeHtml(c.summary)}</p>` : ''}
      ${moreBlock(c, today)}
      <div class="src">${sourceLine(c, today)}</div>
      <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
    </div>`;

  /**
   * A personal appointment is a card in the timeline, but not a full Aula card.
   * Its closed face keeps the source's title and interval intact; the model's
   * summary and relevance reason stay behind the individual fold.
   */
  const personal = (event: RankedPersonalEvent) => {
    const source = event.source;
    const meta = [source.location, source.author].filter(Boolean).join(' · ');
    return `
    <div class="card calendar-card" data-signal-id="${escapeHtml(event.id)}" data-source-id="${escapeHtml(event.sourceKey)}" data-done-keys="${escapeHtml(doneKeys({ sourceKeys: [event.sourceKey], date: event.date }).join(' '))}">
      <details class="calendar-details">
        <summary><span class="calendar-face">
          ${event.date ? `<span class="chip ${event.date === today ? 'now' : 'soon'}">${escapeHtml(chipLabel(event.date, today))}</span>` : ''}
          <span class="calendar-when">${escapeHtml(whenLabel(source))}</span>
          <span class="calendar-title">${escapeHtml(event.title)}</span>
          ${opts.isNew?.(event.sourceKey) ? '<span class="chip new">Ny</span>' : ''}
          <span class="calendar-origin">Egen kalender</span>
        </span></summary>
        <div class="calendar-body">
          ${event.summary ? `<p class="calendar-copy">${escapeHtml(event.summary)}</p>` : ''}
          ${event.reason ? `<p class="reason"><b>Vist fordi:</b> ${escapeHtml(event.reason)}</p>` : ''}
          <div class="calendar-meta">${escapeHtml(meta)}${source.url ? `${meta ? ' · ' : ''}<a href="${escapeHtml(source.url)}">åbn i kalender</a>` : ''}</div>
        </div>
      </details>
      <button class="tick" type="button" aria-pressed="false" aria-label="Markér som klaret"></button>
    </div>`;
  };

  // One list, by date. A divider separates the tails; it never heads a list
  // that is all one kind.
  const groups = [
    { label: null, entries: brief.timeline.filter((entry) => entry.placement === 'upcoming') },
    {
      label: 'Uden fast dato',
      entries: brief.timeline.filter((entry) => entry.placement === 'undated'),
    },
    { label: 'Tidligere', entries: brief.timeline.filter((entry) => entry.placement === 'past') },
  ].filter((group) => group.entries.length > 0);
  const timeline = groups
    .map((group, index) =>
      [
        index > 0 && group.label ? `<div class="divider">${group.label}</div>` : '',
        ...group.entries.map((entry: RankedTimelineEntry) =>
          entry.entryType === 'card' ? card(entry) : personal(entry),
        ),
      ].join(''),
    )
    .join('');
  const actions = brief.cards.filter((c) => c.needsAction).length;

  // A source-health warning must never look like a quiet week. Put this panel
  // right under the topline so the reader sees a failed fetch or persistent
  // configuration/session problem before trusting a thin list.
  // A `degraded` note is about the overview itself — the model's answer was
  // partial — and nothing is missing from Aula because of it; it renders in the
  // same panel, quietly at the foot.
  const hasHealthWarning = input.health.some((h) => h.level === 'warn');
  const datastatus = `<div class="panel" data-block="datastatus">
    ${input.health.map((h) => `<div class="st ${h.level === 'warn' ? 'bad' : ''}"><i>${h.level === 'warn' ? '⚠' : '○'}</i><span>${escapeHtml(h.message)}</span></div>`).join('')}
    ${brief.degraded.map((d) => `<div class="st bad"><i>⚠</i><span>${escapeHtml(d)}</span></div>`).join('')}
  </div>`;
  const quibbles = brief.degraded.length;
  const datastatusSummary =
    quibbles > 0
      ? `Datastatus · alle kilder blev hentet · ${quibbles} bemærkning${quibbles === 1 ? '' : 'er'} om oversigten`
      : 'Datastatus · alle kilder blev hentet';

  const fallbackTopline =
    actions === 0 ? 'Intet kræver handling lige nu.' : `${actions} ting kræver handling.`;

  const rest = [...brief.folded, ...brief.rest];

  return `<div class="wrap">
  <header>
    <div>
      <h1>${escapeHtml(capitalise(danishDate(today)))}</h1>
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
  ${
    opts.overviewWarning
      ? `<section class="overview-warning" data-block="overview-warning"><h2>Vigtigt om denne oversigt</h2><div class="panel"><div class="st bad"><i>⚠</i><span>${escapeHtml(opts.overviewWarning)}</span></div></div></section>`
      : ''
  }
  <p class="topline">${escapeHtml(opts.topline ?? fallbackTopline)}</p>

  ${hasHealthWarning ? `<section><h2>Datastatus</h2>${datastatus}</section>` : ''}

  <section data-section="cards"><h2>Kommende <span class="count" data-count>${brief.timeline.length}</span></h2>
    ${timeline}
    <div class="panel" data-empty${brief.timeline.length ? ' hidden' : ''}>Ingen punkter i dag. Det, der blev læst, står nederst under Øvrigt fra Aula.</div>
    <button class="done-toggle" type="button" aria-expanded="false" data-done-toggle hidden></button>
  </section>

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
    rest.length
      ? `<section><h2>Øvrigt fra Aula</h2><details><summary>${rest.length} opslag og beskeder, der ikke blev fremhævet</summary>
      ${brief.folded
        .map(
          (c) =>
            `<div class="di" data-source-id="${escapeHtml(c.sourceKeys[0] ?? '')}"><b>${escapeHtml(c.title)}</b>${c.summary ? `<p>${escapeHtml(c.summary)}</p>` : ''}${moreBlock(c, today)}<div class="src">${sourceLine(c, today)}</div></div>`,
        )
        .join('')}
      ${brief.rest
        .map(
          (item) =>
            `<div class="di" data-source-id="${escapeHtml(item.key)}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml([sourceDateline(item, today), item.author].filter(Boolean).join(' · '))}</p>${
              flatten(item.text) && flatten(item.text) !== flatten(item.title)
                ? `<details class="more"><summary>Læs mere</summary><div class="body">${sourceBlock(item, today)}</div></details>`
                : ''
            }</div>`,
        )
        .join('')}
    </details></section>`
      : ''
  }

  ${brief.hidden.length ? `<details class="muted"><summary>${brief.hidden.length} skjult</summary>${brief.hidden.map((item) => `<div class="di"><b>${escapeHtml(item.title)}</b><p>${escapeHtml([sourceDateline(item, today), item.author ?? item.groups.join(', ')].filter(Boolean).join(' · '))}</p></div>`).join('')}</details>` : ''}

  ${hasHealthWarning ? '' : `<details class="muted"><summary>${escapeHtml(datastatusSummary)}</summary>${datastatus}</details>`}

  <footer>Genereret ${escapeHtml(generatedWhen(opts.generatedAt ?? new Date()))}</footer>
</div>`;
}
