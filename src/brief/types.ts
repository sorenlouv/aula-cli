/**
 * The vocabulary the brief is built from.
 *
 * Two ideas carry most of the weight here:
 *
 * `Audience` is how broadly something was addressed, and it is the primary
 * relevance axis — see `rank.ts`. It is computed from group membership, not
 * judged by a model, because "is this about one of my children" turns out to be
 * answerable from `groups[]` alone.
 *
 * `Signal` is a single thing worth knowing, always tied back to the
 * `SourceItem` it came from. Nothing reaches the page without a source, which
 * is what makes a generated summary checkable rather than merely plausible.
 */

/**
 * How narrowly something was addressed.
 *
 * - `child` — a message thread about one of my children, or their weekly plan.
 * - `class` — a group that is a child's *own* class or stue ("Myretuen", "2E").
 * - `institution` — their actual school or daycare, or a year band inside it
 *   ("Eksempelskolen …", "Indskoling …", "Børnehuset Eksemplet").
 * - `municipal` — across institutions: "Alle forældre alle skoler". Almost
 *   never about one of our children, and sorted low; hidden only when the
 *   family's list says so (see `Relevance`).
 *
 * `institution` is deliberately *not* lumped in with `municipal`. School photo
 * day is addressed to the whole school and matters; a municipal course offer is
 * addressed to the whole school and does not. Breadth alone cannot separate
 * those two — see `concernsChild`, which is what does.
 */
export type Audience = 'child' | 'class' | 'institution' | 'municipal';

export type SourceKind = 'post' | 'thread' | 'plan' | 'event' | 'album';

/** One turn in a message thread, as it is shown when the reader expands it. */
export type ConversationMessage = {
  from: string | null;
  at: string | null;
  text: string;
};

/**
 * A thread's messages, kept structured beside the flattened `text`.
 *
 * The extractors read `text` — one blob, cheapest thing to scan for
 * obligations — but a reader who opens a five-message exchange wants to see
 * who said what, in order. Both come from the same fetch, so keeping the
 * structure costs nothing and reconstructing it later would cost a round trip.
 *
 * `total` is Aula's own count and can exceed `messages.length`: `getThread`
 * pages, and the brief fetches one page. When it does, `truncated` is set and
 * the page says so rather than presenting a partial exchange as the whole
 * conversation.
 */
export type Conversation = {
  messages: ConversationMessage[];
  total: number;
  truncated: boolean;
};

/** One piece of Aula content, normalised so the extractors see one shape. */
export type SourceItem = {
  /** Stable and human-readable: `post:13311009`. Used as the citation key. */
  key: string;
  kind: SourceKind;
  title: string;
  /** The prose that gets scanned for obligations. */
  text: string;
  at: string | null;
  author: string | null;
  groups: string[];
  /** Children this concerns, resolved from `regarding`, groups or plan owner. */
  childNames: string[];
  audience: Audience;
  /** Aula's own `isImportant`. Almost always false, but load-bearing when set. */
  important: boolean;
  url: string | null;
  /** Threads only. What the more-block expands to on a thread. */
  conversation?: Conversation;
};

export type PresenceRow = {
  child: string;
  institution: string | null;
  statusDanish: string;
  plannedEntry: string | null;
  plannedExit: string | null;
};

/**
 * Something the reader must be told about the *fetch*, not the content.
 *
 * A vendor that 500s and a genuinely quiet week produce the same empty section,
 * and telling them apart is the difference between a brief that can be trusted
 * and one that cannot. These always reach the page.
 */
export type HealthNote = {
  level: 'ok' | 'warn';
  message: string;
};

export type BriefFamily = {
  children: Array<{
    name: string;
    firstName: string;
    institution: string;
    className: string | null;
    /** Planned times today, for the per-child cards. */
    presence: PresenceRow | null;
  }>;
  isSteppedUp: boolean;
};

export type BriefInput = {
  /** Local calendar day the brief describes, `YYYY-MM-DD`. */
  today: string;
  isoWeek: string;
  windowDays: number;
  family: BriefFamily;
  items: SourceItem[];
  health: HealthNote[];
  /** Album titles are warm, low-priority content; kept apart from `items`. */
  albums: Array<{ title: string; at: string | null; childNames: string[] }>;
  newMediaCount: number;
  /**
   * The family's own standing wishes for the overview, verbatim from
   * `~/.aula/preferences.md` — see `preferences.ts`. User-authored, which is
   * why they may travel in the prompt's instructions while Aula's own prose
   * stays on stdin.
   */
  preferences: string[];
};

/**
 * The model's verdict on one source, read in the light of the family's list.
 *
 * This is how `~/.aula/preferences.md` reaches the ranking. The list is prose
 * — *"beskeder fra John (Hjaltes far) er altid vigtige"*, *"jeg er ligeglad
 * med billeder"* — and prose is the model's to read, not a rule's: an earlier
 * version had `rank.ts` regex-matching sender names and negation words out of
 * the lines, and it floored a teacher called Hjalte on a wish about Hjalte's
 * father. So the model reads the list once per source and answers with one of
 * four words, and `rank.ts` acts on the word.
 *
 * Four words rather than a number on purpose: a model sorts into labelled
 * buckets far more consistently than it calibrates a 0–100 scale, and a score
 * that wobbles from run to run would make a good model day and a bad one
 * produce structurally different briefs. The fine ordering within a bucket is
 * the arithmetic's job.
 *
 * - `hide` — the list says this kind of thing is never wanted. Off the page,
 *   listed only in the muted foot — unless something worth extracting was found
 *   in it *and* that asks us for something about our own child, in which case
 *   it is demoted to the `context` tier instead. A wish to be spared municipal
 *   broadcasts is fair; applying it to "alle skoler er lukket på mandag" is
 *   not, and one verdict is one model's reading on one morning.
 * - `low` — the list says it matters less. At most the `context` tier, never
 *   a card.
 * - `normal` — the list is silent; content and breadth decide.
 * - `high` — the list says this matters to them (a named sender, a topic they
 *   asked for). Never below the `week` tier, and on the page even when nothing
 *   concrete could be extracted from it.
 *
 * Aula's own `important` flag beats `hide` and `low`: the school shouting is
 * not something a preference can mute.
 */
export type Relevance = 'hide' | 'low' | 'normal' | 'high';

export type SignalKind = 'action' | 'deadline' | 'event' | 'bring' | 'info' | 'social';

/** How soon it matters. The ranker turns this into placement. */
export type Urgency = 'now' | 'week' | 'later' | 'fyi';

export type Signal = {
  id: string;
  kind: SignalKind;
  /** Danish, imperative for actions. */
  title: string;
  /** First name, or null when it concerns everyone. */
  child: string | null;
  /** `YYYY-MM-DD` when there is a deadline or a date it happens. */
  dueAt: string | null;
  urgency: Urgency;
  /**
   * Verbatim from the source. Validated as a literal substring, which is the
   * cheapest guard against a confidently invented deadline.
   */
  quote: string | null;
  why: string | null;
  sourceKey: string;
  origin: 'rule' | 'model';
  /**
   * Does this ask something of us *about our own child*, as opposed to being an
   * offer we could opt into?
   *
   * This is what separates "tilmeld jeres barn til skolefoto" from "tilbud om
   * forældrekursus" when both are addressed to the whole school. Breadth sets
   * the ceiling; this decides whether an institution-wide message is allowed to
   * reach it.
   */
  concernsChild: boolean;
};

export type Tier = 'act' | 'week' | 'context' | 'hidden';

export type RankedSignal = Signal & {
  score: number;
  tier: Tier;
  /** Must appear in the rendered page; `validate.ts` enforces it. */
  mustShow: boolean;
  audience: Audience;
  /** The model's verdict on the source, `normal` when it gave none. */
  relevance: Relevance;
  /** Why it scored what it did — surfaced by `--explain`. */
  reasons: string[];
  source: SourceItem;
  /**
   * Other sources saying the same thing. The municipality sends its course
   * offers through every institution at once, and the same meeting arrives as
   * both an invitation and a reminder, so merging is the normal case.
   */
  mergedSourceKeys: string[];
};

export type RankedBrief = {
  input: BriefInput;
  signals: RankedSignal[];
  /** Sources that produced no signal at all, so nothing is silently lost. */
  unusedSources: SourceItem[];
  degraded: string[];
};
