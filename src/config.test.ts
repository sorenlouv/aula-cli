/**
 * Asserts this repo's lint and format configuration against the fleet's.
 *
 * Six repos, no shared workspace, and until now six independently drifting
 * configs: three repos formatted with single quotes and two with double, and
 * every `.oxlintrc.json` sat at oxlint's narrowest `correctness` tier because
 * that is what the first one happened to say. "The configs are copies of the
 * sibling repos'" was true in the sense that they started as copies, and false
 * in the sense that nothing kept them that way.
 *
 * So the fleet root owns them (`../config/`), a script copies them in
 * (`../scripts/sync-config.sh`), and this asserts the copy — the same bargain
 * contract.json makes.
 *
 * WHY A SKIP IS HONEST HERE, HAVING JUST BEEN CALLED DISHONEST NEXT DOOR.
 * contract.test.ts skipping in CI was a real hole: the substantive claim ("this
 * tool emits what it says it emits") could be checked from this repo alone, and
 * it silently was not. Here there is no such half. The *effect* of this config
 * is enforced on every CI run — `npm run lint` and `npm run format:check` use
 * it — and the only thing this file adds is "and it matches the fleet's", which
 * genuinely cannot be known without the fleet root beside the checkout.
 */

import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const local = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));
const fleet = (name: string): string =>
  fileURLToPath(new URL(`../../config/${name}`, import.meta.url));

const PAIRS = [
  { local: local('.prettierrc'), fleet: fleet('prettierrc.json') },
  { local: local('oxlint.base.json'), fleet: fleet('oxlint.base.json') },
];

test('the lint and format config matches the fleet root', () => {
  // A standalone checkout has no fleet root, so there is genuinely nothing to
  // compare against — unlike the contract tests this pattern came from, where
  // skipping hid a claim that could have been checked from this repo alone.
  // The *effect* of this config is enforced on every CI run regardless.
  if (!existsSync(fleet('prettierrc.json'))) return;

  for (const pair of PAIRS) {
    expect(readFileSync(pair.local, 'utf8')).toBe(readFileSync(pair.fleet, 'utf8'));
  }
});

test('.oxlintrc.json extends the shared base rather than restating it', () => {
  // This one needs no fleet root: it is a claim about this repo alone. Without
  // the extends line the base file would sit there being copied, synced and
  // drift-tested while oxlint ignored it completely.
  const config = JSON.parse(readFileSync(local('.oxlintrc.json'), 'utf8')) as {
    extends?: string[];
  };
  expect(config.extends).toEqual(['./oxlint.base.json']);
});
