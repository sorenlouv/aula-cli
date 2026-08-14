/**
 * Scoring, tiering and merging.
 *
 * The model proposes; this decides. Keeping placement deterministic is what
 * makes the page debuggable — `--explain` prints the arithmetic — and what
 * stops a good model day and a bad one producing structurally different briefs.
 *
 * **Audience breadth is the primary axis.** How narrowly something was
 * addressed predicts relevance better than what it is about. A municipal course
 * offer that happens to match a child's situation is still a municipal course
 * offer, and promoting it on topic alone is a mistake this file exists to
 * prevent.
 */

import { extractHits, urgencyFor } from './rules.ts';
import type {
  Audience,
  BriefInput,
  RankedBrief,
  RankedSignal,
  Signal,
  SignalKind,
  Tier,
  Urgency,
} from './types.ts';

/** At most this many items in "Kræver handling". If everything is urgent, nothing is. */
export const ACT_CAP = 5;

const AUDIENCE_SCORE: Record<Audience, number> = {
  child: 45,
  class: 30,
  // Mildly negative, not fatal. School-wide messages are mostly offers, but
  // some — photo day, a closure, a sign-up for your child — are real. Which is
  // which is decided by `concernsChild`, not by breadth.
  institution: 5,
  // Heavily penalised, but not infinitely: a municipal message that genuinely
  // concerns our children should sort low, not vanish. What keeps the course
  // offers out is `concernsChild` in `tierOf`, not this number.
  municipal: -40,
};

const KIND_SCORE: Record<SignalKind, number> = {
  bring: 25,
  action: 22,
  deadline: 20,
  event: 14,
  info: 0,
  social: -8,
};

const URGENCY_SCORE: Record<Urgency, number> = {
  now: 45,
  week: 30,
  later: 10,
  fyi: -20,
};

/** Kinds that can reach the action tier at all. An event is something to know, not do. */
const ACTIONABLE: ReadonlySet<SignalKind> = new Set<SignalKind>(['bring', 'action', 'deadline']);

function isoOf(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Signals the rules layer can find on its own.
 *
 * This runs whether or not the model does, so a brief is always produced. The
 * titles are weaker than the model's — a rule has no way to write "Husk
 * løbetøj til Alma på mandag", so it leans on the source title and lets the
 * quote carry the specifics.
 */
export function signalsFromRules(input: BriefInput, now = new Date()): Signal[] {
  const signals: Signal[] = [];
  for (const item of input.items) {
    const written = item.at ? new Date(item.at) : now;
    const reference = Number.isNaN(written.getTime()) ? now : written;
    const hits = extractHits(item.text, reference, now);
    for (const [index, hit] of hits.entries()) {
      // A weekly-plan entry carries its own date, so "Husk skiftetøj" with no
      // date in the sentence still lands on the right day.
      const dueAt = hit.dueAt ?? isoOf(item.at);
      signals.push({
        id: `${item.key}#${index}`,
        kind: hit.kind,
        title: item.title,
        child: item.childNames.length === 1 ? firstName(item.childNames[0] ?? '') : null,
        dueAt,
        urgency: hit.dueAt ? hit.urgency : urgencyFor(dueAt, now, hit.urgency),
        quote: hit.quote,
        why: null,
        sourceKey: item.key,
        origin: 'rule',
        concernsChild: looksLikeChildBusiness(item),
      });
    }
  }
  return signals;
}

function firstName(full: string): string {
  return full.split(' ')[0] ?? full;
}

function scoreOf(
  signal: Signal,
  audience: Audience,
  important: boolean,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  score += AUDIENCE_SCORE[audience];
  reasons.push(`audience:${audience} ${AUDIENCE_SCORE[audience] >= 0 ? '+' : ''}${AUDIENCE_SCORE[audience]}`);

  score += KIND_SCORE[signal.kind];
  reasons.push(`kind:${signal.kind} +${KIND_SCORE[signal.kind]}`);

  score += URGENCY_SCORE[signal.urgency];
  reasons.push(`urgency:${signal.urgency} ${URGENCY_SCORE[signal.urgency] >= 0 ? '+' : ''}${URGENCY_SCORE[signal.urgency]}`);

  if (important) {
    score += 12;
    reasons.push('aula-important +12');
  }
  if (signal.child) {
    score += 8;
    reasons.push(`names ${signal.child} +8`);
  }
  if (signal.concernsChild) {
    score += 15;
    reasons.push('concerns our child +15');
  }
  return { score, reasons };
}

function tierOf(signal: Signal, audience: Audience, important: boolean): Tier {
  // Who it was sent to is a strong prior, never a veto. The content decides.
  // A message to every school in the municipality saying the schools are shut
  // on Friday still shuts ours, and burying it because of its address would be
  // the same mistake as promoting a course offer because of its deadline.
  if (audience === 'municipal' && !signal.concernsChild && !important) return 'hidden';
  // A school-wide message earns a place only when it asks something of us about
  // our own child. Photo-day sign-up does; a parenting course on offer does not.
  if (audience === 'institution' && !signal.concernsChild && !important) return 'context';

  if (ACTIONABLE.has(signal.kind) && (signal.urgency === 'now' || signal.urgency === 'week')) {
    return 'act';
  }
  if (signal.dueAt && signal.urgency !== 'fyi') return 'week';
  return 'context';
}

/**
 * Rule-side guess at whether something concerns our child.
 *
 * The school addresses you *about your child* ("tilmeld jeres barn", "eleverne
 * skal"); the municipality addresses you *as a participant* ("forløbet er
 * målrettet forældre til børn, der …"). The model does this far better; this is
 * the floor for when it is unavailable.
 */
const ABOUT_THE_CHILD =
  /\b(jeres|dit|dine|deres) barn\b|\bbørnene\b|\beleverne\b|\bklassen\b|\bbarnet\b/i;
const AN_OFFER = /\btilbud\b|\bforløb(et|ene)?\b|\bkursus\b|\bnetværk(et)?\b|målrettet forældre/i;

export function looksLikeChildBusiness(item: { text: string; childNames: string[] }): boolean {
  if (item.childNames.length > 0) return true;
  if (AN_OFFER.test(item.text)) return false;
  return ABOUT_THE_CHILD.test(item.text);
}

/**
 * Same thing said twice.
 *
 * When there is a date, the same child + date + kind is treated as one thing
 * however differently it is worded — the meeting on 18 September arrives as
 * "Netværksmøde" in one thread and "Møde ang. Alma d. 18/9" in another, and
 * showing both is exactly the noise this is meant to remove. Undated signals
 * fall back to matching on the subject, which is all there is to go on.
 */
function mergeKey(signal: Signal): string {
  if (signal.dueAt) return `${signal.child ?? 'alle'}|${signal.dueAt}|${signal.kind}`;
  const title = signal.title
    .toLowerCase()
    .replace(/[«»"'.,!?:–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `title|${title}`;
}

export function rank(input: BriefInput, signals: Signal[]): RankedBrief {
  const itemByKey = new Map(input.items.map((item) => [item.key, item]));
  const degraded: string[] = [];

  const scored: RankedSignal[] = [];
  for (const signal of signals) {
    const source = itemByKey.get(signal.sourceKey);
    if (!source) {
      // A signal citing a source that is not in the input is a bug or a
      // fabrication; either way it must not reach the page.
      degraded.push(`Udeladt: signal "${signal.title}" peger på en ukendt kilde (${signal.sourceKey}).`);
      continue;
    }
    const { score, reasons } = scoreOf(signal, source.audience, source.important);
    const tier = tierOf(signal, source.audience, source.important);
    scored.push({
      ...signal,
      score,
      tier,
      mustShow: tier === 'act' || tier === 'week',
      audience: source.audience,
      reasons,
      source,
      mergedSourceKeys: [],
    });
  }

  // ------------------------------------------------------------------ merge
  // The rules layer is a floor, not a peer: where the model has spoken about a
  // source, its wording and reasoning are better, so the rule hits for that
  // source are dropped rather than shown alongside as near-duplicates.
  const modelSources = new Set(
    scored.filter((s) => s.origin === 'model').map((s) => s.sourceKey),
  );
  const preferred = scored.filter((s) => s.origin === 'model' || !modelSources.has(s.sourceKey));

  // Then within a source, but only for hits that are actually the same thing.
  // Every rule hit from one item inherits that item's title, so keying on the
  // title alone collapsed a post's *distinct* obligations — "tilmeld senest
  // 20/8" and "udfyld kontaktsedlen 25/8" became one, and the 25/8 deadline
  // was lost without even surfacing as an unused source. The date and kind are
  // what make two hits different, so they belong in the key. The cost is that
  // one meeting quoted with two dates ("skrevet d. 11/8", "mødet er d. 18/9")
  // now yields two signals rather than one; the stale date scores low and
  // sinks, which is the cheaper failure of the two.
  const bySource = new Map<string, RankedSignal>();
  for (const signal of preferred.sort((a, b) => b.score - a.score)) {
    const key = `${signal.sourceKey}|${signal.title}|${signal.kind}|${signal.dueAt ?? ''}`;
    if (!bySource.has(key)) bySource.set(key, signal);
  }

  // Then across sources: the same subject on the same date is one thing said
  // twice, however many institutions sent it.
  const byKey = new Map<string, RankedSignal>();
  for (const signal of [...bySource.values()].sort((a, b) => b.score - a.score)) {
    const key = mergeKey(signal);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, signal);
      continue;
    }
    if (!existing.mergedSourceKeys.includes(signal.sourceKey) && signal.sourceKey !== existing.sourceKey) {
      existing.mergedSourceKeys.push(signal.sourceKey);
    }
  }
  const merged = [...byKey.values()];

  // ------------------------------------------------------------------- cap
  // Overflow drops a tier rather than disappearing.
  const act = merged
    .filter((s) => s.tier === 'act')
    .sort((a, b) => b.score - a.score || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  for (const overflow of act.slice(ACT_CAP)) {
    overflow.tier = 'week';
    overflow.reasons.push(`over ACT_CAP(${ACT_CAP}) → week`);
  }

  const ordered = merged.sort((a, b) => {
    const rank = { act: 0, week: 1, context: 2, hidden: 3 } as const;
    if (rank[a.tier] !== rank[b.tier]) return rank[a.tier] - rank[b.tier];
    // Within a tier, soonest first; undated items sink.
    const aDue = a.dueAt ?? '9999-99-99';
    const bDue = b.dueAt ?? '9999-99-99';
    if (aDue !== bDue) return aDue.localeCompare(bDue);
    return b.score - a.score;
  });

  const usedKeys = new Set(ordered.flatMap((s) => [s.sourceKey, ...s.mergedSourceKeys]));
  const unusedSources = input.items.filter((item) => !usedKeys.has(item.key));

  return { input, signals: ordered, unusedSources, degraded };
}

/** Human-readable score breakdown for `--explain`. */
export function explain(brief: RankedBrief): string {
  const lines = [`${brief.signals.length} signal(er), ${brief.unusedSources.length} ubrugt kilde(r)`];
  for (const signal of brief.signals) {
    lines.push(
      `\n[${signal.tier}] ${signal.score}  ${signal.title}` +
        `${signal.dueAt ? `  (${signal.dueAt})` : ''}` +
        `${signal.child ? `  <${signal.child}>` : ''}` +
        `\n    ${signal.reasons.join('  ')}` +
        `\n    kilde: ${signal.sourceKey}` +
        (signal.mergedSourceKeys.length ? ` + ${signal.mergedSourceKeys.join(', ')}` : ''),
    );
  }
  for (const note of brief.degraded) lines.push(`\n! ${note}`);
  return lines.join('\n');
}
