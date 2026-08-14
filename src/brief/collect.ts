/**
 * Turns an Aula digest into the flat `BriefInput` the extractors read.
 *
 * The interesting work is `classifyAudience`. Everything else is shape-flattening.
 */

import type { AulaClient } from './../client.ts';
import { isoDate } from './../integrations/index.ts';
import {
  buildDigest,
  collectAlbums,
  type ChildGroups,
  loadGroups,
} from './../digest.ts';
import { resolveFamily } from './../family.ts';
import type {
  Audience,
  BriefInput,
  HealthNote,
  PresenceRow,
  SourceItem,
} from './types.ts';

const AULA_PORTAL = 'https://www.aula.dk/portal/#';

export type CollectOptions = {
  days: number;
  isoWeek: string;
  now?: Date;
};

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

export async function collect(client: AulaClient, opts: CollectOptions): Promise<BriefInput> {
  const now = opts.now ?? new Date();
  const family = await resolveFamily(client);

  const [digest, childGroups, albums, notifications] = await Promise.all([
    buildDigest(client, { days: opts.days, isoWeek: opts.isoWeek, family }),
    loadGroups(client, family.children).catch(() => [] as ChildGroups[]),
    collectAlbums(client, family, {
      limit: 12,
      since: new Date(now.getTime() - opts.days * 86_400_000),
    }).catch(() => []),
    client.getNotifications().catch(() => []),
  ]);

  // Badges are a terrible priority signal here — in the live account 152 of 159
  // were photo uploads — so the count is split rather than shown as one number.
  const newMediaCount = notifications.filter((n) => n.notificationEventType === 'NewMedia').length;

  const classGroupNames = new Set(
    childGroups.map((cg) => cg.className).filter((n): n is string => Boolean(n)),
  );
  const health: HealthNote[] = [];
  const items: SourceItem[] = [];

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
      authorRole: 'employee',
      groups: post.groups,
      childNames,
      audience: classifyAudience(post.groups, classGroupNames),
      important: post.important,
      url: `${AULA_PORTAL}/opslag`,
      attachments: post.attachments,
    });
  }

  // ---------------------------------------------------------------- threads
  for (const thread of digest.threads) {
    // A thread names the children it concerns outright, which is as specific as
    // Aula gets. Those are always `child`-level regardless of who sent them.
    const messages = thread.messages ?? [];
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
      authorRole: messages.at(-1)?.fromRole ?? null,
      groups: [],
      childNames: thread.regarding,
      audience: thread.regarding.length > 0 ? 'child' : 'class',
      important: thread.sensitive || thread.unread,
      url: `${AULA_PORTAL}/beskeder`,
      attachments: messages.flatMap((m) => m.attachments),
    });
  }

  // ------------------------------------------------------------ weekly plans
  for (const plan of digest.weeklyPlans) {
    for (const [index, entry] of plan.items.entries()) {
      const childName = entry.childName ?? null;
      items.push({
        key: `plan:${plan.provider}:${plan.isoWeek}:${index}`,
        kind: 'plan',
        title: entry.subject ?? 'Ugeplan',
        text: entry.content ?? '',
        at: entry.date ?? null,
        author: plan.provider,
        authorRole: 'employee',
        groups: [],
        childNames: childName ? [childName] : [],
        // A weekly plan is produced for one child's class; it is as specific as
        // content gets, and it is where "husk badetøj" lives.
        audience: 'child',
        important: false,
        url: `${AULA_PORTAL}/ugeplan`,
        attachments: [],
      });
    }
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
      author: event.createdBy,
      authorRole: 'employee',
      groups: [],
      childNames: event.children,
      audience: event.children.length > 0 ? 'child' : 'class',
      important: event.responseRequired,
      url: `${AULA_PORTAL}/kalender`,
      attachments: [],
    });
  }

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
      checkInTime: row.checkInTime,
      checkOutTime: row.checkOutTime,
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
    generatedAt: now.toISOString(),
    today: isoDate(now),
    isoWeek: opts.isoWeek,
    windowDays: opts.days,
    family: {
      guardian: family.guardian.name,
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
    albums: albums.map((album) => ({
      title: album.title,
      at: album.createdAt,
      groups: album.groups,
      childNames: childrenForGroups(album.groups, childGroups),
    })),
    notificationCount: digest.notificationCount,
    newMediaCount,
  };
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
