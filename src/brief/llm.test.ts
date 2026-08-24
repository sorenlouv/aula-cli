import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunError } from '../llm/claude.ts';
import { briefInput, sourceItem } from '../testing/brief-fixtures.ts';
import { installFakeClaude } from '../testing/fake-claude.ts';
import {
  extractCards,
  extractionInstructions,
  extractionPayload,
  extractionSchema,
  modelEffortArgs,
  parseClaudeJson,
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

describe('extractionPayload', () => {
  test('gives the model the final Sunday the overview may mention', () => {
    const payload = extractionPayload(INPUT);

    expect(payload.today).toBe('2026-08-13');
    expect(payload.overviewThrough).toBe('2026-08-23');
  });

  test("carries Aula's important flag to the model", () => {
    const [source] = extractionPayload({
      ...INPUT,
      items: [{ ...SOURCE, important: true }],
    }).sources;

    expect(source?.important).toBe(true);
  });

  test('keeps an action that appears after the former 4,000-character boundary', () => {
    const text = `${'Baggrund. '.repeat(500)}Husk at aflevere sedlen senest fredag.`;
    const [source] = extractionPayload({
      ...INPUT,
      items: [{ ...SOURCE, text }],
    }).sources;

    expect(text.length).toBeGreaterThan(4_000);
    expect(source?.text).toBe(text);
    expect(source?.textTruncated).toBe(false);
    expect(source?.text).toContain('Husk at aflevere sedlen senest fredag.');
  });

  test('tells the model when an exceptional source was shortened', () => {
    const text = `${'x'.repeat(8_500)}Husk at aflevere sedlen senest fredag.`;
    const [source] = extractionPayload({
      ...INPUT,
      items: [{ ...SOURCE, text }],
    }).sources;

    expect(source?.textTruncated).toBe(true);
    expect(source?.text).toContain('[midten er forkortet]');
    expect(source?.text).toStartWith('x'.repeat(100));
    expect(source?.text).toEndWith('Husk at aflevere sedlen senest fredag.');
  });
});

describe('overview horizon contract', () => {
  test('lets later items keep a card while excluding them from highlighted prose', () => {
    const schema = extractionSchema(INPUT).properties;
    const instructions = extractionInstructions(INPUT);

    expect(schema.cards.description).toContain('også efter 2026-08-23');
    expect(schema.childSummaries.description).toContain('til og med 2026-08-23');
    expect(schema.hidden.description).toContain('ikke i sig selv en grund til at skjule');
    expect(instructions).toContain('Noget senere må stadig blive et kort');
    expect(instructions).not.toContain('noget senere må ikke blive et kort');
  });
});

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
    expect(out).toContain('opfinde kilder eller datoer');
  });
});

describe('personal appointment relevance policy', () => {
  const personal = sourceItem({
    key: 'cal:family:appointment',
    kind: 'personal',
    title: 'Aftale',
    audience: 'family',
  });
  const input = briefInput({ items: [personal] });

  test('requires positive child context and defaults uncertainty to false', () => {
    const properties = extractionSchema(input).properties.personalEvents.items.properties;
    const description = properties.relevant.description;

    expect(description).toContain('kun når kalenderkilden selv tydeligt viser');
    expect(description).toContain('legeaftale');
    expect(description).toContain('voksenrelaterede aftaler er false');
    expect(description).toContain('ved tvivl: false');
    expect(properties.reason.description).toContain('tid eller mulig konflikt er ikke belæg');
  });

  test('the prose prompt delegates to that one structured policy', () => {
    const instructions = extractionInstructions(input);

    expect(instructions).toContain('snævre inklusionsregel i svarskemaets beskrivelse');
    expect(instructions).not.toContain('ved tvivl er den true');
  });
});

describe('recurring Aula cards', () => {
  test('the production contract dates a weekly routine on its next occurrence', () => {
    const dateDescription =
      extractionSchema(INPUT).properties.cards.items.properties.date.description;
    const recurringDescription =
      extractionSchema(INPUT).properties.cards.items.properties.recurring.description;
    const instructions = extractionInstructions(INPUT);

    expect(dateDescription).toContain('næste forekomst på eller efter today');
    expect(dateDescription).toContain('Null kun når hverken dato eller fast ugedag findes');
    expect(recurringDescription).toContain('True kun når kortet er en fast ugentlig aftale');
    expect(instructions).toContain('læses oversigten på selve ugedagen');
    expect(instructions).toContain('ikke en uge senere og ikke null');
  });
});

describe('independent Aula actions', () => {
  test('the production contract keeps independently completable reminders separate', () => {
    const cardProperties = extractionSchema(INPUT).properties.cards.items.properties;
    const instructions = extractionInstructions(INPUT);

    expect(cardProperties.sourceKeys.description).toContain('samme konkrete handling eller besked');
    expect(cardProperties.sourceKeys.description).toContain('bruges i flere kort');
    expect(instructions).toContain('kan klare hver for sig, er to kort');
    expect(instructions).toContain('aflevere biblioteksbøger');
    expect(instructions).toContain('prioriteres over almindelig orientering');
  });
});

describe('model cost controls', () => {
  test('uses a small low-effort model for deterministic tool transport', () => {
    const previous = {
      briefModel: process.env.AULA_BRIEF_MODEL,
      briefEffort: process.env.AULA_BRIEF_EFFORT,
      toolModel: process.env.AULA_TOOL_MODEL,
      toolEffort: process.env.AULA_TOOL_EFFORT,
    };
    try {
      delete process.env.AULA_BRIEF_MODEL;
      delete process.env.AULA_BRIEF_EFFORT;
      delete process.env.AULA_TOOL_MODEL;
      delete process.env.AULA_TOOL_EFFORT;
      expect(modelEffortArgs('transport')).toEqual(['--model', 'haiku', '--effort', 'low']);

      process.env.AULA_BRIEF_MODEL = 'sonnet';
      process.env.AULA_BRIEF_EFFORT = 'high';
      expect(modelEffortArgs()).toEqual(['--model', 'sonnet', '--effort', 'high']);
      expect(modelEffortArgs('transport')).toEqual(['--model', 'haiku', '--effort', 'low']);
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('AULA_BRIEF_MODEL', previous.briefModel);
      restore('AULA_BRIEF_EFFORT', previous.briefEffort);
      restore('AULA_TOOL_MODEL', previous.toolModel);
      restore('AULA_TOOL_EFFORT', previous.toolEffort);
    }
  });
});

describe('validateExtraction', () => {
  const POST_2: SourceItem = sourceItem({
    key: 'post:2',
    title: 'Overnatning for Myretuen d. 11/9',
    text: 'Vi afholder overnatningen fredag den 11. september efter lukketid.',
    at: '2026-07-03T08:13:00+00:00',
    groups: ['Myretuen'],
  });
  const DENTIST: SourceItem = sourceItem({
    key: 'cal:far@eksempel.dk:dentist:2026-08-14T13:30:00+02:00',
    kind: 'personal',
    title: 'Tandlæge',
    text: 'Tandlæge · kl. 13:30–14:15 · Fra kalenderen «Familien»',
    at: '2026-08-14T13:30:00',
    audience: 'family',
  });
  const input: BriefInput = { ...INPUT, items: [SOURCE, POST_2, DENTIST] };

  const good = {
    title: 'Løbetøj med til Viggo på mandag',
    summary: 'Myretuen har fast løbedag om mandagen; tøj og sko skal være til at løbe i.',
    children: ['Viggo'],
    date: '2026-08-17',
    recurring: true,
    needsAction: true,
    reason: 'Noget Viggo skal have med; rettet mod hans egen stue.',
    sourceKeys: ['post:1'],
  };
  const personalVerdict = {
    sourceKey: DENTIST.key,
    relevant: true,
    summary: 'Tandlægetid fredag kl. 13.30.',
    reason: 'Aftalen påvirker familiens plan fredag.',
  };
  const answer = (extra: Record<string, unknown> = {}) => ({
    topline: 'Løbetøj mandag.',
    cards: [good],
    personalEvents: [personalVerdict],
    childSummaries: { Viggo: 'Løbedag mandag.' },
    hidden: [],
    ...extra,
  });

  test('keeps a well-formed card with every field', () => {
    const result = validateExtraction(input, answer());
    expect(result.problems).toEqual([]);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      id: 'model:0',
      title: good.title,
      summary: good.summary,
      children: ['Viggo'],
      date: '2026-08-17',
      recurring: true,
      needsAction: true,
      reason: good.reason,
      sourceKeys: ['post:1'],
      origin: 'model',
    });
    expect(result.topline).toBe('Løbetøj mandag.');
    expect(result.childSummaries).toEqual({ Viggo: 'Løbedag mandag.' });
  });

  test('normalises enum values whose capitalization changed', () => {
    const result = validateExtraction(
      input,
      answer({
        cards: [{ ...good, sourceKeys: ['POST:1'], children: ['vIGGO'] }],
        personalEvents: [{ ...personalVerdict, sourceKey: DENTIST.key.toUpperCase() }],
        hidden: ['POST:2'],
      }),
    );

    expect(result.problems).toEqual([]);
    expect(result.cards[0]?.sourceKeys).toEqual(['post:1']);
    expect(result.cards[0]?.children).toEqual(['Viggo']);
    expect(result.personalEvents[0]?.sourceKey).toBe(DENTIST.key);
    expect(result.hidden).toEqual(['post:2']);
  });

  test('a card may gather several sources, and its date may come from any of them', () => {
    // The July post has the date; the August post has the news. One card.
    const merged = {
      ...good,
      title: 'Overnatning for Myretuen 11/9',
      date: '2026-09-11',
      recurring: false,
      sourceKeys: ['post:1', 'post:2'],
    };
    const result = validateExtraction(input, answer({ cards: [merged] }));
    expect(result.problems).toEqual([]);
    expect(result.cards[0]?.sourceKeys).toEqual(['post:1', 'post:2']);
    expect(result.cards[0]?.date).toBe('2026-09-11');
  });

  test('drops a card whose date no source supports', () => {
    const result = validateExtraction(input, answer({ cards: [{ ...good, date: '2026-09-24' }] }));
    expect(result.cards).toEqual([]);
    expect(result.problems.some((p) => p.includes('2026-09-24') && p.includes('belæg'))).toBe(true);
  });

  test('drops a card that names a date in its text that no source supports', () => {
    const invented = { ...good, summary: 'Husk løbetøj — og tilmelding senest 24/9.' };
    const result = validateExtraction(input, answer({ cards: [invented] }));
    expect(result.cards).toEqual([]);
    expect(result.problems.some((p) => p.includes('24/9'))).toBe(true);
  });

  test('a date in the text is fine when any of the card’s sources carries it', () => {
    const merged = {
      ...good,
      summary: 'Løbedag mandag, og overnatning fredag den 11. september.',
      sourceKeys: ['post:1', 'post:2'],
    };
    expect(validateExtraction(input, answer({ cards: [merged] })).problems).toEqual([]);
  });

  test('a card may echo its own grounded date as a weekday', () => {
    // 2026-08-17 is a Monday; "mandag" is exactly what the card is about.
    const echoed = { ...good, title: 'Løbetøj med mandag' };
    expect(validateExtraction(input, answer({ cards: [echoed] })).problems).toEqual([]);
  });

  test('a recurring card must cite one weekly weekday', () => {
    const fabricated = {
      ...good,
      title: 'Overnatning for Viggo',
      summary: 'Myretuen overnatter fredag den 11. september.',
      date: '2026-09-11',
      sourceKeys: ['post:2'],
    };
    const result = validateExtraction(input, answer({ cards: [fabricated] }));
    expect(result.cards).toEqual([]);
    expect(result.problems.some((problem) => problem.includes('recurring'))).toBe(true);
  });

  test('a timestamp is not a date', () => {
    const result = validateExtraction(
      input,
      answer({ cards: [{ ...good, date: '2026-08-17T09:00:00+02:00' }] }),
    );
    // The schema enforces `format: date`; this is the belt to its braces.
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.date).toBe('2026-08-17');
  });

  test('refuses a card that cites an unknown source, or none', () => {
    for (const sourceKeys of [['post:404'], []]) {
      const result = validateExtraction(input, answer({ cards: [{ ...good, sourceKeys }] }));
      expect(result.cards).toEqual([]);
      expect(result.problems.some((p) => p.includes('sourceKeys'))).toBe(true);
    }
  });

  test('refuses a card made of an appointment — the page lists those itself', () => {
    const result = validateExtraction(
      input,
      answer({ cards: [{ ...good, sourceKeys: [DENTIST.key] }] }),
    );
    expect(result.cards).toEqual([]);
    expect(result.problems.some((p) => p.includes('kalenderaftale'))).toBe(true);
  });

  test('a child the family does not have is dropped from the card, not the card', () => {
    const result = validateExtraction(
      input,
      answer({ cards: [{ ...good, children: ['Viggo', 'Ida'] }] }),
    );
    expect(result.cards[0]?.children).toEqual(['Viggo']);
  });

  test('a card with no title is dropped', () => {
    const result = validateExtraction(input, answer({ cards: [{ ...good, title: '  ' }] }));
    expect(result.cards).toEqual([]);
  });

  test('the topline and the per-child lines are checked against every source', () => {
    const result = validateExtraction(
      input,
      answer({ topline: 'Fest 24/9!', childSummaries: { Viggo: 'Ferie i uge 44.' } }),
    );
    expect(result.topline).toBeNull();
    expect(result.childSummaries).toEqual({});
    expect(result.problems.filter((p) => p.includes('dato uden belæg'))).toHaveLength(2);
    // The cards were fine; only the two lines were dropped.
    expect(result.cards).toHaveLength(1);
  });

  test('every personal appointment gets one explicit, grounded verdict', () => {
    const valid = validateExtraction(input, answer());
    expect(valid.personalEvents).toEqual([personalVerdict]);

    const missing = validateExtraction(input, answer({ personalEvents: [] }));
    expect(missing.personalEvents).toEqual([]);
    expect(missing.problems.some((problem) => problem.includes('mangler relevansvurdering'))).toBe(
      true,
    );

    const duplicate = validateExtraction(
      input,
      answer({ personalEvents: [personalVerdict, personalVerdict] }),
    );
    expect(duplicate.problems.some((problem) => problem.includes('mere end én'))).toBe(true);

    const invented = validateExtraction(
      input,
      answer({
        personalEvents: [{ ...personalVerdict, summary: 'Tandlægetid 24/9.' }],
      }),
    );
    expect(invented.personalEvents).toEqual([]);
    expect(invented.problems.some((problem) => problem.includes('24/9'))).toBe(true);
  });

  test('hidden keeps Aula keys; personal appointments use their verdict', () => {
    const result = validateExtraction(
      input,
      answer({ hidden: ['post:2', DENTIST.key, 'post:404'] }),
    );
    expect(result.hidden).toEqual(['post:2']);
    expect(result.problems.some((problem) => problem.includes('personalEvents'))).toBe(true);
  });

  test('a non-object answer is one problem, not a crash', () => {
    expect(validateExtraction(input, 'nej').problems).toEqual(['svaret var ikke et objekt']);
    expect(validateExtraction(input, { topline: 'x' }).problems).toContain(
      '"cards" mangler eller er ikke en liste',
    );
  });
});

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
    delete process.env.FAKE_CLAUDE_STRUCTURED_JSON;
    delete process.env.FAKE_CLAUDE_LOG;
  });

  function fake(mode: string, result?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'aula-fake-log-'));
    dirs.push(dir);
    log = join(dir, 'calls.log');
    writeFileSync(log, '');
    process.env.FAKE_CLAUDE_MODE = mode;
    process.env.FAKE_CLAUDE_LOG = log;
    if (result !== undefined) {
      process.env.FAKE_CLAUDE_RESULT_JSON = JSON.stringify(result);
      if (result.trim().startsWith('{')) process.env.FAKE_CLAUDE_STRUCTURED_JSON = result;
    }
    const ownLog = log;
    return {
      log: ownLog,
      calls: () => readFileSync(ownLog, 'utf8').split('\n').filter(Boolean),
    };
  }

  function fakeSequence(results: string[]) {
    const f = fake('ok');
    const file = `${f.log}.results`;
    writeFileSync(file, results.map((result) => JSON.stringify(result)).join('\n'));
    writeFileSync(`${f.log}.structured`, results.join('\n'));
    return f;
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

    test('a schema request never falls back to unvalidated result text', async () => {
      const f = fake('ok', 'plain text that happens to be valid JSON later');
      await expect(
        runClaude('instr', '{}', { timeoutMs: 5_000, schema: { type: 'object' } }),
      ).rejects.toThrow('no schema-validated structured_output');
      expect(f.calls()).toHaveLength(1);
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
      try {
        await runClaude('instr', '{}', { timeoutMs: 5_000 });
        throw new Error('expected runClaude to fail');
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeRunError);
        expect((err as ClaudeRunError).message).toContain('Not logged in');
        expect((err as ClaudeRunError).details.attempts).toMatchObject([
          { code: 1, timedOut: false, stdoutTruncated: false },
        ]);
        expect((err as ClaudeRunError).details.attempts[0]?.stdout).toContain('Not logged in');
      }
      expect(f.calls()).toHaveLength(1);
    });

    test('the url the fake echoes back survives the envelope untouched', async () => {
      fake('ok', VALID);
      expect((await runClaude('instr', '{}', { timeoutMs: 5_000 })).text).toBe(VALID);
    });
  });

  describe('extractCards corrective retry', () => {
    const sources = Array.from({ length: 10 }, (_, index) =>
      sourceItem({ key: `post:${index}`, title: `Opslag ${index}`, text: `Indhold ${index}` }),
    );
    const input = briefInput({ items: sources });
    const modelCard = (index: number) => ({
      title: `Kort ${index}`,
      summary: `Indhold ${index}`,
      children: [],
      date: null,
      recurring: false,
      needsAction: false,
      reason: 'Relevant.',
      sourceKeys: [`post:${index}`],
    });
    const answer = (cards: unknown[]) => ({
      topline: 'Kort overblik.',
      cards,
      personalEvents: [],
      childSummaries: {},
      hidden: [],
    });

    test('an empty retry cannot replace nine valid cards', async () => {
      fakeSequence([
        JSON.stringify(
          answer([
            ...Array.from({ length: 9 }, (_, index) => modelCard(index)),
            { ...modelCard(9), date: '2026-09-24' },
          ]),
        ),
        JSON.stringify(answer([])),
      ]);

      const result = await extractCards(input, { useCache: false, timeoutMs: 5_000 });

      expect(result.cards).toHaveLength(9);
    });

    test('a retry with fewer problems and more valid cards wins', async () => {
      fakeSequence([
        JSON.stringify(answer([modelCard(0), { ...modelCard(9), date: '2026-09-24' }])),
        JSON.stringify(answer([modelCard(0), modelCard(1)])),
      ]);

      const result = await extractCards(input, { useCache: false, timeoutMs: 5_000 });

      expect(result.cards.map((card) => card.title)).toEqual(['Kort 0', 'Kort 1']);
      expect(result.problems).toEqual([]);
    });
  });
});
