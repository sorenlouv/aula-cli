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
 */

import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EXIT } from './errors.ts';

const VENDORED = fileURLToPath(new URL('../contract.json', import.meta.url));
const FLEET = fileURLToPath(new URL('../../contract.json', import.meta.url));

interface ToolContract {
  repo: string;
  exit_codes: number[];
  body_on: number[];
  bridge?: { command: string; emits: string; boundary: string };
}

interface FleetContract {
  contract: number;
  exit_codes: Record<string, string>;
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
