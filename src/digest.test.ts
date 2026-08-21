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
import { withFullMessages } from './digest.ts';
import type { Message, ThreadSummary } from './types.ts';

function summary(id: number, subject: string): ThreadSummary {
  return { id, subject, read: true, sensitive: false, startedTime: '2026-08-20T08:00:00+02:00' };
}

const MESSAGE: Message = {
  id: 'm-1',
  sendDateTime: '2026-08-20T08:00:00+02:00',
  sender: { fullName: 'Lone Lærke' },
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
