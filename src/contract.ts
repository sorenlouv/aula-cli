/**
 * `--contract` — this tool's slice of the fleet's shared contract.
 *
 * Every sibling prints its slice this way, so an agent driving the fleet can
 * ask a tool what it emits rather than be told by a document that may have
 * drifted. This tool has had an entry in `contract.json` since it adopted the
 * shared exit table, and the fleet's own instructions say each tool answers
 * `--contract` — but here the flag was an unknown command, exit 2.
 *
 * Imported rather than read from disk, which is where this differs from the
 * Node siblings. They resolve `../contract.json` beside their source; end users
 * of this tool run a compiled binary with no checkout beside it, where
 * `import.meta` is a virtual path and a `readFileSync` against it compiles
 * happily and fails only for the user. `bun build --compile` embeds a JSON
 * import, the same way it embeds the skill template.
 *
 * The copy is the one vendored in this repo, never the fleet root's:
 * `contract.test.ts` asserts the two agree on the machine where both exist.
 */

import fleet from '../contract.json' with { type: 'json' };

/**
 * No `join_keys`, unlike `bolig`, `tinglysning` and `dgs`. Those are the DAWA
 * paths the public-register tools compose on, and this tool sits outside that
 * graph on purpose: it reads the user's own children's school, and no join key
 * leads into it. Printing the table here would suggest otherwise.
 */
export function contractSlice(): Record<string, unknown> {
  return { contract: fleet.contract, ...fleet.tools.aula };
}
