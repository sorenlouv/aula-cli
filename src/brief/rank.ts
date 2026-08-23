/**
 * From cards to a page order.
 *
 * The model chooses the cards and says what each one is; this file decides
 * where they go, and it does so from the date alone. There is no score: a
 * list of five to ten cards is the model's ranking, expressed as a selection
 * rather than a number, and a page that sorts those by date is one a reader
 * can scan for "what is next" without learning a layout. An earlier version
 * scored every signal on audience, kind, urgency and relevance and tiered the
 * page from the arithmetic; it produced consistent briefs and unreadable ones,
 * and the consistency came from the sort, not from the numbers.
 *
 * Three things stay deterministic here because a model does not do them well
 * every morning:
 *
 * - **The cap.** `CARD_CAP` cards render; anything past it is folded, least
 *   pressing first. If everything is a card, nothing is.
 * - **The `important` floor.** Aula's own flag is the school shouting. A
 *   flagged source no card covers gets a rule-made one, so a model that skims
 *   the mandatory sign-up cannot lose it.
 * - **The rules fallback.** Without a model the Danish extractors make the
 *   cards: weaker titles, the matched sentence for a summary, but a page.
 */

import { localIsoDate } from '../integrations/types.ts';
import { extractHits } from './rules.ts';
import type { BriefInput, Card, Placement, RankedBrief, RankedCard, SourceItem } from './types.ts';

/** At most this many cards on the page. The rest are folded, not dropped. */
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
 * structured thing the extractors exist to recover from a sentence, and the
 * page lists appointments in a fold of their own.
 */
export function cardsFromRules(input: BriefInput, now = new Date()): Card[] {
  const cards: Card[] = [];
  for (const item of input.items) {
    if (item.kind === 'personal') continue;
    const written = item.at ? new Date(item.at) : now;
    const reference = Number.isNaN(written.getTime()) ? now : written;
    for (const [index, hit] of extractHits(item.text, reference, now).entries()) {
      // A weekly-plan entry carries its own date, so "Husk skiftetøj" with no
      // date in the sentence still lands on the right day. A post or thread
      // does not: its timestamp is when it was written, not a deadline.
      const date = hit.dueAt ?? (item.kind === 'plan' ? isoOf(item.at) : null);
      cards.push({
        id: `${item.key}#${index}`,
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
  return cards;
}

function placementOf(date: string | null, today: string): Placement {
  if (!date) return 'undated';
  return date < today ? 'past' : 'upcoming';
}

/**
 * How pressing a card is, for the cap only. Page order is chronological; this
 * decides which cards survive when there are too many. Lower is kept first.
 */
function pressure(card: RankedCard): number {
  if (card.placement === 'past') return 4;
  if (card.placement === 'undated') return card.needsAction ? 2 : 3;
  return card.needsAction ? 0 : 1;
}

/**
 * `model` is the model's cards, or null when it did not run. `hidden` is its
 * list of sources to keep off the page; `rules` are the extractors' cards,
 * which are the page when there is no model and the `important` floor when
 * there is.
 */
export function rank(
  input: BriefInput,
  cards: { model: Card[] | null; rules: Card[]; hidden: string[] },
): RankedBrief {
  const itemByKey = new Map(input.items.map((item) => [item.key, item]));
  const degraded: string[] = [];
  const hiddenKeys = new Set(cards.hidden.filter((key) => itemByKey.has(key)));

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

  // The model's cards are the cards. Rule cards fill in only where the model
  // did not run — or, when it did, for an `important` source it left uncovered.
  let chosen: Card[];
  if (cards.model === null) {
    chosen = dedupeRuleCards(cards.rules.filter(real));
  } else {
    chosen = cards.model.filter(real);
    const covered = new Set(chosen.flatMap((card) => card.sourceKeys));
    for (const item of input.items) {
      if (!item.important || covered.has(item.key) || hiddenKeys.has(item.key)) continue;
      const fromRules = dedupeRuleCards(
        cards.rules.filter((card) => card.sourceKeys.includes(item.key)),
      );
      const floor: Card[] =
        fromRules.length > 0
          ? fromRules
          : [
              {
                id: `rule:important:${item.key}`,
                title: item.title,
                summary: '',
                children: item.childNames.map(firstName),
                date: null,
                needsAction: false,
                reason: 'Aula har markeret den som vigtig.',
                sourceKeys: [item.key],
                origin: 'rule',
              },
            ];
      chosen.push(...floor);
      covered.add(item.key);
    }
  }

  const ranked: RankedCard[] = chosen.map((card) => ({
    ...card,
    placement: placementOf(card.date, input.today),
    sources: card.sourceKeys.map((key) => itemByKey.get(key)!),
    reasons: [],
  }));
  for (const card of ranked) {
    card.reasons.push(`placement:${card.placement}`);
    if (card.origin === 'rule') card.reasons.push('rule-made');
    if (card.needsAction) card.reasons.push('needs action');
  }

  // ------------------------------------------------------------------ cap
  // Least pressing first over the edge: past, then undated information, then
  // undated actions, then dated information. Dated actions go last.
  const byPressure = [...ranked].sort(
    (a, b) =>
      pressure(a) - pressure(b) || (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99'),
  );
  const kept = new Set(byPressure.slice(0, CARD_CAP));
  const folded = byPressure.slice(CARD_CAP);
  for (const card of folded) card.reasons.push(`over CARD_CAP(${CARD_CAP}) → folded`);

  // ---------------------------------------------------------------- order
  // Upcoming by date, then undated, then past (most recent first — the nearer
  // the day, the more likely it still says something).
  const order: Record<Placement, number> = { upcoming: 0, undated: 1, past: 2 };
  const page = ranked
    .filter((card) => kept.has(card))
    .sort((a, b) => {
      if (order[a.placement] !== order[b.placement]) return order[a.placement] - order[b.placement];
      const ad = a.date ?? '';
      const bd = b.date ?? '';
      if (a.placement === 'past') return bd.localeCompare(ad);
      if (ad !== bd) return ad.localeCompare(bd);
      // Same day: what must be done before what is merely happening.
      return Number(b.needsAction) - Number(a.needsAction);
    });

  const covered = new Set(ranked.flatMap((card) => card.sourceKeys));
  const rest = input.items.filter(
    (item) => item.kind !== 'personal' && !covered.has(item.key) && !hiddenKeys.has(item.key),
  );
  const hidden = input.items.filter((item) => hiddenKeys.has(item.key));

  return { input, cards: page, folded, rest, hidden, degraded };
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
    `${brief.cards.length} kort, ${brief.folded.length} foldet, ${brief.rest.length} øvrige kilder, ${brief.hidden.length} skjult`,
  ];
  const line = (card: RankedCard) =>
    `\n[${card.placement}] ${card.needsAction ? '!' : ' '} ${card.title}` +
    `${card.date ? `  (${card.date})` : ''}` +
    `${card.children.length ? `  <${card.children.join(', ')}>` : ''}` +
    `\n    ${card.reasons.join('  ')}` +
    `\n    kilder: ${card.sourceKeys.join(', ')}`;
  for (const card of brief.cards) lines.push(line(card));
  for (const card of brief.folded) lines.push(line(card));
  for (const note of brief.degraded) lines.push(`\n! ${note}`);
  return lines.join('\n');
}

/** Sources the page shows inside the calendar fold. */
export function appointments(brief: RankedBrief): SourceItem[] {
  const hidden = new Set(brief.hidden.map((item) => item.key));
  return brief.input.items.filter((item) => item.kind === 'personal' && !hidden.has(item.key));
}
