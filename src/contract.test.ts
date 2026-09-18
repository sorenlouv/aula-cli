/**
 * Asserts this tool against the fleet's shared contract file.
 *
 * WHY THIS FILE IS NEW. aula-cli is in `contract.json` — it adopted the shared
 * exit-code table, and the contract records the bridge boundary that keeps a
 * name discovered by another tool from being fed into this one. But nothing
 * checked any of it. Every sibling had a contract test; this repo had the
 * entry and no assertion, so the exit codes could drift from the table they
 * were deliberately aligned to and the only thing that would notice is a
 * person reading two files side by side.
 *
 * The contract is read from the copy vendored in this repo, never from the
 * fleet root: that root exists on Søren's laptop and nowhere else, so a test
 * that loaded it would skip itself in CI — and a skip reads exactly like a
 * pass. The fleet root is used for one thing, proving the copy has not
 * drifted, on the machine where both exist.
 *
 * Since contract 7 the slice declares what every agent-facing command emits —
 * top-level keys, what is inside them (`nested`, by jq path), what the exit-4
 * body looks like, and which error codes the error line can carry — and this
 * file holds each of those to the output the code actually produces against
 * the fake Aula, in both directions: a declared key that is missing fails, and
 * an emitted object nothing declares fails. A slice nobody checks is prose.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractFrame } from './contract.ts';
import { ERROR_CODES, EXIT } from './errors.ts';
import { isRecord } from './validation.ts';

const VENDORED = fileURLToPath(new URL('../contract.json', import.meta.url));
const FLEET = fileURLToPath(new URL('../../contract.json', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Nested = { keys: string[]; optional?: string[]; nullable?: string[] };
type CommandContract = {
  shape: 'object' | 'array';
  keys?: string[];
  optional?: string[];
  nullable?: string[];
  item_keys?: string[];
  item_optional?: string[];
  item_nullable?: string[];
  on_exit_4?: { null: string[]; nullable: string[]; empty: string[] };
  nested?: Record<string, Nested>;
  notes?: Record<string, string>;
};
interface ToolContract {
  repo: string;
  exit_codes: number[];
  body_on: number[];
  error_codes: string[];
  bridge?: { command: string; emits: string; boundary: string };
  commands: Record<string, CommandContract>;
}
interface FleetContract {
  contract: number;
  exit_codes: Record<string, string>;
  error_body: { stream: string; shape: unknown; codes: Record<string, string> };
  stdout: Record<string, string>;
  tools: Record<string, ToolContract>;
}

function loadAll(): FleetContract {
  return JSON.parse(readFileSync(VENDORED, 'utf8')) as FleetContract;
}

function loadContract(): ToolContract {
  const entry = loadAll().tools.aula;
  if (!entry) throw new Error('contract.json has no `aula` entry');
  return entry;
}

test('the vendored contract has not drifted from the fleet root', () => {
  // The only assertion here that may be skipped, and the only one where
  // skipping is honest: a standalone checkout has no fleet root.
  if (!existsSync(FLEET)) return;

  expect(loadAll()).toEqual(JSON.parse(readFileSync(FLEET, 'utf8')) as FleetContract);
});

test('the exit codes this tool defines are the ones the contract declares', () => {
  const defined: number[] = Object.values(EXIT);
  defined.sort((a, b) => a - b);
  expect(defined).toEqual([...loadContract().exit_codes].sort((a, b) => a - b));
});

test('every declared code has the same meaning as the shared table', () => {
  // aula used to have a colliding scheme of its own (1 usage AND bug, 2
  // credentials, 3 API error), which meant an agent driving several of these
  // tools could not read a code without first knowing which tool produced it.
  // This asserts it is still on the shared table, not just numerically equal
  // to it by coincidence.
  const shared = loadAll().exit_codes;
  for (const code of loadContract().exit_codes) {
    expect(shared[String(code)]).toBeDefined();
  }
  // 3 is deliberately absent: this tool never answers "refine and retry" —
  // it is only ever called with a name the user typed.
  const declared: number[] = loadContract().exit_codes;
  expect(declared).not.toContain(3);
});

test('the bridge boundary is recorded, because it is a rule about people', () => {
  // The one entry in the contract that is a safety rule rather than a shape:
  // aula is only ever called with a name the USER typed. A name discovered by
  // another tool goes to dgs or cvr. If this disappears from the contract, the
  // rule has stopped being written down anywhere a driving agent will read.
  const bridge = loadContract().bridge;
  expect(bridge).toBeDefined();
  expect(bridge?.boundary).toContain('never here');
});

// Both directions: every code the source can put on the line is declared, and
// every declared code is one the fleet's error_body knows.
test('the error codes this tool emits are exactly the ones it declares, and the fleet knows them', () => {
  const declared = loadContract().error_codes;
  expect(new Set(declared)).toEqual(new Set<string>(ERROR_CODES));
  const known = Object.keys(loadAll().error_body.codes);
  for (const code of declared) expect(known).toContain(code);
});

// ------------------------------------------------------------- the frame
// Contract 7 gave the fleet ONE shape for `--contract`, because two tools
// printed two and an agent could not learn the answer from one and reuse it on
// the next. These hold this tool to that frame: the key set, and the cut of the
// shared exit table down to the codes this tool emits. Key ORDER is not
// asserted — nothing reading JSON depends on it.

test('--contract prints the fleet frame: exactly these keys, and no others', () => {
  const frame = contractFrame();
  // The whole slice — `exit_codes`, `body_on`, `error_codes`, `commands` and
  // the rest — plus the four the frame adds. Written this way rather than as a
  // literal list so a key added to the slice is carried rather than rejected;
  // the cut and the verbatim sections are what the other two tests pin.
  expect(new Set(Object.keys(frame))).toEqual(
    new Set([
      'contract',
      'tool',
      'error_body',
      'stdout',
      ...Object.keys(loadContract() as unknown as Record<string, unknown>),
    ]),
  );
  // Outside the join graph on purpose: no join key leads into this tool, and
  // printing the table would suggest one does. And it never exits 3.
  expect(frame).not.toHaveProperty('join_keys');
  expect(frame).not.toHaveProperty('exit_3_body');
});

test('the frame carries the slice and the shared sections verbatim', () => {
  const all = loadAll();
  const frame = contractFrame();
  const { exit_codes: _expanded, tool, ...rest } = frame;
  // `contractFrame` imports the JSON so the compiled binary carries it; this
  // reads the same file from disk, so the two routes are held to one answer.
  expect(tool).toBe('aula');
  expect(all.tools[tool as string]).toBeDefined();
  const { exit_codes: _declared, ...slice } = loadContract();
  expect(rest).toEqual({
    contract: all.contract,
    ...slice,
    error_body: all.error_body,
    stdout: all.stdout,
  });
});

test('the frame expands exit_codes into the shared table, cut to this tool', () => {
  // The slice's own `exit_codes` is a bare array — it says WHICH codes this
  // tool emits and nothing about what they mean, and the agent asking is
  // holding a binary with no checkout beside it. The frame expands it.
  const all = loadAll();
  const expanded = contractFrame().exit_codes as Record<string, string>;
  const declared = [...loadContract().exit_codes].sort((a, b) => a - b);
  expect(Object.keys(expanded)).toEqual(declared.map(String));
  for (const code of declared) expect(expanded[String(code)]).toBe(all.exit_codes[String(code)]);
  // Cut, not the whole table: 3 is a code this tool never emits, and the
  // table's own `_note` is not a code at all.
  expect(expanded).not.toHaveProperty('3');
  expect(expanded).not.toHaveProperty('_note');
});

// ------------------------------------------------------ the slice, both ways

type RunResult = { code: number; stdout: string; stderr: string };

const PRELOAD = join(ROOT, 'src/testing/fake-aula.ts');
const SEED = join(ROOT, 'src/testing/seed-tokens.ts');
const ENTRY = join(ROOT, 'src/cli.ts');

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** One isolated ~/.aula with a fixture login, exactly as cli.test.ts does it. */
function sandbox(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aula-contract-test-'));
  sandboxes.push(dir);
  const log = join(dir, 'requests.log');
  writeFileSync(log, '');
  const env = { ...process.env, AULA_DIR: dir, FAKE_AULA_LOG: log, NO_COLOR: '1', ...overrides };
  const seeded = Bun.spawnSync({ cmd: ['bun', SEED], env });
  if (seeded.exitCode !== 0) throw new Error(`token seeding failed: ${seeded.stderr.toString()}`);
  return {
    dir,
    run(...args: string[]): RunResult {
      const result = Bun.spawnSync({ cmd: ['bun', '--preload', PRELOAD, ENTRY, ...args], env });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

/** The nodes at a jq-style path: `.a.b[]` — a trailing `[]` means every element. */
function resolve(body: unknown, path: string): unknown[] {
  let nodes: unknown[] = [body];
  for (const segment of path.match(/\.[^.[\]]+|\[\]/g) ?? []) {
    nodes =
      segment === '[]'
        ? nodes.flatMap((node) => (Array.isArray(node) ? node : []))
        : nodes
            .map((node) => (isRecord(node) ? node[segment.slice(1)] : undefined))
            .filter((node) => node !== undefined && node !== null);
  }
  return nodes;
}

/** Every path in `body` that holds objects (or an array of them), in the same grammar. */
function objectPaths(body: unknown, path = ''): Set<string> {
  const found = new Set<string>();
  if (Array.isArray(body)) {
    for (const item of body) for (const p of objectPaths(item, `${path}[]`)) found.add(p);
  } else if (isRecord(body)) {
    if (path !== '') found.add(path);
    for (const [key, value] of Object.entries(body)) {
      for (const p of objectPaths(value, `${path}.${key}`)) found.add(p);
    }
  }
  return found;
}

/** Holds one object to a declaration: keys, optional keys, and where null is allowed. */
function expectShape(object: Record<string, unknown>, declared: Nested, where: string): void {
  const allowed = new Set([...declared.keys, ...(declared.optional ?? [])]);
  const nullable = new Set(declared.nullable ?? []);
  for (const key of declared.keys) {
    expect(object, `${where}: declared key "${key}" is missing`).toHaveProperty(key);
  }
  for (const [key, value] of Object.entries(object)) {
    expect(allowed.has(key), `${where}: emitted key "${key}" is not declared`).toBe(true);
    if (value === null) {
      expect(nullable.has(key), `${where}: "${key}" is null but not declared nullable`).toBe(true);
    }
  }
}

function expectBody(body: unknown, contract: CommandContract, where: string): void {
  if (contract.shape === 'array') {
    expect(Array.isArray(body), `${where}: declared an array`).toBe(true);
    const items: Nested = {
      keys: contract.item_keys ?? [],
      optional: contract.item_optional ?? [],
      nullable: contract.item_nullable ?? [],
    };
    for (const item of body as unknown[]) {
      expect(isRecord(item), `${where}: an item is not an object`).toBe(true);
      expectShape(item as Record<string, unknown>, items, `${where}[]`);
    }
  } else {
    expect(isRecord(body), `${where}: declared an object`).toBe(true);
    expectShape(
      body as Record<string, unknown>,
      {
        keys: contract.keys ?? [],
        optional: contract.optional ?? [],
        nullable: contract.nullable ?? [],
      },
      where,
    );
  }

  // Nested, both ways. Declared paths are checked wherever they resolve; and
  // every object the body holds below the top level must have a declaration,
  // or an agent is back to guessing at it.
  const nested = contract.nested ?? {};
  for (const [path, declared] of Object.entries(nested)) {
    for (const node of resolve(body, path)) {
      expect(isRecord(node), `${where} ${path}: not an object`).toBe(true);
      expectShape(node as Record<string, unknown>, declared, `${where} ${path}`);
    }
  }
  const undeclared = [...objectPaths(body)].filter((path) => path !== '[]' && !(path in nested));
  expect(undeclared, `${where}: objects at paths the slice does not declare`).toEqual([]);
}

/** How each declared command is run against the fake to get a body, per exit. */
const INVOCATIONS: Record<
  string,
  { ok: string[][]; nothing?: string[][]; env?: Record<string, string> }
> = {
  digest: { ok: [['digest', '--no-cache']] },
  messages: {
    ok: [
      ['messages', '--no-cache'],
      ['messages', '--full', '--no-cache'],
    ],
    nothing: [['messages', '--unread', '--child', 'Viggo', '--no-cache']],
  },
  thread: {
    ok: [
      ['thread', '5001', '--no-cache'],
      ['thread', '5001', '--page', '0', '--no-cache'],
    ],
  },
  posts: { ok: [['posts', '--no-cache']] },
  galleries: {
    ok: [['galleries', '--no-cache']],
    nothing: [['galleries', '--since', '1d', '--no-cache']],
  },
  calendar: { ok: [['calendar', '--no-cache']] },
  presence: { ok: [['presence', '--no-cache']] },
  'pickup-times': { ok: [], nothing: [['pickup-times', '--no-cache']] },
  groups: { ok: [['groups', '--no-cache']] },
  contacts: {
    ok: [
      ['contacts', '--group', '5001', '--no-cache'],
      ['contacts', '--group', '5001', '--role', 'guardian', '--no-cache'],
    ],
  },
  birthdays: { ok: [['birthdays', '--group', '5001', '--no-cache']] },
  notifications: { ok: [], nothing: [['notifications', '--no-cache']] },
  attachments: {
    ok: [['attachments', '5001', '--no-cache']],
    nothing: [['attachments', '5002', '--no-cache']],
  },
  attachment: { ok: [['attachment', '5001', '1', '--no-cache']] },
  'post-attachment': { ok: [['post-attachment', '7001', '--no-cache']] },
  commonfiles: { ok: [['commonfiles', '--no-cache']], env: { FAKE_AULA_COMMON_FILES: '3' } },
  commonfile: { ok: [['commonfile', '2', '--no-cache']], env: { FAKE_AULA_COMMON_FILES: '3' } },
  widgets: { ok: [['widgets', '--no-cache']] },
  'weekly-plan': {
    ok: [['weekly-plan', '--no-cache']],
    nothing: [['weekly-plan', '--child', 'Viggo', '--no-cache']],
  },
  whoami: { ok: [['whoami', '--no-cache']] },
  // Answered from disk: no cache to bypass. `doctor` never reads the cache.
  status: { ok: [['status']] },
  doctor: { ok: [['doctor']] },
};

describe('every declared command emits what the slice says, and nothing else', () => {
  const commands = loadContract().commands;

  test('every declared command has an invocation here, and every invocation a declaration', () => {
    expect(new Set(Object.keys(INVOCATIONS))).toEqual(new Set(Object.keys(commands)));
  });

  for (const [name, contract] of Object.entries(commands)) {
    const invocation = INVOCATIONS[name];
    if (!invocation) continue;

    test(`${name}: exit 0`, () => {
      const box = sandbox(invocation.env);
      for (const args of invocation.ok) {
        const result = box.run(...args);
        expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0);
        expectBody(JSON.parse(result.stdout), contract, args.join(' '));
      }
    });

    if (invocation.nothing) {
      test(`${name}: exit 4 has the declared body`, () => {
        const box = sandbox(invocation.env);
        const on4 = contract.on_exit_4;
        expect(on4, `${name} exits 4 and must declare on_exit_4`).toBeDefined();
        for (const args of invocation.nothing ?? []) {
          const result = box.run(...args);
          expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(4);
          const body: unknown = JSON.parse(result.stdout);
          expectBody(body, contract, `${args.join(' ')} (exit 4)`);
          for (const path of on4?.null ?? []) {
            for (const node of resolve(body, path.replace(/\.[^.[\]]+$/, ''))) {
              const key = path.slice(path.lastIndexOf('.') + 1);
              expect((node as Record<string, unknown>)[key], `${path} on exit 4`).toBeNull();
            }
          }
          for (const path of on4?.empty ?? []) {
            const parent = path.replace(/\.[^.[\]]+$/, '');
            const key = path.slice(path.lastIndexOf('.') + 1);
            for (const node of resolve(body, parent)) {
              expect((node as Record<string, unknown>)[key], `${path} on exit 4`).toEqual([]);
            }
          }
        }
      });
    }
  }

  test('on_exit_4 names only keys the command has', () => {
    for (const [name, contract] of Object.entries(commands)) {
      const on4 = contract.on_exit_4;
      if (!on4) continue;
      const top = new Set([
        ...(contract.keys ?? []),
        ...(contract.item_keys ?? []),
        ...Object.values(contract.nested ?? {}).flatMap((n) => n.keys),
      ]);
      for (const path of [...on4.null, ...on4.nullable, ...on4.empty]) {
        const key = path.slice(path.lastIndexOf('.') + 1);
        expect(
          top.has(key),
          `${name}: on_exit_4 names "${path}", which the command does not emit`,
        ).toBe(true);
      }
    }
  });
});

// The error line, at the process level: the last line of stderr on a failing
// exit is one line of JSON whose code is one this tool declares.
test('a failing exit ends stderr with an error line whose code is declared', () => {
  const declared = new Set(loadContract().error_codes);
  const cases: Array<{ args: string[]; env?: Record<string, string>; exit: number }> = [
    { args: ['not-a-command'], exit: 2 },
    { args: ['whoami', '--no-cache'], env: { FAKE_AULA_REJECT_TOKEN: '1' }, exit: 5 },
    { args: ['whoami', '--no-cache'], env: { FAKE_AULA_DOWN: '1' }, exit: 1 },
    { args: ['whoami', '--no-cache'], env: { FAKE_AULA_UNREACHABLE: '1' }, exit: 1 },
  ];
  for (const { args, env, exit } of cases) {
    const result = sandbox(env).run(...args);
    expect(result.code, args.join(' ')).toBe(exit);
    expect(result.stdout, `${args.join(' ')}: no body on exit ${exit}`).toBe('');
    const last = result.stderr.trimEnd().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(last) as { error: { code: string; message: string; hint: unknown } };
    expect(Object.keys(parsed)).toEqual(['error']);
    expect(Object.keys(parsed.error)).toEqual(['code', 'message', 'hint']);
    expect(declared.has(parsed.error.code), `${args.join(' ')}: code ${parsed.error.code}`).toBe(
      true,
    );
    expect(typeof parsed.error.message).toBe('string');
    expect(parsed.error.hint === null || typeof parsed.error.hint === 'string').toBe(true);
  }
});
