import { describe, expect, test } from 'bun:test';
import { parseCommandLine } from './cli-options.ts';

describe('command-line contracts', () => {
  test('keeps the values typed by node:util', () => {
    const { values, positionals } = parseCommandLine('messages', [
      '--limit', '10', '--full', '--child', 'Alma',
    ]);
    expect(values.limit).toBe('10');
    expect(values.full).toBe(true);
    expect(values.child).toBe('Alma');
    expect(positionals).toEqual([]);
  });

  test('refuses every option the selected command would ignore', () => {
    expect(() => parseCommandLine('messages', ['--important'])).toThrow(
      '"messages" does not accept --important',
    );
    expect(() => parseCommandLine('open', ['--text'])).toThrow(
      '"open" does not accept --text',
    );
    expect(() => parseCommandLine('new', ['--child', 'Alma'])).toThrow(
      '"new" does not accept --child',
    );
  });

  test('checks positional arity before command code runs', () => {
    expect(() => parseCommandLine('thread', [])).toThrow('Usage: aula thread <threadId>');
    expect(() => parseCommandLine('thread', ['12', '13'])).toThrow('Usage: aula thread <threadId>');
    expect(() => parseCommandLine('new', ['surprise'])).toThrow('Usage: aula new');
  });

  test('preserves deliberately free-form positionals', () => {
    expect(parseCommandLine('remember', ['beskeder', 'fra', 'John']).positionals).toEqual([
      'beskeder', 'fra', 'John',
    ]);
    expect(parseCommandLine('raw', ['posts.getSomething', 'a=1', 'a=2']).positionals).toHaveLength(3);
  });
});
