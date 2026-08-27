import { describe, expect, test } from 'bun:test';
import { optionsFor, parseCommandLine, usageFor } from './cli-options.ts';
import { cmd } from './runtime.ts';

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

  test('login takes only --debug and --no-open now that the kodeviser method is gone', () => {
    // The kodeviser flow ended at a password prompt and six typed digits, which
    // is unanswerable for the agent that runs this command — and the login page
    // is now the only surface, so there is nowhere to type them either. The
    // flag has to fail loudly rather than be accepted and ignored.
    //
    // `--no-open` withholds the browser, not the page: the address is printed
    // either way, so it changes nothing about where the login happens.
    // `--username` is absent on purpose — the page asks for it, and a flag for
    // it is what put the username in the chat in the first place.
    expect(optionsFor('login')).toEqual(['--debug', '--no-open']);
    expect(() => parseCommandLine('login', ['--method', 'CODE_TOKEN'])).toThrow(
      "Unknown option '--method'",
    );
    expect(() => parseCommandLine('login', ['--username', 'testbruger'])).toThrow(
      "Unknown option '--username'",
    );
  });

  test('checks positional arity before command code runs', () => {
    expect(() => parseCommandLine('thread', [])).toThrow(`Usage: ${cmd('thread <threadId>')}`);
    expect(() => parseCommandLine('thread', ['12', '13'])).toThrow(
      `Usage: ${cmd('thread <threadId>')}`,
    );
    expect(() => parseCommandLine('new', ['surprise'])).toThrow(`Usage: ${cmd('new')}`);
  });

  test('the attachment index is optional and defaults to the first one', () => {
    expect(parseCommandLine('attachment', ['5001']).positionals).toEqual(['5001']);
    expect(parseCommandLine('attachment', ['5001', '2']).positionals).toEqual(['5001', '2']);
    expect(() => parseCommandLine('attachment', [])).toThrow(
      `Usage: ${cmd('attachment <threadId> [index]')}`,
    );
    expect(() => parseCommandLine('attachment', ['5001', '2', '3'])).toThrow(
      `Usage: ${cmd('attachment')}`,
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
