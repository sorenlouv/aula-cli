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
 *
 * **The family's list reaches this file as verdicts, never as prose.** The
 * model reads `~/.aula/preferences.md` and answers `hide | low | normal | high`
 * per source (see `Relevance`); this file only compares those words to
 * structured fields. It used to regex sender names and negation words out of
 * the lines itself, and got the canonical example wrong — a wish about *John
 * (Hjaltes far)* floored every message from a teacher called Hjalte. Prose is the
 * model's to read; what a rule can check is the verdict, the audience, the
 * kind, the date and Aula's own `important` flag, and nothing else.
 */

import { extractHits, urgencyFor } from './rules.ts';
import type {
  Audience,
  BriefInput,
  SourceItem,
  RankedBrief,
  RankedSignal,
  Relevance,
  Signal,
  SignalKind,
  Tier,
  Urgency,
} from './types.ts';

/** At most this many items in the `act` tier. If everything is urgent, nothing is. */
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
  // offers out of the cards is `concernsChild` in `tierOf`, and what hides
  // them is the family's own list, read by the model — not this number.
  municipal: -40,
  // The family's own appointments. Just under `child`, so a school thing about
  // one of them wins a contested slot — but only just, because an appointment
  // they entered themselves is by definition something they meant.
  family: 40,
};

/**
 * The family's say, as the model read it. Enough to decide what survives the
 * action cap and what is first to overflow it; not enough to outweigh a child's
 * own weekly plan with a municipal post.
 *
 * `hide` scores zero rather than lowest, and that is not the same as "never
 * scored": a `hide` that `tierOf`'s child floor lifted into `context` is sorted
 * there like anything else, and comes out above a `low` on -25. Ordering inside
 * one fold, so it changes nothing about placement — but it does mean the thing
 * the family asked to put away sits above the thing they merely deprioritised,
 * which is worth knowing before treating these four numbers as a ranking.
 */
const RELEVANCE_SCORE: Record<Relevance, number> = {
  high: 25,
  normal: 0,
  low: -25,
  hide: 0,
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
    // A calendar entry is already the structured thing the Danish extractors
    // exist to recover from a sentence, so running them over its title would
    // only find the date it already has — or worse, a second one.
    if (item.kind === 'personal') {
      signals.push(personalSignal(item, now));
      continue;
    }
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

/**
 * The family's own appointment, as one signal.
 *
 * Always an `event`, never an `action`: it is a dated thing to know, and it
 * takes its place among the week's other dated things on the same day as the
 * school's own. `ACTIONABLE` deliberately excludes `event`, so nothing here can
 * reach *Kræver handling* — which is the point. The cap there is five, and an
 * appointment nobody has asked us to do anything about must not be able to
 * push a real school deadline off the page.
 */
function personalSignal(item: SourceItem, now: Date): Signal {
  const dueAt = isoOf(item.at);
  return {
    id: `${item.key}#0`,
    kind: 'event',
    title: item.title,
    child: null,
    dueAt,
    urgency: urgencyFor(dueAt, now, 'later'),
    // Nothing to quote: the title *is* the source text, and a "quote" repeating
    // the line above it is the small lie the `Læs mere` rule already refuses.
    quote: null,
    why: null,
    sourceKey: item.key,
    origin: 'rule',
    // Nobody asked us for this; we wrote it down ourselves.
    concernsChild: false,
  };
}

function scoreOf(
  signal: Signal,
  audience: Audience,
  important: boolean,
  relevance: Relevance,
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
  if (relevance !== 'normal') {
    score += RELEVANCE_SCORE[relevance];
    reasons.push(
      `relevance:${relevance} ${RELEVANCE_SCORE[relevance] >= 0 ? '+' : ''}${RELEVANCE_SCORE[relevance]}`,
    );
  }
  return { score, reasons };
}

function tierOf(
  signal: Signal,
  audience: Audience,
  important: boolean,
  relevance: Relevance,
): Tier {
  // The family's list, as the model read it, is the only thing that hides —
  // with two things it yields to.
  //
  // Aula's own `important` flag is the first: a school shouting is not something a
  // preference can mute, and `important` is set rarely enough to mean it.
  //
  // `concernsChild` is the second, and it is a floor rather than an exemption:
  // something that asks us for something about our own child is demoted to
  // the `context` tier instead of hidden. The wish is still honoured — it never
  // becomes a card — but the item stays findable. This is the closure case,
  // and it is the reason `hide` is not simply absolute: *"fællesbeskeder til
  // alle forældre i kommunen er aldrig relevante"* is a fair thing to want and
  // a bad thing to apply to "alle skoler er lukket på mandag". One verdict is
  // one model's reading on one morning, and the tier it can reach on its own
  // is bounded accordingly: the worst outcome here is a fold, never a miss.
  if (relevance === 'hide' && !important) return signal.concernsChild ? 'context' : 'hidden';
  // "Matters less" keeps it off the cards, not off the page — same reasoning,
  // so a verdict the model got wrong costs a fold, not the item.
  if (relevance === 'low' && !important) return 'context';
  // Who it was sent to is a strong prior, never a veto. The content decides.
  // A message to every school in the municipality saying the schools are shut
  // on Friday still shuts ours, and burying it because of its address would be
  // the same mistake as promoting a course offer because of its deadline. So a
  // broad message earns a card only when it asks something of us about our own
  // child: photo-day sign-up does, a parenting course on offer does not — and
  // a municipal offer with a genuine deadline is still an offer.
  if ((audience === 'institution' || audience === 'municipal') && !signal.concernsChild && !important) {
    return 'context';
  }

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

/**
 * On the `hide` path this is not a fallback — it is the only reader.
 *
 * The comment above says the model does this better, and it does, but it only
 * ever gets the chance on a source it wrote a signal for. A `hide` verdict is
 * by its nature a source the model found nothing worth extracting from, so the
 * `concernsChild` that `tierOf`'s floor consults there comes from these regexes
 * every time. Loosening them loosens the floor; that is the trade, and it is
 * why the floor demotes to `context` rather than promoting anything.
 */
function looksLikeChildBusiness(item: { text: string; childNames: string[] }): boolean {
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
 *
 * Identity only: what a signal *is*, never where it ended up. Where it ended up
 * is `interchangeable`'s question, and mixing the two would make this key
 * depend on a tier that later steps still mutate.
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

/**
 * Whether one of these two may stand for the other on the page.
 *
 * `mergeKey` says which signals are *candidates* to merge — the same subject on
 * the same date. This says which of those candidates the page can honestly
 * represent with one entry, and there are two boundaries it will not cross.
 *
 * The hidden one: absorbing a hidden signal into a visible one shows what the
 * family asked to put away, and absorbing a visible one into a hidden one takes
 * it off the page altogether. Same subject, same date, different answer to "do
 * you want this".
 *
 * And Aula's own `important` flag, which is the same loss reached from the other
 * side: the loser of a merge survives only as a key in the winner's
 * `mergedSourceKeys`, which counts as covered everywhere downstream — no card,
 * no `context` tier, no muted foot, not even `unusedSources` — and the
 * `important` floor below only ever inspects the winner, so a flagged item that lost is
 * past rescuing. Only one of the two is the school shouting, so: two entries.
 *
 * Both are read where they have settled: `tierOf` has run and the floors below
 * have not, which is what makes the hidden read well-defined here, and the flag
 * is the source's own and never moves at all.
 */
function interchangeable(a: RankedSignal, b: RankedSignal): boolean {
  return (
    (a.tier === 'hidden') === (b.tier === 'hidden') &&
    a.source.important === b.source.important
  );
}

/**
 * `relevance` is the model's verdict per source key — see `Relevance`. Absent
 * (the rules-only path, or a source the model skipped) means `normal`, so a
 * brief built without the model ranks on breadth and content alone and hides
 * nothing: failing towards showing a family more than they asked for, the
 * cheaper failure for a tool whose worst outcome is a miss.
 */
export function rank(
  input: BriefInput,
  signals: Signal[],
  relevance: Record<string, Relevance> = {},
): RankedBrief {
  const itemByKey = new Map(input.items.map((item) => [item.key, item]));
  const degraded: string[] = [];
  const verdictOf = (key: string): Relevance => relevance[key] ?? 'normal';

  const scored: RankedSignal[] = [];
  for (const signal of signals) {
    const source = itemByKey.get(signal.sourceKey);
    if (!source) {
      // A signal citing a source that is not in the input is a bug or a
      // fabrication; either way it must not reach the page.
      degraded.push(`Udeladt: signal "${signal.title}" peger på en ukendt kilde (${signal.sourceKey}).`);
      continue;
    }
    const verdict = verdictOf(source.key);
    const { score, reasons } = scoreOf(signal, source.audience, source.important, verdict);
    const tier = tierOf(signal, source.audience, source.important, verdict);
    scored.push({
      ...signal,
      score,
      tier,
      mustShow: tier === 'act' || tier === 'week',
      audience: source.audience,
      relevance: verdict,
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
  // twice, however many institutions sent it. Highest scorer first, so it is
  // the one the others are folded into — but only where they may stand for one
  // another, so a key can hold a hidden entry and a visible one, or a
  // flagged entry and an unflagged one.
  const byKey = new Map<string, RankedSignal[]>();
  for (const signal of [...bySource.values()].sort((a, b) => b.score - a.score)) {
    const key = mergeKey(signal);
    const candidates = byKey.get(key);
    if (!candidates) {
      byKey.set(key, [signal]);
      continue;
    }
    const standsFor = candidates.find((existing) => interchangeable(existing, signal));
    if (!standsFor) {
      candidates.push(signal);
      continue;
    }
    if (!standsFor.mergedSourceKeys.includes(signal.sourceKey) && signal.sourceKey !== standsFor.sourceKey) {
      standsFor.mergedSourceKeys.push(signal.sourceKey);
    }
  }
  const merged = [...byKey.values()].flat();

  // ------------------------------------------------------------------- cap
  // Overflow drops a tier rather than disappearing.
  const act = merged
    .filter((s) => s.tier === 'act')
    .sort((a, b) => b.score - a.score || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  for (const overflow of act.slice(ACT_CAP)) {
    overflow.tier = 'week';
    overflow.reasons.push(`over ACT_CAP(${ACT_CAP}) → week`);
  }

  // ---------------------------------------------------------------- floor
  // Aula's `important` flag is the school shouting, and it is deterministic —
  // so the floor is too. The model benchmark showed mid-tier models reading
  // an important-marked mandatory sign-up as background, or missing it entirely;
  // either way it must not end below the fold. An under-read signal is
  // promoted to the week tier, and an important item no signal covered gets
  // a plain rule-made one. The model may still promote it further; it can
  // no longer sink it.
  for (const signal of merged) {
    if (signal.source.important && signal.tier === 'context') {
      signal.tier = 'week';
      signal.mustShow = true;
      signal.reasons.push('aula-important floor → week');
    }
  }

  // -------------------------------------------------- relevance floor
  // The family's own list, as the model read it — the promotion half.
  //
  // `tierOf` only ever lets a verdict push *down* (`hide`, `low`); `high` is
  // applied here, after the cap, so it has the same shape as the important floor:
  // a source the family says matters cannot end below the fold, whatever the
  // audience prior or the kind of signal made of it. The model may place it
  // higher; it can no longer lose it. Never `act`, though — that tier is for
  // things to do, and a wish makes something wanted, not actionable.
  for (const signal of merged) {
    if (signal.relevance === 'high' && signal.tier === 'context') {
      signal.tier = 'week';
      signal.mustShow = true;
      signal.reasons.push('relevance:high floor → week');
    }
  }

  // Sources no signal covered. The tier is decided here rather than by
  // `tierOf`, and the one place that shows is `hide`: a source nothing could be
  // extracted from is hidden even where `looksLikeChildBusiness` would have
  // floored it to `context`. That is deliberate, and it is the weaker half of
  // the floor that is being declined. The floor exists for things that ask us
  // for something about our own child, and here neither the model nor the
  // Danish rules found anything being asked at all — so the only evidence left
  // is `childNames`, which Aula attaches to a photo album as readily as to a
  // sign-up. Running the floor on that alone would resurrect exactly the quiet
  // child-tagged posts a family says "never" about. Taking their word costs a
  // fold: the source is still listed in the muted foot.
  //
  // "Sig altid til når John skriver" is a promise,
  // and a model that extracted nothing from his message is exactly the day it
  // is tested — so a `high` source gets a plain rule-made signal, like an
  // important one. A `hide` source gets one too, in the hidden tier: it would
  // otherwise surface in the `context` tier as an unused source, which is the
  // opposite of what the family asked, and the muted foot is where hidden
  // things are accounted for. Nothing is silently lost either way.
  const covered = new Set(merged.flatMap((s) => [s.sourceKey, ...s.mergedSourceKeys]));
  for (const item of input.items) {
    if (covered.has(item.key)) continue;
    const verdict = verdictOf(item.key);
    if (!item.important && verdict !== 'high' && verdict !== 'hide') continue;
    const tier: Tier = item.important || verdict === 'high' ? 'week' : 'hidden';
    const base: Signal = {
      id: `rule:${item.important ? 'important' : verdict}:${item.key}`,
      kind: 'info',
      title: item.title,
      child: item.childNames.length === 1 ? firstName(item.childNames[0] ?? '') : null,
      dueAt: null,
      urgency: tier === 'week' ? 'week' : 'fyi',
      quote: null,
      why: null,
      sourceKey: item.key,
      origin: 'rule',
      concernsChild: looksLikeChildBusiness(item),
    };
    const { score, reasons } = scoreOf(base, item.audience, item.important, verdict);
    merged.push({
      ...base,
      score,
      tier,
      mustShow: tier === 'week',
      audience: item.audience,
      relevance: verdict,
      reasons: [
        ...reasons,
        // English, like every other reason in this file: `--explain` is a
        // maintainer's surface, not the page.
        item.important
          ? 'aula-important floor: no signal covered it'
          : tier === 'week'
            ? 'relevance:high floor: no signal covered it'
            : 'relevance:hide: hidden, no signal covered it',
      ],
      source: item,
      mergedSourceKeys: [],
    });
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
