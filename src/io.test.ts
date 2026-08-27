import { describe, expect, test } from 'bun:test';
import { openCommand } from './io.ts';

/** Runs `fn` as if on another platform. */
function asPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('openCommand', () => {
  const url = 'http://127.0.0.1:54321/2f4a-token';

  test("uses each platform's opener", () => {
    expect(asPlatform('darwin', () => openCommand(url))).toEqual(['open', url]);
    expect(asPlatform('linux', () => openCommand(url))).toEqual(['xdg-open', url]);
    // `start` is a cmd builtin whose first quoted argument is the window title.
    // Without the empty one it takes the URL as the title and opens nothing.
    expect(asPlatform('win32', () => openCommand(url))).toEqual(['cmd', '/c', 'start', '', url]);
  });

  test('never loses the target', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(asPlatform(platform, () => openCommand(url)).at(-1)).toBe(url);
    }
  });
});
