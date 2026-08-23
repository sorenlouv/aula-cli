import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { installFakeClaude } from '../testing/fake-claude.ts';
import {
  parseClaudeJson,
  parseJsonLoosely,
  runClaude,
  spawnClaude,
  validateExtraction,
  withPreferences,
} from './llm.ts';
import type { BriefInput, SourceItem } from './types.ts';

const SOURCE: SourceItem = sourceItem({
  key: 'post:1',
  title: 'Myretuens løbedag',
  text: 'Kære alle.\n\nI morgen holder vi løbedag — det gør vi hver mandag fremover — og børnene må meget gerne have løbetøj og sko med, de kan løbe i!',
  at: '2026-08-10T11:42:00+00:00',
  groups: ['Myretuen'],
  childNames: ['Viggo Birk Eksempelsen'],
});

const INPUT: BriefInput = briefInput({
  family: {
    children: [
      {
        name: 'Viggo Birk Eksempelsen',
        firstName: 'Viggo',
        institution: 'Eksemplet',
        className: 'Myretuen',
        presence: null,
      },
    ],
    isSteppedUp: true,
  },
  items: [SOURCE],
});

const good = {
  kind: 'bring',
  title: 'Løbetøj med på mandag',
  child: 'Viggo',
  dueAt: '2026-08-17',
  urgency: 'week',
  quote: 'have løbetøj og sko med',
  why: 'Fast ugentlig løbedag',
  sourceKey: 'post:1',
};

/** Every source is owed a verdict; a well-formed answer carries one for post:1. */
const verdicts = { relevance: { 'post:1': 'normal' } };

describe('withPreferences', () => {
  const BASE = 'Du læser Aula-indhold.';

  test('an empty list leaves the instructions exactly as they were', () => {
    expect(withPreferences(BASE, [])).toBe(BASE);
    expect(withPreferences(BASE, ['  ', ''])).toBe(BASE);
  });

  test('the wishes are appended verbatim, under a heading that says who wrote them', () => {
    const out = withPreferences(BASE, ['beskeder fra John (Hjaltes far) er altid vigtige']);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('- beskeder fra John (Hjaltes far) er altid vigtige');
    // Who is speaking is the load-bearing part: these outrank the model's own
    // judgement precisely because they did not come from Aula.
    expect(out).toContain('brugerens egen liste');
  });

  test('they never license invention — the rules above them still stand', () => {
    const out = withPreferences(BASE, ['alt fra skolen er vigtigt']);
    expect(out).toContain('opfinde kilder, datoer eller citater');
  });
});

describe('parseJsonLoosely', () => {
  test('accepts a bare object, a fenced block, and prose around it', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('Her er svaret:\n{"a":1}\nHåber det hjælper.')).toEqual({ a: 1 });
  });

  test('throws when there is no object at all', () => {
    expect(() => parseJsonLoosely('beklager, det kan jeg ikke')).toThrow();
  });
});

describe('validateExtraction', () => {
  test('keeps a well-formed signal', () => {
    const result = validateExtraction(INPUT, {
      topline: 'Rolig uge.',
      signals: [good],
      ...verdicts,
    });
    expect(result.problems).toEqual([]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.origin).toBe('model');
    expect(result.topline).toBe('Rolig uge.');
  });

  test('drops a signal whose title asserts a date no source supports', () => {
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, title: 'Løbetøj med — aflever senest søndag 24/9' }],
    });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0]).toContain('dato uden kilde');
    expect(result.problems[0]).toContain('søndag');
  });

  test('drops a signal whose dueAt nothing grounds', () => {
    // 2026-08-19 is a Wednesday; the source speaks only of mandag.
    const result = validateExtraction(INPUT, { signals: [{ ...good, dueAt: '2026-08-19' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0]).toContain('ingen støtte');
  });

  test('a title may echo the weekday of its own grounded dueAt', () => {
    const result = validateExtraction(INPUT, { signals: [good], ...verdicts });
    expect(result.problems).toEqual([]); // "på mandag" + dueAt on a Monday
  });

  test('keeps a verdict for a known source', () => {
    const result = validateExtraction(INPUT, { signals: [good], relevance: { 'post:1': 'high' } });
    expect(result.relevance).toEqual({ 'post:1': 'high' });
    expect(result.problems).toEqual([]);
  });

  test('a verdict outside the four words reads as normal and is reported for repair', () => {
    const result = validateExtraction(INPUT, {
      signals: [good],
      relevance: { 'post:1': 'meget', 'post:999': 'high' },
    });
    expect(result.relevance).toEqual({ 'post:1': 'normal' });
    expect(result.problems).toEqual([
      'relevance.post:1: "meget" er ikke hide|low|normal|high',
      'relevance: ukendt sourceKey "post:999"',
    ]);
  });

  test('a missing verdict map is a problem worth the retry; an empty input is owed none', () => {
    // The family's list reaches the ranking through these verdicts and
    // nothing else, so an answer without them has skipped the question.
    const without = validateExtraction(INPUT, { signals: [good] });
    expect(without.relevance).toEqual({});
    expect(without.problems).toEqual(['relevance: mangler for post:1']);
    expect(validateExtraction(briefInput({ items: [] }), { signals: [] }).problems).toEqual([]);
  });

  test('a partial verdict map reports every source the model failed to rank', () => {
    const two = briefInput({ ...INPUT, items: [SOURCE, { ...SOURCE, key: 'post:2' }] });
    const result = validateExtraction(two, { signals: [], relevance: { 'post:2': 'hide' } });
    expect(result.relevance).toEqual({ 'post:2': 'hide' });
    expect(result.problems).toEqual(['relevance: mangler for post:1']);
  });

  test('every personal calendar entry is owed its own model verdict', () => {
    const first = sourceItem({
      key: 'cal:family:dentist:2026-08-14T13:30:00+02:00',
      kind: 'personal',
      title: 'Tandlæge kl. 13:30–14:15',
      text: 'Tandlæge · 13:30–14:15 · Fra kalenderen «Familie»',
      at: '2026-08-14T13:30:00',
      audience: 'family',
    });
    const second = { ...first, key: 'cal:family:playdate:2026-08-15T10:00:00+02:00' };
    const calendarInput = briefInput({ items: [first, second] });
    const complete = validateExtraction(calendarInput, {
      signals: [],
      relevance: { [first.key]: 'high', [second.key]: 'normal' },
    });
    expect(complete.problems).toEqual([]);
    expect(complete.relevance).toEqual({ [first.key]: 'high', [second.key]: 'normal' });

    const partial = validateExtraction(calendarInput, {
      signals: [],
      relevance: { [first.key]: 'high' },
    });
    expect(partial.problems).toEqual([`relevance: mangler for ${second.key}`]);
  });

  test('nulls a topline with an invented date and reports it', () => {
    const result = validateExtraction(INPUT, {
      topline: 'Husk mødet på fredag.',
      signals: [good],
    });
    expect(result.topline).toBeNull();
    expect(result.signals).toHaveLength(1);
    expect(result.problems.some((p) => p.startsWith('topline'))).toBe(true);
  });

  test('drops a child summary with an invented date', () => {
    const result = validateExtraction(INPUT, {
      signals: [good],
      childSummaries: { Viggo: 'God uge — husk festen 24/9.' },
    });
    expect(result.childSummaries).toEqual({});
    expect(result.problems.some((p) => p.startsWith('childSummaries.Viggo'))).toBe(true);
  });

  test('drops a signal whose quote is not literally in the source', () => {
    // The whole point: a plausible sentence the teacher never wrote.
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, quote: 'Husk gummistøvler og regntøj på fredag' }],
    });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? '').toContain('ordret');
  });

  test('tolerates whitespace differences in an otherwise literal quote', () => {
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, quote: 'have  løbetøj og sko\nmed' }],
    });
    expect(result.signals).toHaveLength(1);
  });

  test('drops a signal citing a source that was never supplied', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, sourceKey: 'post:999' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? '').toContain('ukendt sourceKey');
  });

  test('drops an unparseable date rather than guessing', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, dueAt: 'på mandag' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? '').toContain('ikke en dato');
  });

  test('drops an impossible ISO date instead of letting JavaScript roll it over', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, dueAt: '2026-02-31' }] });
    expect(result.signals).toHaveLength(0);
    expect(result.problems[0] ?? '').toContain('ikke en dato');
  });

  test('ignores a child name that is not one of ours', () => {
    const result = validateExtraction(INPUT, { signals: [{ ...good, child: 'Birk' }] });
    expect(result.signals[0]?.child).toBeNull();
  });

  test('falls back to safe values for unknown kind and urgency', () => {
    const result = validateExtraction(INPUT, {
      signals: [{ ...good, kind: 'panik', urgency: 'straks' }],
    });
    expect(result.signals[0]?.kind).toBe('info');
    expect(result.signals[0]?.urgency).toBe('later');
  });

  test('keeps only child summaries for real children', () => {
    const result = validateExtraction(INPUT, {
      signals: [],
      childSummaries: { Viggo: 'Har løbedag om mandagen.', Ukendt: 'Findes ikke.' },
    });
    expect(Object.keys(result.childSummaries)).toEqual(['Viggo']);
  });

  test('survives complete rubbish without throwing', () => {
    expect(validateExtraction(INPUT, null).signals).toEqual([]);
    expect(validateExtraction(INPUT, { signals: 'nope' }).signals).toEqual([]);
    expect(validateExtraction(INPUT, { signals: [null] }).signals).toEqual([]);
  });

  describe('conversation summaries', () => {
    const message = (from: string, at: string, text: string) => ({ from, at, text });
    const thread = (count: number) =>
      sourceItem({
        key: 'thread:9',
        kind: 'thread',
        title: 'Møde om Viggo',
        text: 'Møde om Viggo\n\nLone: Kan I mødes?\n\nJer: Ja.\n\nLone: Fint.',
        conversation: {
          messages: Array.from({ length: count }, (_, i) =>
            message('Yrsa Storm', `2026-08-1${i}T09:00:00`, `Besked ${i}`),
          ),
          total: count,
          truncated: false,
        },
      });

    const withThread = (count: number) => briefInput({ ...INPUT, items: [SOURCE, thread(count)] });

    test('keeps a summary for a thread that is genuinely an exchange', () => {
      const result = validateExtraction(withThread(4), {
        signals: [],
        relevance: { 'post:1': 'normal', 'thread:9': 'normal' },
        conversationSummaries: { 'thread:9': '  Yrsa foreslår et møde; I har sagt ja.  ' },
      });
      expect(result.conversationSummaries).toEqual({
        'thread:9': 'Yrsa foreslår et møde; I har sagt ja.',
      });
      expect(result.problems).toEqual([]);
    });

    test('refuses to summarise something that is not a conversation', () => {
      const result = validateExtraction(withThread(1), {
        signals: [],
        ...verdicts,
        conversationSummaries: { 'thread:9': 'Yrsa skrev en besked.' },
      });
      expect(result.conversationSummaries).toEqual({});
      expect(result.problems.join(' ')).toContain('er ikke en samtale');
    });

    test('refuses a summary for a source that was never supplied', () => {
      const result = validateExtraction(withThread(4), {
        signals: [],
        ...verdicts,
        conversationSummaries: { 'thread:404': 'Noget helt andet.' },
      });
      expect(result.conversationSummaries).toEqual({});
      expect(result.problems.join(' ')).toContain('ukendt sourceKey');
    });

    test('drops a summary that asserts a date nothing supports', () => {
      const result = validateExtraction(withThread(4), {
        signals: [],
        ...verdicts,
        conversationSummaries: { 'thread:9': 'Mødet er aftalt til den 3. november.' },
      });
      expect(result.conversationSummaries).toEqual({});
      expect(result.problems.join(' ')).toContain('dato uden kilde');
    });

    test('is empty, not absent, when the model said nothing about threads', () => {
      expect(validateExtraction(INPUT, { signals: [], ...verdicts }).conversationSummaries).toEqual(
        {},
      );
    });
  });
});

// --------------------------------------------------------------- subprocess

describe('the claude subprocess', () => {
  const VALID = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const ORIGINAL_PATH = process.env.PATH;
  const dirs: string[] = [];
  let log = '';

  beforeAll(() => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'aula-fake-claude-'));
    dirs.push(fakeDir);
    process.env.PATH = installFakeClaude(fakeDir).path;
  });
  afterAll(() => {
    if (ORIGINAL_PATH !== undefined) process.env.PATH = ORIGINAL_PATH;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_RESULT_JSON;
    delete process.env.FAKE_CLAUDE_LOG;
  });

  function fake(mode: string, result?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'aula-fake-log-'));
    dirs.push(dir);
    log = join(dir, 'calls.log');
    writeFileSync(log, '');
    process.env.FAKE_CLAUDE_MODE = mode;
    process.env.FAKE_CLAUDE_LOG = log;
    if (result !== undefined) process.env.FAKE_CLAUDE_RESULT_JSON = JSON.stringify(result);
    return { calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }

  describe('parseClaudeJson', () => {
    test('reads the result envelope, last JSON line wins', () => {
      const out =
        'some warning first\n{"type":"result","is_error":false,"result":"hello","permission_denials":[{"tool_name":"Bash"}]}\n';
      expect(parseClaudeJson(out)).toEqual({
        text: 'hello',
        isError: false,
        structured: undefined,
        denials: ['Bash'],
      });
    });

    test('is null when stdout is not an envelope at all', () => {
      expect(parseClaudeJson('plain prose')).toBeNull();
      expect(parseClaudeJson('{"type":"other"}')).toBeNull();
      expect(parseClaudeJson('')).toBeNull();
    });
  });

  describe('spawnClaude', () => {
    test('collects the envelope and the exit code', async () => {
      fake('ok', 'svar');
      const run = await spawnClaude(['-p', 'x'], { timeoutMs: 5_000 });
      expect(run.code).toBe(0);
      expect(run.timedOut).toBe(false);
      expect(parseClaudeJson(run.stdout)?.text).toBe('svar');
    });

    test('passes stdin through to the process', async () => {
      // The fake ignores stdin, but the spawn must not fail on it.
      fake('ok');
      const run = await spawnClaude(['-p', 'x'], { stdin: 'a'.repeat(100_000), timeoutMs: 5_000 });
      expect(run.code).toBe(0);
    });

    test('a stalled process is killed at the deadline, and an orphan on the pipe does not delay the return', async () => {
      fake('stall');
      const started = Date.now();
      const run = await spawnClaude(['-p', 'x'], { timeoutMs: 300, graceMs: 200 });
      expect(run.timedOut).toBe(true);
      // SIGTERM killed the script; the `sleep` it left behind still holds stdout.
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    test('a process that ignores SIGTERM gets SIGKILL after the grace', async () => {
      fake('stall-ignore-term');
      const started = Date.now();
      const run = await spawnClaude(['-p', 'x'], { timeoutMs: 300, graceMs: 200 });
      expect(run.timedOut).toBe(true);
      expect(run.code).toBe(137);
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });

  describe('runClaude', () => {
    test('returns the envelope text, tools off', async () => {
      const f = fake('ok', '{"signals":[]}');
      expect((await runClaude('instr', '{}', { timeoutMs: 5_000 })).text).toBe('{"signals":[]}');
      expect(f.calls()[0]).toContain('--tools  --strict-mcp-config --output-format json');
    });

    test('a schema is handed to the CLI, and its parsed answer is preferred', async () => {
      // The flag is what makes the answer a forced tool call; `structured_output`
      // is that call's parameters, already checked against the schema.
      const f = fake('ok', '{"signals":[]}');
      const reply = await runClaude('instr', '{}', {
        timeoutMs: 5_000,
        schema: { type: 'object' },
      });
      expect(f.calls()[0]).toContain('--json-schema');
      expect(reply.text).toBe('{"signals":[]}');
    });

    test('no schema means no flag, so the plain call is unchanged', async () => {
      const f = fake('ok', '{"signals":[]}');
      await runClaude('instr', '{}', { timeoutMs: 5_000 });
      expect(f.calls()[0]).not.toContain('--json-schema');
    });

    test('tries once more after a stall, and only after a stall', async () => {
      const f = fake('stall-then-ok', 'second');
      expect((await runClaude('instr', '{}', { timeoutMs: 300, graceMs: 200 })).text).toBe(
        'second',
      );
      expect(f.calls()).toHaveLength(2);
    });

    test('two stalls throw a bounded, explicit error', async () => {
      const f = fake('stall');
      await expect(runClaude('instr', '{}', { timeoutMs: 300, graceMs: 200 })).rejects.toThrow(
        /timed out after 0s \(2 attempts\)/,
      );
      expect(f.calls()).toHaveLength(2);
    });

    test('an error envelope throws its text, without a retry', async () => {
      const f = fake('error');
      await expect(runClaude('instr', '{}', { timeoutMs: 5_000 })).rejects.toThrow(/Not logged in/);
      expect(f.calls()).toHaveLength(1);
    });

    test('the url the fake echoes back survives the envelope untouched', async () => {
      fake('ok', VALID);
      expect((await runClaude('instr', '{}', { timeoutMs: 5_000 })).text).toBe(VALID);
    });
  });
});
