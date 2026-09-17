/**
 * The error *format*, tested apart from any particular error.
 *
 * What is being pinned here is the reading order — headline first, then why,
 * then what to run — because `doctor` reports only the first line of a failure
 * and the CLI prints only the first line in bold. Both rely on the headline
 * standing on its own, and neither would notice if it stopped.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CliError,
  ERROR_CODES,
  errorLineFor,
  EXIT,
  EXIT_FOR,
  formatRemedy,
  remedyHint,
  UsageError,
  wrap,
} from './errors.ts';

test('the headline is the whole first line, so a one-line report is still useful', () => {
  const message = formatRemedy({
    headline: 'Aula rejected your login.',
    detail: 'The stored MitID login is no longer accepted.',
    commands: ['bun run login'],
  });

  assert.equal(message.split('\n')[0], 'Aula rejected your login.');
});

test('detail and commands follow the headline, separated by blank lines', () => {
  const message = formatRemedy({
    headline: 'Something went wrong.',
    detail: 'Because of a reason.',
    commands: ['bun run login', 'bun run aula doctor --text'],
    fallback: 'And if that fails, try later.',
  });

  assert.equal(
    message,
    [
      'Something went wrong.',
      '',
      'Because of a reason.',
      '',
      '  bun run login',
      '  bun run aula doctor --text',
      '',
      'And if that fails, try later.',
    ].join('\n'),
  );
});

test('a headline on its own renders as exactly that, with no stray blank lines', () => {
  assert.equal(formatRemedy({ headline: 'Nope.' }), 'Nope.');
});

test('commands are indented so they are recognisable as things to run', () => {
  const message = formatRemedy({ headline: 'x', commands: ['bun run login'] });
  assert.match(message, /^ {2}bun run login$/m);
});

test('detail is wrapped, and the wrap never splits a word', () => {
  const detail = 'one two three four five six seven eight nine ten eleven twelve';
  const wrapped = wrap(detail, 20);

  for (const line of wrapped.split('\n')) assert.ok(line.length <= 20, `too long: "${line}"`);
  assert.equal(wrapped.replace(/\n/g, ' '), detail, 'wrapping must not lose or change a word');
});

// A URL or a long method name is one word and cannot be broken; overflowing
// the line is the correct answer, hanging is not.
test('a word longer than the width gets a line of its own rather than looping', () => {
  const long = 'https://www.aula.dk/api/v24/?method=profiles.getProfilesByLogin';
  assert.equal(wrap(`see ${long} now`, 20), `see\n${long}\nnow`);
});

test('line breaks the caller wrote are kept', () => {
  assert.equal(wrap('short\nlines', 40), 'short\nlines');
});

// ------------------------------------------------------------ the error line

test('an error answers for its own error line: the code is on the class', () => {
  const line = errorLineFor(new UsageError('No child matches "Nobody".\nKnown children: …'));
  assert.deepEqual(line, { code: 'USAGE', message: 'No child matches "Nobody".', hint: null });

  const coded = errorLineFor(new CliError('NETWORK', 'Could not reach Aula.', 'Try again.'));
  assert.deepEqual(coded, {
    code: 'NETWORK',
    message: 'Could not reach Aula.',
    hint: 'Try again.',
  });
});

// Anything nobody planned for is a bug in this client, and says so — the one
// code whose hint is not a next action but whose problem it is.
test('an unplanned error is BUG, and the vendored login flow is SETUP', () => {
  const bug = errorLineFor(new TypeError('x is not a function'));
  assert.equal(bug.code, 'BUG');
  assert.equal(bug.message, 'x is not a function');
  assert.match(bug.hint ?? '', /bug in aula-cli/);

  const flow = errorLineFor(new Error('Silent SSO landed on MitID'), { isAuthFlow: true });
  assert.equal(flow.code, 'SETUP');
});

test('every code has an exit, and only the three failing ones', () => {
  assert.deepEqual(new Set(Object.keys(EXIT_FOR)), new Set<string>(ERROR_CODES));
  assert.deepEqual(new Set(Object.values(EXIT_FOR)), new Set([EXIT.ERROR, EXIT.USAGE, EXIT.SETUP]));
});

test('a remedy becomes a one-line hint: the action and what to run', () => {
  assert.equal(
    remedyHint({ headline: 'x', action: 'Check the ids:', commands: ['aula whoami'] }),
    'Check the ids: aula whoami',
  );
  assert.equal(
    remedyHint({ headline: 'x', fallback: 'Wait and try again.' }),
    'Wait and try again.',
  );
  assert.equal(remedyHint({ headline: 'x' }), null);
});
