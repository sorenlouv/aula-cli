/**
 * Points `$AULA_DIR` at a scratch directory before any test module loads.
 *
 * "Tests never touch `~/.aula`" is one of this repo's hard rules, and until now
 * it was kept by convention: every test that wrote under `$AULA_DIR` passed an
 * explicit path, and `seed-tokens.ts` refused to run without the variable set.
 * Nothing enforced it for code that derives a path *itself*, and the first such
 * code to arrive broke it immediately — `spawnClaude` gained a working
 * directory of its own, `join(AULA_DIR, 'cwd')`, and `bun test src/` created
 * `~/.aula/cwd` in the real install on the first run.
 *
 * That one was harmless, an empty directory. The rule exists because the next
 * one will not be: `~/.aula` holds the family's MitID refresh token and the
 * deploy target of their hosted page, and a test that wandered into either
 * would cost a real login or publish a fixture to the page their children's
 * school appears on.
 *
 * So the variable is set here, once, before the first import. `AULA_DIR` is
 * resolved at module load in `auth.ts`, which is why this has to be a preload
 * rather than anything a test file can do for itself — by the time a test body
 * runs, every path derived from it has already been computed.
 *
 * An `$AULA_DIR` that is already set is left alone: `cli.test.ts` gives each
 * sandboxed CLI subprocess its own, and that is a deliberate choice this must
 * not override.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AULA_DIR ??= mkdtempSync(join(tmpdir(), 'aula-test-home-'));
