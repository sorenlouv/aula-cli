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
    expect(threads).toHaveLength(26);
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
    expect(found).toHaveLength(1_100);
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
