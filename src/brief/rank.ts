/**
 * From cards to a page order.
 *
 * The model chooses the Aula cards, puts them in priority order, and gives every
 * personal appointment a relevance verdict. Code keeps the first `CARD_CAP`
 * full cards, folds the rest, turns relevant appointments into compact entries,
 * then sorts both shapes into one chronological timeline.
 *
 * Two things stay deterministic here:
 *
 * - **The cap.** `CARD_CAP` full Aula cards render; anything after them is
 *   folded. Compact personal cards do not crowd an Aula card out.
 * - **The rules fallback.** Without a model the Danish extractors make the
 *   cards: weaker titles, the matched sentence for a summary, but a page.
 */

import { localIsoDate } from '../integrations/types.ts';
import { extractHits } from './rules.ts';
import type {
  BriefInput,
  Card,
  PersonalEventVerdict,
  Placement,
  RankedBrief,
  RankedCard,
  RankedPersonalEvent,
  RankedTimelineEntry,
  SourceItem,
} from './types.ts';

/** At most this many full Aula cards render. Compact calendar cards are separate. */
export const CARD_CAP = 12;

function isoOf(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return localIsoDate(new Date(parsed));
}

function firstName(full: string): string {
  return full.split(' ')[0] ?? full;
}

/**
 * Cards the rules layer can make on its own.
 *
 * This runs whether or not the model does. The titles are weaker than the
 * model's — a rule has no way to write "Husk løbetøj til Alma på mandag", so
 * it leans on the source title and lets the matched sentence, verbatim, carry
 * the specifics as the summary.
 *
 * The family's own appointments are skipped: a calendar entry is already the
 * structured thing the extractors exist to recover from a sentence. Its model
 * verdict and compact fallback are handled separately below.
 */
export function cardsFromRules(input: BriefInput, now = new Date()): Card[] {
  const cards: Card[] = [];
  for (const item of input.items) {
    if (item.kind === 'personal') continue;
    const written = item.at ? new Date(item.at) : now;
    const reference = Number.isNaN(written.getTime()) ? now : written;
    const messageReference = (at: string | null) => {
      if (!at) return reference;
      const parsed = new Date(at);
      return Number.isNaN(parsed.getTime()) ? reference : parsed;
    };
    const scans = item.conversation
      ? [
          {
            text: item.title,
            reference: messageReference(
              item.conversation.messages.find((message) => message.at)?.at ?? null,
            ),
          },
          ...item.conversation.messages.map((message) => ({
            text: message.text,
            reference: messageReference(message.at),
          })),
        ]
      : [{ text: item.text, reference }];
    let index = 0;
    for (const scan of scans) {
      for (const hit of extractHits(scan.text, scan.reference, now)) {
        // A weekly-plan entry carries its own date, so "Husk skiftetøj" with no
        // date in the sentence still lands on the right day. A post or thread
        // does not: its timestamp is when it was written, not a deadline.
        const date = hit.dueAt ?? (item.kind === 'plan' ? isoOf(item.at) : null);
        cards.push({
          id: `${item.key}#${index++}`,
          title: item.title,
          summary: hit.quote,
          children: item.childNames.map(firstName),
          date,
          needsAction: hit.kind === 'bring' || hit.kind === 'action' || hit.kind === 'deadline',
          reason: null,
          sourceKeys: [item.key],
          origin: 'rule',
        });
      }
    }
  }
  return cards;
}

function placementOf(date: string | null, today: string): Placement {
  if (!date) return 'undated';
  return date < today ? 'past' : 'upcoming';
}

/** Exact start only where a structured Aula calendar source supplies it. */
function cardSortAt(date: string | null, sources: SourceItem[]): string | null {
  if (!date) return null;
  const starts = new Set(
    sources
      .filter(
        (source) => source.kind === 'event' && !source.allDay && source.at?.slice(0, 10) === date,
      )
      .map((source) => source.at)
      .filter((at): at is string => Boolean(at)),
  );
  return starts.size === 1 ? ([...starts][0] ?? null) : null;
}

const placementOrder: Record<Placement, number> = { upcoming: 0, undated: 1, past: 2 };

/**
 * Shared page order. Different days are always chronological. On one day,
 * all-day/date-only entries come first and entries with known starts follow by
 * clock time; equal or unknowable times keep their stable model order.
 */
function compareTimeline(a: RankedTimelineEntry, b: RankedTimelineEntry): number {
  if (placementOrder[a.placement] !== placementOrder[b.placement]) {
    return placementOrder[a.placement] - placementOrder[b.placement];
  }
  const ad = a.date ?? '';
  const bd = b.date ?? '';
  if (a.placement === 'past' && ad !== bd) return bd.localeCompare(ad);
  if (ad !== bd) return ad.localeCompare(bd);
  if (a.sortAt && b.sortAt && a.sortAt !== b.sortAt) return a.sortAt.localeCompare(b.sortAt);
  if (Boolean(a.sortAt) !== Boolean(b.sortAt)) return a.sortAt ? 1 : -1;
  return 0;
}

/**
 * `model` is the model's Aula cards, or null when it did not run. `personalEvents`
 * contains the validated verdicts that survived extraction; a missing verdict
 * fails open to a compact source-only appointment. `hidden` is the model's Aula
 * hide list; `rules` are the fallback cards when there is no model.
 */
export function rank(
  input: BriefInput,
  cards: {
    model: Card[] | null;
    personalEvents?: PersonalEventVerdict[] | null;
    rules: Card[];
    hidden: string[];
  },
): RankedBrief {
  const itemByKey = new Map(input.items.map((item) => [item.key, item]));
  const degraded: string[] = [];
  const hiddenKeys = new Set(cards.hidden.filter((key) => itemByKey.has(key)));
  const modelRanks = new Map(cards.model?.map((card, index) => [card, index + 1]) ?? []);
  const personalRanks = new Map(
    cards.personalEvents?.map((verdict, index) => [verdict, index + 1]) ?? [],
  );
  const personalByKey = new Map(
    cards.personalEvents?.map((verdict) => [verdict.sourceKey, verdict]) ?? [],
  );

  // Drop anything citing a source that is not in the input. The schema makes
  // this impossible on the model path; the check stays for the rules path and
  // for an answer that arrived without a schema.
  const real = (card: Card): boolean => {
    const unknown = card.sourceKeys.filter((key) => !itemByKey.has(key));
    if (unknown.length === 0 && card.sourceKeys.length > 0) return true;
    degraded.push(
      `Udeladt: kortet "${card.title}" peger på en ukendt kilde (${unknown.join(', ')}).`,
    );
    return false;
  };

  // The model's cards are the cards. Rules take over only when the model did
  // not run; they never second-guess a model answer.
  const chosen =
    cards.model === null ? dedupeRuleCards(cards.rules.filter(real)) : cards.model.filter(real);

  const ranked: RankedCard[] = chosen.map((card) => ({
    ...card,
    entryType: 'card',
    placement: placementOf(card.date, input.today),
    sources: card.sourceKeys.map((key) => itemByKey.get(key)!),
    sortAt: null,
    modelRank: modelRanks.get(card) ?? null,
    reasons: [],
  }));
  for (const card of ranked) {
    card.sortAt = cardSortAt(card.date, card.sources);
    if (card.modelRank !== null) card.reasons.push(`model rank:${card.modelRank}`);
    card.reasons.push(`placement:${card.placement}`);
    if (card.origin === 'rule') card.reasons.push('rule-made');
    if (card.needsAction) card.reasons.push('needs action');
  }

  // ------------------------------------------------------------------ cap
  // Model order is the ranking: code keeps the first N and folds the rest.
  const kept = new Set(ranked.slice(0, CARD_CAP));
  const folded = ranked.slice(CARD_CAP);
  for (const card of folded) card.reasons.push(`over CARD_CAP(${CARD_CAP}) → folded`);

  // ------------------------------------------------------ personal appointments
  // A missing or invalid verdict must never look like a free afternoon. Show it
  // with source facts only; extraction has already recorded why the run is
  // incomplete. An explicit relevant=false is the one route into hidden.
  const personalEvents: RankedPersonalEvent[] = [];
  for (const source of input.items.filter((item) => item.kind === 'personal')) {
    const verdict = personalByKey.get(source.key);
    if (verdict?.relevant === false) {
      hiddenKeys.add(source.key);
      continue;
    }
    const date = source.at?.slice(0, 10) || null;
    const event: RankedPersonalEvent = {
      entryType: 'personal',
      id: `personal:${source.key}`,
      sourceKey: source.key,
      title: source.title,
      summary: verdict?.summary ?? '',
      reason: verdict?.reason ?? null,
      date,
      placement: placementOf(date, input.today),
      source,
      sortAt: source.allDay ? null : source.at,
      modelRank: verdict ? (personalRanks.get(verdict) ?? null) : null,
      reasons: [],
    };
    if (event.modelRank !== null) event.reasons.push(`calendar model rank:${event.modelRank}`);
    else event.reasons.push('calendar verdict missing → shown');
    event.reasons.push(`placement:${event.placement}`);
    personalEvents.push(event);
    hiddenKeys.delete(source.key);
  }

  // ---------------------------------------------------------------- order
  // Upcoming by date, then undated, then past (most recent first — the nearer
  // the day, the more likely it still says something).
  const page = ranked.filter((card) => kept.has(card)).sort(compareTimeline);
  const timeline = [...page, ...personalEvents].sort(compareTimeline);
  const personalPage = timeline.filter(
    (entry): entry is RankedPersonalEvent => entry.entryType === 'personal',
  );

  const covered = new Set(ranked.flatMap((card) => card.sourceKeys));
  // A contradictory answer can cite and hide the same source. Showing wins:
  // the card depends on it, and hiding it would make the source disappear from
  // the muted count while still appearing under Læs mere.
  for (const key of covered) hiddenKeys.delete(key);
  const rest = input.items.filter(
    (item) => item.kind !== 'personal' && !covered.has(item.key) && !hiddenKeys.has(item.key),
  );
  const hidden = input.items.filter((item) => hiddenKeys.has(item.key));

  return {
    input,
    cards: page,
    personalEvents: personalPage,
    timeline,
    folded,
    rest,
    hidden,
    degraded,
  };
}

/**
 * One source's rule hits collapse on title + date — a post's two distinct
 * obligations ("tilmeld senest 20/8", "udfyld sedlen 25/8") stay two cards,
 * the same sentence matched twice becomes one.
 */
function dedupeRuleCards(cards: Card[]): Card[] {
  const seen = new Map<string, Card>();
  for (const card of cards) {
    const key = `${card.sourceKeys.join(',')}|${card.title}|${card.date ?? ''}|${card.needsAction}`;
    if (!seen.has(key)) seen.set(key, card);
  }
  return [...seen.values()];
}

/** Human-readable breakdown for `--explain`. */
export function explain(brief: RankedBrief): string {
  const lines = [
    `${brief.cards.length} Aula-kort, ${brief.personalEvents.length} kalenderkort, ${brief.folded.length} foldet, ${brief.rest.length} øvrige kilder, ${brief.hidden.length} skjult`,
  ];
  const line = (card: RankedCard) =>
    `\n[${card.placement}] ${card.needsAction ? '!' : ' '} ${card.title}` +
    `${card.date ? `  (${card.date})` : ''}` +
    `${card.children.length ? `  <${card.children.join(', ')}>` : ''}` +
    `\n    ${card.reasons.join('  ')}` +
    `\n    kilder: ${card.sourceKeys.join(', ')}`;
  for (const card of brief.cards) lines.push(line(card));
  for (const event of brief.personalEvents) {
    lines.push(
      `\n[${event.placement}] · ${event.title}` +
        `${event.date ? `  (${event.date})` : ''}` +
        `\n    ${event.reasons.join('  ')}` +
        `\n    kilde: ${event.sourceKey}`,
    );
  }
  for (const card of brief.folded) lines.push(line(card));
  for (const note of brief.degraded) lines.push(`\n! ${note}`);
  return lines.join('\n');
}
