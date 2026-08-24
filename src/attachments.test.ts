import { describe, expect, test } from 'bun:test';
import { readBoundedBody } from './attachments.ts';

describe('bounded attachment reads', () => {
  test('streams a body without trusting a missing content-length', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );
    expect([...(await readBoundedBody(response, 'small.pdf', 4))]).toEqual([1, 2, 3, 4]);
  });

  test('cancels as soon as an undeclared body crosses the byte limit', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedBody(response, 'large.pdf', 4)).rejects.toThrow('4-byte limit');
    expect(cancelled).toBe(true);
  });
});
