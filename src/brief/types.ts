/**
 * The vocabulary the brief is built from.
 *
 * Two ideas carry most of the weight here:
 *
 * `Audience` is how broadly something was addressed — one of the relevance cues
 * the model is given. It is computed from group membership, not judged, because
 * "is this about one of my children" turns out to be answerable from `groups[]`
 * alone.
 *
 * `Card` is a single thing worth knowing or doing, always tied back to the
 * `SourceItem`s it came from. Nothing reaches the page without a source, which
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
 *   never about one of our children.
 *
 * `institution` is deliberately *not* lumped in with `municipal`. School photo
 * day is addressed to the whole school and matters; a municipal course offer is
 * addressed to the whole school and does not. Breadth alone cannot separate
 * those two; the model is told so in as many words and reads the content.
 *
 * `family` is the one value that does not come from Aula at all: an appointment
 * out of the family's own calendar, addressed to nobody because they wrote it
 * themselves. Those never become cards — the page lists them in a fold of their
 * own — but the model reads them to understand the week.
 */
export type Audience = 'child' | 'class' | 'institution' | 'municipal' | 'family';

export type SourceKind = 'post' | 'thread' | 'plan' | 'event' | 'album' | 'personal';

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
  /** End of an interval when the source describes one; absent for point-in-time content. */
  endsAt?: string | null;
  /**
   * Calendar-shaped sources only — Aula's events and the family's own: the
   * entry has no clock time, so `at` and `endsAt` name days rather than
   * instants. The page renders "hele dagen" from this instead of a midnight.
   */
  allDay?: boolean;
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
 * One thing the reader should know or do — the unit the page is made of.
 *
 * The model writes these finished: a title, a summary that stands without the
 * source, the day to sort it by, whether it asks something of the family, and
 * the sources it rests on. A card may gather several sources that say the same
 * thing — the July post with the date and the August message with the news
 * are one card — and the page lists every one of them under *Læs mere*.
 *
 * The rules layer makes the same shape without a model: title from the source,
 * the matched sentence as the summary. It is the fallback and the floor, never
 * a peer — where the model has spoken, its cards are the cards.
 */
export type Card = {
  id: string;
  /** Danish. Names the child; imperative when something must be done. */
  title: string;
  /**
   * One to three sentences that say the thing without the source. A rule-made
   * card quotes the matched sentence verbatim here; it has nothing else to say.
   */
  summary: string;
  /** First names. Empty when it concerns every child, or none in particular. */
  children: string[];
  /**
   * `YYYY-MM-DD` — the deadline when there is one, else the day it happens.
   * The page sorts on it; a day that has passed lands under *Tidligere*.
   */
  date: string | null;
  /** Something the family must do, not merely know. Drawn with emphasis. */
  needsAction: boolean;
  /** Why the card is on the page. Shown under *Læs mere*, never on the card. */
  reason: string | null;
  /** Keys into `BriefInput.items`; at least one. */
  sourceKeys: string[];
  origin: 'rule' | 'model';
};

/**
 * Where a card sits on the page. Decided by the date alone, in code: the model
 * chooses the cards and says what they are; it never orders the page.
 */
export type Placement = 'upcoming' | 'undated' | 'past';

export type RankedCard = Card & {
  placement: Placement;
  sources: SourceItem[];
  /** Why it sits where it does — `--explain`. */
  reasons: string[];
};

export type RankedBrief = {
  input: BriefInput;
  /** The cards, in page order: upcoming by date, then undated, then past. */
  cards: RankedCard[];
  /**
   * Cards over `CARD_CAP`, least pressing first. Listed in the fold with their
   * title and summary — demoted, never dropped.
   */
  folded: RankedCard[];
  /** Sources no card covers and the model did not hide: the fold. */
  rest: SourceItem[];
  /** Sources the model hid — the family's list, or plain irrelevance. Named in the muted foot. */
  hidden: SourceItem[];
  degraded: string[];
};
