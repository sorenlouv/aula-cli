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
import { formatRemedy, wrap } from './errors.ts';

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
