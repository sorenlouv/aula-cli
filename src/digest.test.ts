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
import { buildDigest, withFullMessages } from './digest.ts';
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
  test('the brief-sized 60-day window carries all 45 in-window posts', async () => {
    const posts: Post[] = Array.from({ length: 45 }, (_, index) => ({
      id: index + 1,
      title: `Opslag ${index + 1}`,
      publishAt: `2026-08-${String(13 - Math.floor(index / 10)).padStart(2, '0')}T08:00:00+02:00`,
      content: { html: `Indhold ${index + 1}` },
    }));
    const family: Family = {
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
    const fake = {
      async getThreads() {
        return { threads: [], moreMessagesExist: false };
      },
      async getPosts(opts: { index: number; limit: number }) {
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
      family,
      now: new Date('2026-08-13T06:30:00+02:00'),
    });

    expect(digest.posts).toHaveLength(45);
  });
});
