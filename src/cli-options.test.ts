import { describe, expect, test } from 'bun:test';
import { optionsFor, parseCommandLine, usageFor } from './cli-options.ts';

describe('command-line contracts', () => {
  test('keeps the values typed by node:util', () => {
    const { values, positionals } = parseCommandLine('messages', [
      '--limit',
      '10',
      '--full',
      '--child',
      'Alma',
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
    expect(() => parseCommandLine('open', ['--text'])).toThrow('"open" does not accept --text');
    expect(() => parseCommandLine('new', ['--child', 'Alma'])).toThrow(
      '"new" does not accept --child',
    );
  });

  test('checks positional arity before command code runs', () => {
    expect(() => parseCommandLine('thread', [])).toThrow('Usage: aula thread <threadId>');
    expect(() => parseCommandLine('thread', ['12', '13'])).toThrow('Usage: aula thread <threadId>');
    expect(() => parseCommandLine('new', ['surprise'])).toThrow('Usage: aula new');
  });

  test('the attachment index is optional and defaults to the first one', () => {
    expect(parseCommandLine('attachment', ['5001']).positionals).toEqual(['5001']);
    expect(parseCommandLine('attachment', ['5001', '2']).positionals).toEqual(['5001', '2']);
    expect(() => parseCommandLine('attachment', [])).toThrow(
      'Usage: aula attachment <threadId> [index]',
    );
    expect(() => parseCommandLine('attachment', ['5001', '2', '3'])).toThrow(
      'Usage: aula attachment',
    );
  });

  /** The help reads from the same table the parser enforces, so it cannot drift. */
  test('per-command help lists exactly what that command accepts', () => {
    expect(optionsFor('doctor')).toEqual(['--text', '--days']);
    expect(optionsFor('doctor')).not.toContain('--no-cache');
    expect(optionsFor('messages')).toContain('--unread');
    expect(optionsFor('logout')).toEqual([]);
    expect(usageFor('attachment')).toBe('attachment <threadId> [index]');
    expect(usageFor('whoami')).toBe('whoami');

    for (const option of optionsFor('messages')) {
      expect(() => parseCommandLine('messages', [option, 'x'])).not.toThrow(/does not accept/);
    }
  });

  test('preserves deliberately free-form positionals', () => {
    expect(parseCommandLine('remember', ['beskeder', 'fra', 'John']).positionals).toEqual([
      'beskeder',
      'fra',
      'John',
    ]);
    expect(parseCommandLine('raw', ['posts.getSomething', 'a=1', 'a=2']).positionals).toHaveLength(
      3,
    );
  });
});
