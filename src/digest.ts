/**
 * The data layer: fetching, paging and normalising, with no opinion about how
 * any of it is displayed.
 *
 * This used to live inside `cli.ts`, which was fine while the CLI was the only
 * consumer. `brief/` is the second one, and it cannot import from `cli.ts` —
 * that module runs `main()` at import time. So the collectors and normalisers
 * live here, and `cli.ts` keeps the argument parsing and the renderers.
 */

import { type AulaClient, CALENDAR_MAX_SPAN_DAYS } from './client.ts';
import { mapLimit, presenceStatus, presenceStatusDanish, startOfDay } from './cli-helpers.ts';
import {
  integrationContext,
  postIdsFor,
  resolveFamily,
  selectChildren,
  type Family,
} from './family.ts';
import { htmlToText, preview } from './html.ts';
import {
  CAPABILITIES,
  NoProviderError,
  readCapability,
  readWidget,
  type WeekPlan,
} from './integrations/index.ts';
import type {
  Album,
  Attachment,
  CalendarEvent,
  Message,
  Post,
  PresenceEntry,
  ThreadDetail,
  ThreadSummary,
} from './types.ts';
import { errorMessage } from './validation.ts';
import { addLocalDays } from './integrations/types.ts';
import { type Capability, WidgetTokens } from './widgets.ts';

// -------------------------------------------------------------- weekly plans

export type PlanOptions = {
  isoWeek: string;
  child?: string;
  widget?: string;
  fromDate?: string;
  toDate?: string;
};

export async function readPlans(
  client: AulaClient,
  family: Family,
  opts: PlanOptions & { capability: Capability },
  // Shared by `readManyPlans` so several capabilities served by one widget
  // cost one token, not one each.
  tokens: WidgetTokens = new WidgetTokens(client),
): Promise<WeekPlan[]> {
  const ctx = integrationContext(family, {
    children: selectChildren(family, opts.child),
    isoWeek: opts.isoWeek,
    ...(opts.fromDate ? { fromDate: opts.fromDate } : {}),
    ...(opts.toDate ? { toDate: opts.toDate } : {}),
  });
  if (opts.widget) return [await readWidget(opts.widget, ctx, tokens, client.cache)];
  return readCapability(opts.capability, family.widgets, ctx, tokens, client.cache);
}

/**
 * Several capabilities at once, tolerating the ones this family has no widget
 * for. `homework` asks three vendors the same question and most families have
 * exactly one of them; a hard failure on the other two would make the command
 * useless for everybody.
 */
export async function readManyPlans(
  client: AulaClient,
  family: Family,
  capabilities: Capability[],
  opts: PlanOptions,
): Promise<WeekPlan[]> {
  const tokens = new WidgetTokens(client);
  const results = await Promise.all(
    capabilities.map(async (capability) => {
      try {
        return await readPlans(client, family, { ...opts, capability }, tokens);
      } catch (err) {
        // A capability this family has no widget for is the normal case, not a
        // failure — `homework` asks three vendors and most families have one.
        if (err instanceof NoProviderError) return [];
        // Anything else is a vendor that broke, and it used to vanish here: a
        // stderr warning nobody reads plus an empty array, so the digest JSON
        // that the skill and the brief both consume looked exactly like a
        // family with no weekly plan. It has to survive into the payload, so
        // the failure is reported rather than rendered as a quiet empty week.
        const message = errorMessage(err);
        process.emitWarning(`${capability}: ${message}`);
        const failed: WeekPlan = {
          provider: 'unavailable',
          capability,
          widgetId: '',
          isoWeek: opts.isoWeek,
          items: [],
          warnings: [`${capability} kunne ikke hentes: ${message}`],
        };
        return [failed];
      }
    }),
  );
  return results.flat();
}

// --------------------------------------------------------------- groups

export type ChildGroups = {
  child: string;
  childId: number;
  className: string | null;
  classGroupId: number | null;
  groups: Array<{ id: number; name: string }>;
};

/**
 * A child's class is not labelled as such in the group list. Aula puts the
 * class *name* on the child's institution profile as `metadata` ("2BA"), and
 * the class is whichever group has that name — so the two have to be joined.
 * `mainGroup` is a fallback for institutions that set it.
 */
export async function loadGroups(
  client: AulaClient,
  children: Family['children'],
): Promise<ChildGroups[]> {
  const contexts = await client.getGroupsByContext(children.map((c) => c.id));
  const byProfileId = new Map(contexts.map((c) => [c.profileId, c]));

  return children.map((child) => {
    const groups = (byProfileId.get(child.profileId)?.groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
    }));
    const className = child.institutionProfile?.metadata ?? child.mainGroupName ?? null;
    const classGroup =
      (className && groups.find((g) => g.name === className)) ||
      (byProfileId.get(child.profileId)?.groups ?? []).find((g) => g.mainGroup) ||
      null;
    return {
      child: child.name,
      childId: child.id,
      className: className ?? classGroup?.name ?? null,
      classGroupId: classGroup?.id ?? null,
      groups,
    };
  });
}

// ------------------------------------------------------------------- digest

export type DigestOptions = {
  days: number;
  limit?: number;
  isoWeek: string;
  child?: string;
  now?: Date;
  /**
   * Supplied by the brief pipeline, which has already resolved the family for
   * its own group lookups and should not pay to resolve it twice.
   */
  family?: Family;
};

type LimitTracker = { hit: boolean };

type RecoveredRead<T> = { value: T; warning: string | null };

async function recoverRead<T>(
  label: string,
  read: Promise<T>,
  fallback: T,
): Promise<RecoveredRead<T>> {
  try {
    return { value: await read, warning: null };
  } catch (err) {
    return { value: fallback, warning: `${label} kunne ikke hentes: ${errorMessage(err)}` };
  }
}

export async function buildDigest(client: AulaClient, opts: DigestOptions) {
  const family = opts.family ?? (await resolveFamily(client));
  const now = opts.now ?? new Date();
  // Resolved once and up front: `--child` has to reach all six reads below, and
  // the bug this replaced was one of them quietly not getting it.
  const children = selectChildren(family, opts.child);
  const since = addLocalDays(now, -opts.days);
  // The date window is the default bound. A row-count limit exists only when
  // the caller explicitly asks for one; otherwise a busy 60-day period must
  // not lose sources merely because it crossed an estimated daily average.
  const historyLimit = opts.limit;
  const threadLimit: LimitTracker = { hit: false };
  const postLimit: LimitTracker = { hit: false };

  const threadSummaries = collectThreads(client, {
    ...(historyLimit !== undefined ? { limit: historyLimit } : {}),
    limitTracker: threadLimit,
    since,
    unreadOnly: false,
    family,
    ...(opts.child ? { child: opts.child } : {}),
  });
  // Start the per-thread detail reads as soon as the summaries resolve. They
  // are normally the slowest part of a digest and need not wait for calendar,
  // presence or vendor reads to finish first.
  const threads = threadSummaries.then((summaries) => withFullMessages(client, summaries));

  const [fullThreads, posts, calendarRead, presenceRead, plans] = await Promise.all([
    threads,
    collectPosts(client, family, {
      ...(historyLimit !== undefined ? { limit: historyLimit } : {}),
      limitTracker: postLimit,
      since,
      ...(opts.child ? { child: opts.child } : {}),
    }),
    recoverRead(
      'Aula-kalenderen',
      loadCalendar(client, family, {
        // `days` is primarily the digest's history window. Calendar is forward-
        // looking and Aula accepts at most 50 days per request, so a 90-day
        // message digest must not become a 90-day calendar request.
        days: Math.min(Math.max(opts.days, 21), CALENDAR_MAX_SPAN_DAYS),
        now,
        ...(opts.child ? { child: opts.child } : {}),
      }),
      [],
    ),
    recoverRead('Komme/gå-status', client.getDailyPresence(children.map((c) => c.id)), []),
    // The vendors are third parties and go down independently of Aula. A dead
    // weekly-plan API must not cost the user their messages and calendar, so the
    // digest degrades to a warning rather than failing.
    readManyPlans(client, family, [...CAPABILITIES], {
      isoWeek: opts.isoWeek,
      ...(opts.child ? { child: opts.child } : {}),
    }),
  ]);
  const events = calendarRead.value;
  const presence = presenceRead.value;
  const fetchWarnings = [calendarRead.warning, presenceRead.warning].filter(
    (warning): warning is string => warning !== null,
  );

  // Structured signals so the summariser has something better than vibes to
  // rank on. The actual judgement of "is this important to me" stays with the
  // model — this only surfaces what Aula itself flags.
  const nowMs = now.getTime();
  const attention = {
    unreadThreads: fullThreads
      .filter((t) => t.unread)
      .map((t) => ({ id: t.id, subject: t.subject })),
    sensitiveThreads: fullThreads
      .filter((t) => t.sensitive)
      .map((t) => ({ id: t.id, subject: t.subject })),
    importantPosts: posts.filter((p) => p.important).map((p) => ({ id: p.id, title: p.title })),
    eventsAwaitingResponse: events
      .filter((e) => e.responseRequired && e.responseStatus !== 'accepted')
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        responseStatus: e.responseStatus,
        responseDeadline: e.responseDeadline,
      })),
    eventsWithinSevenDays: events
      .filter((e) => {
        const start = Date.parse(e.start);
        return Number.isFinite(start) && start >= nowMs && start <= addLocalDays(now, 7).getTime();
      })
      .map((e) => ({ id: e.id, title: e.title, start: e.start, child: e.children })),
  };

  return {
    generatedAt: now.toISOString(),
    window: { from: since.toISOString(), to: now.toISOString(), days: opts.days },
    week: opts.isoWeek,
    // Stated rather than implied: a digest narrowed to one child otherwise
    // looks exactly like a family that has only one, and a summariser reading
    // it has no way to tell that it is not seeing everything.
    scope: { child: opts.child ?? null, children: children.map((c) => c.name) },
    family: {
      guardian: family.guardian.name,
      children: children.map((c) => ({
        name: c.name,
        shortName: c.shortName,
        institution: c.institutionName,
      })),
      sessionIsSteppedUp: family.isSteppedUp,
      widgets: family.widgets.map((w) => `${w.widgetId} ${w.name}`),
    },
    attention,
    threads: fullThreads,
    posts,
    calendar: events,
    weeklyPlans: plans,
    presence: presence.map(normalisePresence),
    fetchWarnings,
    calendarAvailable: calendarRead.warning === null,
    collectionLimits: {
      posts: postLimit.hit ? (historyLimit ?? null) : null,
      threads: threadLimit.hit ? (historyLimit ?? null) : null,
    },
  };
}

// ------------------------------------------------------------------ fetching

export type ThreadFilter = {
  limit?: number;
  limitTracker?: LimitTracker;
  since?: Date;
  unreadOnly: boolean;
  child?: string;
  family: Family;
};

/** Walks the thread pages until the limit or the date window is satisfied. */
export async function collectThreads(
  client: AulaClient,
  filter: ThreadFilter,
): Promise<ThreadSummary[]> {
  const wanted = selectChildren(filter.family, filter.child);
  const wantedProfileIds = new Set(wanted.map((c) => c.profileId));
  const restrictToChild = filter.child !== undefined;

  const collected: ThreadSummary[] = [];
  const seen = new Set<number>();
  for (let page = 0; ; page++) {
    const { threads, moreMessagesExist } = await client.getThreads(page);
    if (threads.length === 0) {
      if (moreMessagesExist)
        throw new Error(`Aula returned an empty thread page ${page} with more=true.`);
      break;
    }

    let pageWentPastWindow = false;
    let newRows = 0;
    for (const thread of threads) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      newRows++;
      const at = threadTimestamp(thread);
      if (filter.since && at && at < filter.since) {
        pageWentPastWindow = true;
        continue;
      }
      if (filter.unreadOnly && thread.read) continue;
      if (
        restrictToChild &&
        !(thread.regardingChildren ?? []).some((c) => wantedProfileIds.has(c.profileId))
      ) {
        continue;
      }
      collected.push(thread);
      // Read one qualifying row past the cap so a caller can distinguish a
      // genuinely complete N-row window from a silently truncated one.
      if (filter.limit !== undefined && collected.length > filter.limit) {
        if (filter.limitTracker) filter.limitTracker.hit = true;
        return collected.slice(0, filter.limit);
      }
    }

    if (!moreMessagesExist) break;
    if (newRows === 0) throw new Error(`Aula repeated thread page ${page} with more=true.`);
    // Threads come back newest-first, so once a whole page is older than the
    // window there is nothing useful further back.
    if (filter.since && pageWentPastWindow) break;
  }
  return collected;
}

export async function collectPosts(
  client: AulaClient,
  family: Family,
  opts: {
    limit?: number;
    limitTracker?: LimitTracker;
    since?: Date;
    important?: boolean;
    child?: string;
  },
) {
  const pageSize = 10;
  const collected: Post[] = [];
  // Aula filters posts by the id set you ask with, so narrowing to one child is
  // done here rather than by discarding rows afterwards. See `postIdsFor`.
  const institutionProfileIds = postIdsFor(family, selectChildren(family, opts.child));

  const seen = new Set<number>();
  for (let index = 0; ; index += pageSize) {
    const { posts, hasMorePosts } = await client.getPosts({
      institutionProfileIds,
      index,
      limit: pageSize,
      isImportant: opts.important ?? false,
    });
    if (posts.length === 0) {
      if (hasMorePosts)
        throw new Error(`Aula returned an empty post page ${index} with more=true.`);
      break;
    }

    let wentPastWindow = false;
    let newRows = 0;
    for (const post of posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      newRows++;
      const at = Date.parse(post.publishAt ?? post.timestamp ?? '');
      if (opts.since && Number.isFinite(at) && at < opts.since.getTime()) {
        wentPastWindow = true;
        continue;
      }
      collected.push(post);
      if (opts.limit !== undefined && collected.length > opts.limit) {
        if (opts.limitTracker) opts.limitTracker.hit = true;
        return collected.slice(0, opts.limit).map(normalisePost);
      }
    }

    if (!hasMorePosts) break;
    if (newRows === 0) throw new Error(`Aula repeated post page ${index} with more=true.`);
    if (opts.since && wentPastWindow) break;
  }
  return collected.map(normalisePost);
}

/**
 * Photo albums, newest first.
 *
 * Unlike `collectPosts` this pages the whole list before applying `--since` or
 * `--limit`, which looks wasteful and is not. Aula sorts albums on
 * `mediaCreatedAt`, a field it never returns, so the rows arrive in an order
 * that only loosely tracks the one date the payload *does* carry: in the live
 * data an album from 29 July sits above one from 4 August. Stopping at the
 * first row older than the window — the trick `collectPosts` can afford — would
 * therefore silently drop albums that belong in it. The whole history is under
 * a hundred rows, so two requests buy correctness outright.
 */
export async function collectAlbums(
  client: AulaClient,
  family: Family,
  opts: { limit: number; since?: Date; child?: string },
) {
  const pageSize = 100;
  const children = selectChildren(family, opts.child);
  const childInstitutionProfileIds = children.map((c) => c.id);
  const collected: Album[] = [];
  const seen = new Set<number>();

  for (let index = 0; ; index += pageSize) {
    const page = await client.getAlbums({ childInstitutionProfileIds, index, limit: pageSize });
    // The synthetic "Medier af dig og dine børn" row has no id and no date, and
    // is not an album — it is a saved search over tagged media.
    let newRows = 0;
    for (const album of page) {
      if (album.id == null || seen.has(album.id)) continue;
      seen.add(album.id);
      collected.push(album);
      newRows++;
    }
    if (page.length < pageSize) break;
    if (newRows === 0) throw new Error(`Aula repeated album page ${index}.`);
  }

  return collected
    .filter((a) => {
      if (!opts.since) return true;
      const at = Date.parse(a.creationDate ?? '');
      return !Number.isFinite(at) || at >= opts.since.getTime();
    })
    .map(normaliseAlbum)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, opts.limit);
}

export async function loadCalendar(
  client: AulaClient,
  family: Family,
  opts: { days: number; child?: string; now?: Date },
) {
  const children = selectChildren(family, opts.child);
  const start = startOfDay(opts.now ?? new Date());
  const end = addLocalDays(start, opts.days);
  const events = await client.getCalendarEvents({
    childInstitutionProfileIds: children.map((c) => c.id),
    start,
    end,
  });

  const nameById = new Map(family.children.map((c) => [c.id, c.name]));
  return events
    .map((e) => normaliseEvent(e, nameById))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function emptyMessages(): Array<ReturnType<typeof normaliseMessage>> {
  return [];
}

export async function withFullMessages(client: AulaClient, threads: ThreadSummary[]) {
  const details = await mapLimit(threads, 4, async (thread) => {
    try {
      return await readFullThread(client, thread.id);
    } catch (err) {
      // One unreadable thread should not sink a whole digest.
      process.emitWarning(`Could not load thread ${thread.id}: ${errorMessage(err)}`);
      return null;
    }
  });

  return threads.map((thread, i) => {
    const base = normaliseThread(thread);
    const detail = details[i];
    // Both branches carry the same keys on purpose: a caller reading
    // `totalMessageCount` should not have to narrow a union first, and
    // `messagesUnavailable` is more useful as a boolean than as a field that
    // is sometimes simply absent.
    if (!detail) {
      return {
        ...base,
        totalMessageCount: undefined,
        moreMessagesExist: false,
        messages: emptyMessages(),
        messagesUnavailable: true,
        messagesIncomplete: false,
        messageReadWarning: null,
      };
    }
    return {
      ...base,
      totalMessageCount: detail.totalMessageCount,
      moreMessagesExist: detail.incomplete,
      messages: (detail.messages ?? []).map(normaliseMessage),
      messagesUnavailable: false,
      messagesIncomplete: detail.incomplete,
      messageReadWarning: detail.warning,
    };
  });
}

const MAX_THREAD_DETAIL_PAGES = 100;

export type FullThreadDetail = ThreadDetail & {
  /** True only when Aula claimed there was another page we could not read. */
  incomplete: boolean;
  warning: string | null;
};

/**
 * Read and merge every page of one thread.
 *
 * The first-page failure still throws because there is no body to return. A
 * later-page failure preserves the messages already read and marks the result
 * incomplete, allowing the brief to stay useful without claiming completeness.
 */
export async function readFullThread(
  client: AulaClient,
  threadId: number,
  maxPages = MAX_THREAD_DETAIL_PAGES,
): Promise<FullThreadDetail> {
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new RangeError('maxPages must be positive');
  let first: ThreadDetail | null = null;
  const messages = new Map<string, Message>();

  for (let page = 0; page < maxPages; page++) {
    let detail: ThreadDetail;
    try {
      detail = await client.getThread(threadId, page);
    } catch (err) {
      if (!first) throw err;
      return {
        ...first,
        messages: [...messages.values()],
        totalMessageCount: first.totalMessageCount ?? messages.size,
        moreMessagesExist: true,
        incomplete: true,
        warning: `side ${page + 1} kunne ikke hentes: ${errorMessage(err)}`,
      };
    }
    first ??= detail;
    const before = messages.size;
    for (const message of detail.messages ?? []) messages.set(message.id, message);
    if (!detail.moreMessagesExist) {
      const total = detail.totalMessageCount ?? first.totalMessageCount ?? messages.size;
      const missing = total > messages.size;
      return {
        ...first,
        messages: [...messages.values()],
        totalMessageCount: total,
        moreMessagesExist: missing,
        incomplete: missing,
        warning: missing
          ? `Aula oplyste ${total} beskeder, men leverede kun ${messages.size}`
          : null,
      };
    }
    if (messages.size === before) {
      return {
        ...first,
        messages: [...messages.values()],
        totalMessageCount: detail.totalMessageCount ?? first.totalMessageCount ?? messages.size,
        moreMessagesExist: true,
        incomplete: true,
        warning: `side ${page + 1} gentog de samme beskeder`,
      };
    }
  }

  if (!first) throw new Error(`Thread ${threadId} returned no page.`);
  return {
    ...first,
    messages: [...messages.values()],
    totalMessageCount: first.totalMessageCount ?? messages.size,
    moreMessagesExist: true,
    incomplete: true,
    warning: `sikkerhedsgrænsen på ${maxPages} sider blev nået`,
  };
}

// --------------------------------------------------------------- normalising

export function normaliseThread(thread: ThreadSummary) {
  return {
    id: thread.id,
    subject: thread.subject?.trim() || '(no subject)',
    unread: !thread.read,
    sensitive: Boolean(thread.sensitive),
    muted: Boolean(thread.muted),
    startedAt: thread.startedTime ?? null,
    lastMessageAt: thread.latestMessage?.sendDateTime ?? null,
    institution: thread.institutionCode ?? null,
    regarding: (thread.regardingChildren ?? [])
      .map((c) => c.displayName)
      .filter((n): n is string => Boolean(n)),
    createdBy: thread.creator?.fullName ?? null,
    // Aula truncates this in list responses; use the fetched `messages` beside it for real text.
    latestMessagePreview: preview(htmlToText(thread.latestMessage?.text?.html)),
  };
}

export function normaliseMessage(message: Message) {
  return {
    id: message.id,
    at: message.sendDateTime,
    from: message.sender?.fullName ?? null,
    fromRole: message.sender?.mailBoxOwner?.portalRole ?? null,
    type: message.messageType ?? 'Message',
    text: htmlToText(message.text?.html),
    attachments: normaliseAttachments(message.attachments),
  };
}

export function normalisePost(post: Post) {
  return {
    id: post.id,
    title: post.title?.trim() || '(no title)',
    publishedAt: post.publishAt ?? post.timestamp ?? null,
    expiresAt: post.expireAt ?? null,
    important: Boolean(post.isImportant),
    author: post.ownerProfile?.fullName ?? null,
    institution: post.ownerProfile?.institutionCode ?? null,
    groups: (post.sharedWithGroups ?? []).map((g) => g.name).filter((n): n is string => Boolean(n)),
    commentCount: post.commentCount ?? 0,
    text: htmlToText(post.content?.html),
    attachments: normaliseAttachments(post.attachments),
  };
}

/**
 * The signed thumbnail URLs are deliberately dropped. They are the bulk of the
 * payload, they expire within the day, and the point of reading galleries here
 * is the caption and the date — "Tur til stranden", 11 Aug — not the picture.
 *
 * No photo count either, tempting as `thumbnailsUrls.length` looks: it is a
 * capped cover preview, not a count. Every real album returns exactly one
 * regardless of how many photos it holds, so publishing it as a count would
 * mean "1 photo" on an album of twelve. The true figure exists only in
 * `gallery.getMedia`, which is a request per album for a number this command
 * does not need.
 */
export function normaliseAlbum(album: Album) {
  const createdAt = /^\d{4}-\d{2}-\d{2}/.exec(album.creationDate ?? '')?.[0] ?? null;
  return {
    id: album.id ?? null,
    title: album.title?.trim() || '(untitled)',
    createdAt,
    description: album.description?.trim() || null,
    author: album.creator?.name ?? null,
    institution: album.creator?.institutionName ?? null,
    groups: (album.sharedWithGroups ?? [])
      .map((g) => g.name)
      .filter((n): n is string => Boolean(n)),
  };
}

export function normaliseEvent(event: CalendarEvent, childNameById: Map<number, string>) {
  return {
    id: event.id,
    title: event.title?.trim() || '(untitled)',
    start: event.startDateTime,
    end: event.endDateTime ?? null,
    allDay: Boolean(event.allDay),
    type: event.type ?? null,
    location: event.primaryResourceText || null,
    createdBy: event.creatorName || null,
    institution: event.institutionName || event.institutionCode || null,
    responseRequired: Boolean(event.responseRequired),
    responseStatus: event.responseStatus ?? null,
    responseDeadline: event.responseDeadline ?? null,
    children: (event.belongsToProfiles ?? [])
      .map((id) => childNameById.get(id))
      .filter((name): name is string => Boolean(name)),
  };
}

export function normalisePresence(entry: PresenceEntry) {
  return {
    child: entry.institutionProfile?.name ?? null,
    institution: entry.institutionProfile?.institutionName ?? null,
    status: presenceStatus(entry.status),
    statusDanish: presenceStatusDanish(entry.status),
    location: entry.location?.name ?? null,
    checkInTime: entry.checkInTime ?? null,
    checkOutTime: entry.checkOutTime ?? null,
    plannedEntry: entry.entryTime ?? null,
    plannedExit: entry.exitTime ?? null,
    exitWith: entry.exitWith || null,
    comment: entry.comment || null,
    vacationNote: entry.vacationNote || null,
  };
}

function normaliseAttachments(attachments: Attachment[] | undefined) {
  return (attachments ?? [])
    .map((a) => {
      const target = a.file ?? a.media ?? a.link ?? null;
      return { name: a.name ?? target?.name ?? 'attachment', url: target?.url ?? null };
    })
    .filter((a) => a.name || a.url);
}

function threadTimestamp(thread: ThreadSummary): Date | undefined {
  const raw = thread.latestMessage?.sendDateTime ?? thread.startedTime;
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
