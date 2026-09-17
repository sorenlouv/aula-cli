/**
 * `withFullMessages` is the seam where a thread's body can go missing without
 * anything failing: one thread Aula refuses must not cost the digest the other
 * thirty-nine, so the error is swallowed on purpose.
 *
 * What it owes its callers in exchange is a way to tell the two apart
 * afterwards — an empty thread and an unreadable one are otherwise the same
 * object — and that is the flag asserted here. `brief/collect.ts` reads it to
 * warn the reader; see the end-to-end pair in `cli.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import type { AulaClient } from './client.ts';
import {
  buildDigest,
  collectAlbums,
  collectPosts,
  collectThreads,
  normaliseAlbum,
  withFullMessages,
} from './digest.ts';
import type { Family } from './family.ts';
import type { Message, Post, ThreadSummary } from './types.ts';

function summary(id: number, subject: string): ThreadSummary {
  return { id, subject, read: true, sensitive: false, startedTime: '2026-08-20T08:00:00+02:00' };
}

const MESSAGE: Message = {
  id: 'm-1',
  sendDateTime: '2026-08-20T08:00:00+02:00',
  sender: { fullName: 'Yrsa Storm' },
  text: { html: 'Vi tager af sted mandag.' },
};

const EMPTY_FAMILY: Family = {
  guardian: {
    profileId: 1,
    userId: 'guardian',
    name: 'Guardian',
    institutionProfileIds: [10],
  },
  children: [],
  institutions: [],
  postInstitutionProfileIds: [10],
  childInstitutionProfileIds: [],
  institutionCodes: [],
  widgets: [],
  isSteppedUp: true,
  mitidUsername: undefined,
};

const CHILD_FAMILY: Family = {
  ...EMPTY_FAMILY,
  children: [
    {
      id: 11,
      profileId: 111,
      name: 'Alma Eksempelsen',
      institutionCode: '100001',
      institutionName: 'Eksempelskolen',
    },
  ],
  postInstitutionProfileIds: [10, 11],
  childInstitutionProfileIds: [11],
};

/** Answers for every thread except the ids named, which throw as Aula's 403 does. */
function client(...refused: number[]): AulaClient {
  return {
    async getThread(threadId: number) {
      if (refused.includes(threadId)) throw new Error('Aula answered 403');
      return { id: threadId, sensitive: false, totalMessageCount: 1, messages: [MESSAGE] };
    },
  } as unknown as AulaClient;
}

describe('withFullMessages', () => {
  test('reads, deduplicates and merges every message page', async () => {
    const calls: number[] = [];
    const paged = {
      async getThread(threadId: number, page: number) {
        calls.push(page);
        const message = {
          ...MESSAGE,
          id: `m-${page}`,
          sendDateTime: `2026-08-2${page}T08:00:00+02:00`,
        };
        return {
          id: threadId,
          sensitive: false,
          totalMessageCount: 2,
          moreMessagesExist: page === 0,
          messages: page === 0 ? [message] : [{ ...MESSAGE, id: 'm-0' }, message],
        };
      },
    } as unknown as AulaClient;

    const [thread] = await withFullMessages(paged, [summary(5001, 'Lejrskole for 2E')]);
    expect(calls).toEqual([0, 1]);
    expect(thread?.messages.map((message) => message.id)).toEqual(['m-0', 'm-1']);
    expect(thread?.messagesIncomplete).toBe(false);
  });

  test('keeps earlier pages but marks a later-page failure incomplete', async () => {
    const paged = {
      async getThread(threadId: number, page: number) {
        if (page === 1) throw new Error('Aula answered 503');
        return {
          id: threadId,
          sensitive: false,
          totalMessageCount: 2,
          moreMessagesExist: true,
          messages: [MESSAGE],
        };
      },
    } as unknown as AulaClient;

    const [thread] = await withFullMessages(paged, [summary(5001, 'Lejrskole for 2E')]);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messagesUnavailable).toBe(false);
    expect(thread?.messagesIncomplete).toBe(true);
    expect(thread?.messageReadWarning).toContain('side 2');
  });

  test('a thread whose messages were fetched carries them and is not flagged', async () => {
    const [thread] = await withFullMessages(client(), [summary(5001, 'Lejrskole for 2E')]);
    expect(thread?.messagesUnavailable).toBe(false);
    expect(thread?.messages.map((m) => m.text)).toEqual(['Vi tager af sted mandag.']);
  });

  test('a refused thread keeps its subject, loses its body, and says so', async () => {
    const [thread] = await withFullMessages(client(5001), [summary(5001, 'Lejrskole for 2E')]);
    // The subject survives because it comes off the thread list, not the
    // detail — which is exactly why the empty body is invisible without a flag.
    expect(thread?.subject).toBe('Lejrskole for 2E');
    expect(thread?.messages).toEqual([]);
    expect(thread?.messagesUnavailable).toBe(true);
  });

  test('one refusal does not take the readable threads with it', async () => {
    const threads = await withFullMessages(client(5002), [
      summary(5001, 'Lejrskole for 2E'),
      summary(5002, 'Lukkedag i Myretuen'),
      summary(5003, 'Til alle forældre'),
    ]);
    expect(threads.map((t) => t.messagesUnavailable)).toEqual([false, true, false]);
  });
});

describe('buildDigest', () => {
  test('post paging has no hidden 200-row ceiling', async () => {
    const posts: Post[] = Array.from({ length: 245 }, (_, index) => ({
      id: index + 1,
      title: `Opslag ${index + 1}`,
      publishAt: '2026-08-12T08:00:00+02:00',
      content: { html: `Indhold ${index + 1}` },
    }));
    let postReads = 0;
    const fake = {
      async getThreads() {
        return { threads: [], moreMessagesExist: false };
      },
      async getPosts(opts: { index: number; limit: number }) {
        postReads++;
        const page = posts.slice(opts.index, opts.index + opts.limit);
        return { posts: page, hasMorePosts: opts.index + opts.limit < posts.length };
      },
      async getCalendarEvents() {
        return [];
      },
      async getNotifications() {
        return [];
      },
      async getDailyPresence() {
        return [];
      },
    } as unknown as AulaClient;

    const digest = await buildDigest(fake, {
      days: 60,
      isoWeek: '2026-W33',
      family: EMPTY_FAMILY,
      now: new Date('2026-08-13T06:30:00+02:00'),
    });

    expect(digest.posts).toHaveLength(245);
    expect(postReads).toBe(25);
    expect(digest.collectionLimits.posts).toBeNull();
  });

  test('a failed calendar read is unavailable, never a validated empty calendar', async () => {
    const fake = {
      async getThreads() {
        return { threads: [], moreMessagesExist: false };
      },
      async getPosts() {
        return { posts: [], hasMorePosts: false };
      },
      async getCalendarEvents() {
        throw new Error('Aula answered 503');
      },
      async getDailyPresence() {
        return [];
      },
    } as unknown as AulaClient;

    const digest = await buildDigest(fake, {
      days: 60,
      isoWeek: '2026-W33',
      family: EMPTY_FAMILY,
      now: new Date('2026-08-13T06:30:00+02:00'),
    });

    expect(digest.calendar).toEqual([]);
    expect(digest.calendarAvailable).toBe(false);
    expect(digest.fetchWarnings).toEqual([
      expect.stringContaining('Aula-kalenderen kunne ikke hentes'),
    ]);
  });

  test('thread paging has no hidden 25-page ceiling', async () => {
    let reads = 0;
    const fake = {
      async getThreads(page: number) {
        reads++;
        return {
          threads: page < 26 ? [summary(page + 1, `Tråd ${page + 1}`)] : [],
          moreMessagesExist: page < 25,
        };
      },
    } as unknown as AulaClient;

    const threads = await collectThreads(fake, {
      limit: 30,
      unreadOnly: false,
      family: EMPTY_FAMILY,
    });
    expect(threads.rows).toHaveLength(26);
    expect(threads.truncated).toBe(false);
    expect(reads).toBe(26);
  });

  test('a repeated post page fails instead of looping or claiming completeness', async () => {
    const post: Post = { id: 1, title: 'Gentaget', publishAt: '2026-08-12T08:00:00+02:00' };
    const fake = {
      async getPosts() {
        return { posts: [post], hasMorePosts: true };
      },
    } as unknown as AulaClient;
    await expect(collectPosts(fake, EMPTY_FAMILY, { limit: 10 })).rejects.toThrow(
      'repeated post page',
    );
  });

  test('album paging has no silent 1,000-row stop', async () => {
    const albums = Array.from({ length: 1_100 }, (_, index) => ({
      id: index + 1,
      title: `Album ${index + 1}`,
      creationDate: '2026-08-12T08:00:00+02:00',
    }));
    const fake = {
      async getAlbums(opts: { index: number; limit: number }) {
        return albums.slice(opts.index, opts.index + opts.limit);
      },
    } as unknown as AulaClient;
    const found = await collectAlbums(fake, CHILD_FAMILY, { limit: 1_200 });
    expect(found.rows).toHaveLength(1_100);
    expect(found.truncated).toBe(false);
  });

  test('album dates are calendar days, not timestamps that leak into the page', () => {
    expect(
      normaliseAlbum({
        id: 1,
        title: 'Skovtur',
        creationDate: '2026-08-12T23:30:00+02:00',
      }).createdAt,
    ).toBe('2026-08-12');
  });
});

/**
 * The three collectors used to return bare arrays, and the CLI capped each at
 * twenty rows — so twenty of twenty and twenty of two hundred were the same
 * answer. The cap is only honest if the cut travels with the rows.
 */
describe('a list that was cut says so', () => {
  const WINDOW_START = new Date('2026-08-01T00:00:00+02:00');

  /**
   * Plain method bags rather than `AulaClient`s, so the digest test below can
   * combine two of them: spreading a class instance loses its prototype, and
   * these never had one.
   */
  const asClient = (methods: object) => methods as unknown as AulaClient;

  /** `count` threads inside the window, twenty to a page like Aula's own. */
  function threadReads(count: number) {
    const all = Array.from({ length: count }, (_, index) =>
      summary(index + 1, `Tråd ${index + 1}`),
    );
    return {
      async getThreads(page: number) {
        return {
          threads: all.slice(page * 20, (page + 1) * 20),
          moreMessagesExist: (page + 1) * 20 < all.length,
        };
      },
    };
  }

  function postReads(count: number) {
    const all: Post[] = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      title: `Opslag ${index + 1}`,
      publishAt: '2026-08-12T08:00:00+02:00',
    }));
    return {
      async getPosts(opts: { index: number; limit: number }) {
        return {
          posts: all.slice(opts.index, opts.index + opts.limit),
          hasMorePosts: opts.index + opts.limit < all.length,
        };
      },
    };
  }

  function albumReads(count: number) {
    const all = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      title: `Album ${index + 1}`,
      creationDate: '2026-08-12T08:00:00+02:00',
    }));
    return {
      async getAlbums(opts: { index: number; limit: number }) {
        return all.slice(opts.index, opts.index + opts.limit);
      },
    };
  }

  test('a window with no limit keeps every row inside it', async () => {
    const filter = { since: WINDOW_START, unreadOnly: false, family: EMPTY_FAMILY };
    const threads = await collectThreads(asClient(threadReads(45)), filter);
    expect(threads.rows).toHaveLength(45);
    expect(threads.truncated).toBe(false);

    const posts = await collectPosts(asClient(postReads(45)), EMPTY_FAMILY, {
      since: WINDOW_START,
    });
    expect(posts.rows).toHaveLength(45);
    expect(posts.truncated).toBe(false);

    const albums = await collectAlbums(asClient(albumReads(45)), CHILD_FAMILY, {
      since: WINDOW_START,
    });
    expect(albums.rows).toHaveLength(45);
    expect(albums.truncated).toBe(false);
  });

  test('a limit below what qualified is reported as a cut', async () => {
    const threads = await collectThreads(asClient(threadReads(45)), {
      limit: 20,
      unreadOnly: false,
      family: EMPTY_FAMILY,
    });
    expect(threads.rows).toHaveLength(20);
    expect(threads.truncated).toBe(true);

    const posts = await collectPosts(asClient(postReads(45)), EMPTY_FAMILY, { limit: 20 });
    expect(posts.rows).toHaveLength(20);
    expect(posts.truncated).toBe(true);

    const albums = await collectAlbums(asClient(albumReads(45)), CHILD_FAMILY, { limit: 20 });
    expect(albums.rows).toHaveLength(20);
    expect(albums.truncated).toBe(true);
  });

  // The off-by-one that matters: a limit that exactly fits is a complete
  // answer, and calling it cut would send the caller back for rows that do not
  // exist.
  test('a limit that exactly fits is not a cut', async () => {
    const threads = await collectThreads(asClient(threadReads(20)), {
      limit: 20,
      unreadOnly: false,
      family: EMPTY_FAMILY,
    });
    expect(threads.rows).toHaveLength(20);
    expect(threads.truncated).toBe(false);

    const posts = await collectPosts(asClient(postReads(20)), EMPTY_FAMILY, { limit: 20 });
    expect(posts.truncated).toBe(false);

    const albums = await collectAlbums(asClient(albumReads(20)), CHILD_FAMILY, { limit: 20 });
    expect(albums.truncated).toBe(false);
  });

  test('the digest reports the same cut through collectionLimits', async () => {
    const fake = {
      ...threadReads(3),
      ...postReads(3),
      async getThread(threadId: number) {
        return { id: threadId, sensitive: false, totalMessageCount: 1, messages: [MESSAGE] };
      },
      async getCalendarEvents() {
        return [];
      },
      async getDailyPresence() {
        return [];
      },
    } as unknown as AulaClient;

    const digest = await buildDigest(fake, {
      days: 60,
      limit: 2,
      isoWeek: '2026-W33',
      family: EMPTY_FAMILY,
      now: new Date('2026-08-21T06:30:00+02:00'),
    });
    expect(digest.threads).toHaveLength(2);
    expect(digest.posts).toHaveLength(2);
    expect(digest.collectionLimits).toEqual({ posts: 2, threads: 2 });
  });
});
