/**
 * Turns an Aula digest into the flat `BriefInput` the extractors read.
 *
 * The interesting work is `classifyAudience`. Everything else is shape-flattening.
 */

import type { AulaClient } from './../client.ts';
import {
  calendarWindow,
  loadPersonalEvents,
  PERSONAL_CALENDAR_DAYS,
  type PersonalEvent,
} from '../calendar/index.ts';
import { readConfig } from '../config.ts';
import { localIsoDate, type WeekPlan } from '../integrations/types.ts';
import { buildDigest, collectAlbums, type ChildGroups, loadGroups } from './../digest.ts';
import { resolveFamily } from './../family.ts';
import { loadPreferences } from './../preferences.ts';
import { intervalLabel } from './dates.ts';
import type { Audience, BriefInput, HealthNote, PresenceRow, SourceItem } from './types.ts';

const AULA_PORTAL = 'https://www.aula.dk/portal/#';

export type CollectOptions = {
  days: number;
  isoWeek: string;
  now?: Date;
};

/** How far back the brief reads. Every source in that window reaches the model. */
export const HISTORY_DAYS = 60;

/**
 * How narrowly a piece of content was addressed.
 *
 * The line is drawn at the child's **class group** — "Myretuen", "2E" — and not
 * at "a group my child belongs to", because every child also belongs to their
 * institution's catch-all group ("Børnehuset Eksemplet") and to umbrella groups
 * ("Regnbuen"). Using membership alone would classify a municipal offer sent to
 * the whole house as being about my child, which is exactly the noise this is
 * meant to remove.
 *
 * Measured against the live data this separates cleanly: "Myretuens løbedag"
 * (→ Myretuen) is `class`, while the forældrekursus offers (→ "Børnehuset
 * Eksemplet", → "Indskoling … 26-27") and the parent network (→ "Alle forældre
 * alle skoler") are all `broad`.
 */
export function classifyAudience(groups: string[], classGroupNames: Set<string>): Audience {
  const normalised = groups.map((g) => g.trim().toLowerCase());
  for (const name of classGroupNames) {
    if (normalised.includes(name.trim().toLowerCase())) return 'class';
  }
  // An unknown audience is not a municipal one. Aula omits `sharedWithGroups`
  // often enough that this matters, and `every` on an empty list would answer
  // yes — landing the post in the one tier the page never shows. Absence of
  // evidence has to fail towards showing school content, not hiding it.
  if (normalised.length === 0) return 'institution';
  // Cross-institution distribution lists. These reach every family in the
  // municipality and are never about one of our children.
  if (normalised.every((g) => MUNICIPAL.test(g))) return 'municipal';
  return 'institution';
}

/** "Alle forældre alle skoler", "Alle forældre i alle dagtilbud". */
const MUNICIPAL = /^alle\b|\balle (skoler|dagtilbud|institutioner)\b|\bkommune\b/i;

/** Children whose class group appears in the addressed groups. */
function childrenForGroups(groups: string[], childGroups: ChildGroups[]): string[] {
  const normalised = new Set(groups.map((g) => g.trim().toLowerCase()));
  return childGroups
    .filter((cg) => cg.className && normalised.has(cg.className.trim().toLowerCase()))
    .map((cg) => cg.child);
}

/** Flatten vendor plan entries into the same source shape as Aula content. */
export function sourcesFromPlans(plans: WeekPlan[]): SourceItem[] {
  const items: SourceItem[] = [];
  for (const plan of plans) {
    const dateOccurrences = new Map<string, number>();
    for (const [index, entry] of plan.items.entries()) {
      const childName = entry.childName ?? null;
      const identity = (() => {
        if (!entry.date) return `position:${index}`;
        const occurrence = dateOccurrences.get(entry.date) ?? 0;
        dateOccurrences.set(entry.date, occurrence + 1);
        return `date:${encodeURIComponent(entry.date)}:${occurrence}`;
      })();
      items.push({
        key: `plan:${plan.provider}:${plan.capability}:${plan.isoWeek}:${identity}`,
        kind: 'plan',
        title: entry.title ?? entry.subject ?? 'Ugeplan',
        text: [
          entry.subject ? `Fag/hold: ${entry.subject}` : null,
          entry.title ? `Titel: ${entry.title}` : null,
          entry.content,
          entry.kind ? `Type: ${planKindLabel(entry.kind)}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join('\n'),
        at: entry.date ?? null,
        author: plan.provider,
        groups: [],
        childNames: childName ? [childName] : [],
        // A weekly plan is produced for one child's class; it is as specific as
        // content gets, and it is where "husk badetøj" lives.
        audience: 'child',
        important: false,
        url: `${AULA_PORTAL}/ugeplan`,
      });
    }
  }
  return items;
}

function planKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    assignment: 'Aflevering',
    assignments: 'Afleveringer',
    comment: 'Kommentar',
    event: 'Begivenhed',
    note: 'Note',
    task: 'Opgave',
    'weekly-letter': 'Ugebrev',
  };
  return labels[kind] ?? kind;
}

export async function collect(client: AulaClient, opts: CollectOptions): Promise<BriefInput> {
  const now = opts.now ?? new Date();
  const family = await resolveFamily(client);

  const [digest, childGroups, albums] = await Promise.all([
    buildDigest(client, { days: opts.days, isoWeek: opts.isoWeek, family, now }),
    loadGroups(client, family.children).catch((): ChildGroups[] => []),
    collectAlbums(client, family, {
      limit: 12,
      since: new Date(now.getTime() - opts.days * 86_400_000),
    }).catch(() => []),
  ]);

  const classGroupNames = new Set(
    childGroups.map((cg) => cg.className).filter((n): n is string => Boolean(n)),
  );
  const health: HealthNote[] = [];
  const items: SourceItem[] = [];

  if (digest.collectionLimits.posts !== null) {
    health.push({
      level: 'warn',
      message: `Kun de nyeste ${digest.collectionLimits.posts} opslag blev læst.`,
    });
  }
  if (digest.collectionLimits.threads !== null) {
    health.push({
      level: 'warn',
      message: `Kun de nyeste ${digest.collectionLimits.threads} beskedtråde blev læst.`,
    });
  }

  // ------------------------------------------------------------------ posts
  for (const post of digest.posts) {
    const childNames = childrenForGroups(post.groups, childGroups);
    items.push({
      key: `post:${post.id}`,
      kind: 'post',
      title: post.title,
      text: post.text,
      at: post.publishedAt,
      author: post.author,
      groups: post.groups,
      childNames,
      audience: classifyAudience(post.groups, classGroupNames),
      important: post.important,
      url: `${AULA_PORTAL}/opslag`,
    });
  }

  // ---------------------------------------------------------------- threads
  for (const thread of digest.threads) {
    // A thread names the children it concerns outright, which is as specific as
    // Aula gets. Those are always `child`-level regardless of who sent them.
    //
    // Sorted oldest-first, and the same order feeds both the flattened `text`
    // the extractor reads and the exchange the reader expands: Aula's own order
    // is undocumented and `getThread` pages, so a conversation that reads
    // backwards on the page is a real possibility worth spending one sort on.
    // ISO 8601 sorts lexicographically; a message with no timestamp keeps its
    // place, since `sort` is stable.
    const messages = [...(thread.messages ?? [])]
      .filter((m) => m.text.trim().length > 0)
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    const body = messages
      .map((m) => `${m.from ?? 'ukendt'} (${m.fromRole ?? '?'}): ${m.text}`)
      .join('\n\n');
    items.push({
      key: `thread:${thread.id}`,
      kind: 'thread',
      title: thread.subject,
      // The subject carries real information in this data — "Møde ang. Alma
      // d. 18/9" is where the date lives — so it is prepended rather than left
      // for the caller to remember to read separately.
      text: `${thread.subject}\n\n${body}`,
      at: thread.lastMessageAt ?? thread.startedAt,
      author: thread.createdBy,
      groups: [],
      childNames: thread.regarding,
      audience: thread.regarding.length > 0 ? 'child' : 'class',
      important: thread.sensitive || thread.unread,
      url: `${AULA_PORTAL}/beskeder`,
      conversation: {
        messages: messages.map((m) => ({ from: m.from ?? null, at: m.at ?? null, text: m.text })),
        total: thread.totalMessageCount ?? messages.length,
        truncated: thread.moreMessagesExist || messages.length < (thread.totalMessageCount ?? 0),
      },
    });
  }

  // A thread whose messages could not be fetched still has its subject, so it
  // renders as a perfectly ordinary card with nothing in it — the one failure
  // that is invisible on the finished page. `withFullMessages` swallows the
  // error on purpose (one bad thread must not sink the digest), and this is
  // where that swallowed failure is turned back into something the reader is
  // told about.
  const unreadable = digest.threads.filter((t) => t.messagesUnavailable).map((t) => t.subject);
  if (unreadable.length > 0) {
    health.push({ level: 'warn', message: describeUnreadableThreads(unreadable) });
  }

  // ------------------------------------------------------------ weekly plans
  items.push(...sourcesFromPlans(digest.weeklyPlans));
  for (const plan of digest.weeklyPlans) {
    for (const warning of plan.warnings ?? []) {
      health.push({ level: 'warn', message: summariseWarning(warning) });
    }
  }

  // --------------------------------------------------------------- calendar
  for (const event of digest.calendar) {
    items.push({
      key: `event:${event.id}`,
      kind: 'event',
      title: event.title,
      text: [event.title, event.location, event.createdBy].filter(Boolean).join(' · '),
      at: event.start,
      endsAt: event.end,
      allDay: event.allDay,
      author: event.createdBy,
      groups: [],
      childNames: event.children,
      audience: event.children.length > 0 ? 'child' : 'class',
      important: event.responseRequired,
      url: `${AULA_PORTAL}/kalender`,
    });
  }

  // --------------------------------------------------- the family's own diary
  const personal = await collectPersonal(now);
  items.push(...personal.items);
  health.push(...personal.health);

  // ------------------------------------------------------------ presence map
  const presenceByChild = new Map<string, PresenceRow>();
  for (const row of digest.presence) {
    if (!row.child) continue;
    presenceByChild.set(row.child, {
      child: row.child,
      institution: row.institution,
      statusDanish: row.statusDanish,
      plannedEntry: row.plannedEntry,
      plannedExit: row.plannedExit,
    });
  }

  // ----------------------------------------------------------------- health
  if (digest.calendar.length === 0) {
    health.push({
      level: 'ok',
      message:
        'Aula-kalenderen er tom for perioden, så alle aftaler her er læst ud af beskeder og opslag.',
    });
  }
  if (!family.isSteppedUp) {
    health.push({
      level: 'warn',
      message:
        'Sessionen er ikke step-up-godkendt, så følsomme beskeder mangler. Kør `aula refresh-stepup`.',
    });
  }
  const attention = digest.attention;
  if (
    attention.importantPosts.length === 0 &&
    attention.unreadThreads.length === 0 &&
    attention.eventsAwaitingResponse.length === 0
  ) {
    health.push({
      level: 'ok',
      message:
        'Aulas egne markeringer var tomme (0 vigtige opslag, 0 ulæste, 0 der kræver svar) — prioriteringen bygger på indholdet.',
    });
  }

  const className = new Map(childGroups.map((cg) => [cg.child, cg.className]));

  return {
    // Local, not UTC: the rules layer dates deadlines against the Danish
    // calendar, and a run just after midnight would otherwise head the page
    // with yesterday and republish over yesterday's archive.
    today: localIsoDate(now),
    isoWeek: opts.isoWeek,
    windowDays: opts.days,
    family: {
      children: family.children.map((child) => ({
        name: child.name,
        firstName: child.name.split(' ')[0] ?? child.name,
        institution: child.institutionName,
        className: className.get(child.name) ?? null,
        presence: presenceByChild.get(child.name) ?? null,
      })),
      isSteppedUp: family.isSteppedUp,
    },
    items,
    health,
    // Local, user-owned and never fetched — the one part of the input that does
    // not come from Aula. Seeded with this tool's own opinions on first use, so
    // they can be argued with rather than only obeyed.
    preferences: loadPreferences(),
    albums: albums.map((album) => ({
      title: album.title,
      at: album.createdAt,
      childNames: childrenForGroups(album.groups, childGroups),
    })),
  };
}

/**
 * One line, however many threads failed.
 *
 * Naming the thread is the useful half — it is what tells the reader which
 * conversation they still have to open Aula for. But this failure is usually
 * systemic (a session that expired mid-run, Aula answering 403) and takes every
 * thread with it at once, and forty warnings naming forty subjects is not a
 * status panel anybody reads. So the count is always exact and the names run
 * out before the line does.
 */
function describeUnreadableThreads(subjects: string[]): string {
  const named = subjects
    .slice(0, 2)
    .map((s) => `«${s}»`)
    .join(' og ');
  if (subjects.length === 1) {
    return `Beskederne i tråden ${named} kunne ikke hentes — kun emnet er med her.`;
  }
  // "heriblandt" only where the names really are a sample. Naming both of two
  // and calling it *among others* is exactly the small lie this panel exists
  // to avoid.
  const lead = subjects.length > 2 ? 'heriblandt' : 'nemlig';
  return `Beskederne i ${subjects.length} tråde kunne ikke hentes — kun emnerne er med her, ${lead} ${named}.`;
}

/**
 * Vendor errors arrive as an entire HTML error page. Kept to one readable line,
 * because this text is going in front of a human on the finished brief.
 */
function summariseWarning(warning: string): string {
  const flattened = warning.replace(/\s+/g, ' ').trim();
  const match = /^(.*?):\s*(\S+) answered (\d{3})/.exec(flattened);
  if (match) {
    const [, who, host, status] = match;
    return `Ugeplan for ${who} kunne ikke hentes — ${host} svarede HTTP ${status}.`;
  }
  return flattened.length > 160 ? `${flattened.slice(0, 159)}…` : flattened;
}

/**
 * The family's own appointments, as sources.
 *
 * Opt-in only: a fresh installation has no configured calendars and reads no
 * appointments. `aula calendars` lists names, and `calendars set` records the
 * exact calendars the parent chose.
 *
 * **They are shown, not analysed.** An appointment becomes a dated item like
 * any other; the page folds the lot into one collapsed *Egen kalender* whose
 * summary names today's and any that share a day with a card (see
 * `calendarSection` in `render.ts`). This puts the facts beside each other for
 * the reader; code never infers a clash or the absence of one.
 *
 * The page also never reports the *absence* of a clash. A reassurance is a
 * claim, it would be made every quiet week, and it would train the reader to
 * skim the section that matters on the week it is wrong.
 *
 * Everything here degrades. A calendar that cannot be read becomes a warning on
 * the page, never an exception and never an empty fortnight — the same rule as
 * a vendor's ugeplan answering 500, and for the same reason: a missing
 * appointment that looks like a free afternoon is the worst thing this feature
 * could do.
 */
async function collectPersonal(now: Date): Promise<{ items: SourceItem[]; health: HealthNote[] }> {
  const calendars = readConfig().calendars ?? [];
  if (calendars.length === 0) return { items: [], health: [] };

  // Aula history may be widened with `new --days`; private calendar data may
  // not. Every occurrence in this bounded window becomes one model-ranked
  // source, keeping prompt size and connector pagination predictable.
  const { from, to } = calendarWindow(now, PERSONAL_CALENDAR_DAYS);
  const loaded = await loadPersonalEvents(calendars, { from, to });

  const health: HealthNote[] = loaded.warnings.map((message) => ({ level: 'warn', message }));
  if (loaded.notConnected) {
    const warning = health[0];
    if (warning) warning.message += ' Kør `aula calendars` for at komme videre.';
  } else if (loaded.warnings.length === 0) {
    // What was read, in the footer that already says what was fetched — about
    // the fetch, like every other line there, and never about the week.
    const names = calendars.map((c) => `«${c.name}»`).join(' og ');
    health.push({
      level: 'ok',
      message: `Egen kalender: ${names} blev læst (${loaded.events.length} aftaler i perioden).`,
    });
  }

  return { items: loaded.events.map(toPersonalSourceItem), health };
}

/**
 * One appointment as a source, so it travels the same road as everything else —
 * ranked, marked `NY`, tickable — instead of needing a set of rules of its own.
 *
 * For a calendar entry the time *is* half of what it says, so it goes into
 * `text` for the model in words. The title stays bare: the page writes the time
 * itself from `at`/`endsAt`/`allDay`, once as a row and once, start time only,
 * in the fold's summary — and a title carrying "kl. 13:30–14:15" could not be
 * shortened to "Tandlæge 13:30" without parsing our own sentence back apart.
 */
export function toPersonalSourceItem(event: PersonalEvent): SourceItem {
  return {
    key: event.key,
    kind: 'personal',
    title: event.title,
    text: [
      event.title,
      personalWhen(event),
      event.location,
      `Fra kalenderen «${event.calendarName}»`,
    ]
      .filter(Boolean)
      .join(' · '),
    // Local and naive on purpose: the ranker turns this into a Danish calendar
    // day, and an all-day event has no instant to be faithful to.
    at: `${event.date}T${event.startTime ?? '00:00'}:00`,
    endsAt: `${event.endDate}T${event.endTime ?? '23:59'}:00`,
    allDay: event.allDay,
    author: event.calendarName,
    groups: [],
    // Nothing here says which child an appointment is about. Guessing from the
    // title would be a regex over prose the family wrote — the mistake
    // `rank.ts` already made once, on a wish about Hjalte's father.
    childNames: [],
    audience: 'family',
    important: false,
    url: event.url,
  };
}

/** The time in words, for the model's copy of the appointment. */
function personalWhen(event: PersonalEvent): string {
  return intervalLabel({
    startDay: event.date,
    endDay: event.endDate,
    startTime: event.startTime,
    endTime: event.endTime,
    allDay: event.allDay,
  });
}
