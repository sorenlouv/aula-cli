/**
 * `--contract` — this tool's slice of the fleet's shared contract, in the
 * frame every tool in the fleet prints.
 *
 * Every sibling prints its slice this way, so an agent driving the fleet can
 * ask a tool what it emits rather than be told by a document that may have
 * drifted. This tool has had an entry in `contract.json` since it adopted the
 * shared exit table, and the fleet's own instructions say each tool answers
 * `--contract` — but here the flag was an unknown command, exit 2.
 *
 * ONE FRAME FOR THE FLEET. Tools printed two different shapes, so an agent
 * could learn the answer from one tool and not reuse it on the next. Contract 7
 * fixes the frame: `contract`, `tool`, `exit_codes`, `body_on`, `error_codes`,
 * the shared `error_body` and `stdout` sections verbatim, then `commands` and
 * the rest of the slice. `tool` is here because the frame is otherwise
 * anonymous — an agent holding the output of two tools could not say which was
 * which without reading `repo`.
 *
 * `exit_codes` is an OBJECT here, not the slice's bare array. The array in
 * `contract.json` is what says WHICH codes this tool emits; `--contract` is
 * where each one is expanded to its meaning from the fleet table, cut to that
 * list. A reader of the array alone gets five integers and has to find the
 * table; a reader of the object is done. The table's own `_note` is dropped in
 * the cut: it is not a code, and what it says — which exits carry a body is per
 * tool, read `body_on` — is answered by the `body_on` in the same object.
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

/** The name this tool is called by in `contract.json`, and in the frame. */
export const CONTRACT_TOOL = 'aula';

/**
 * The frame, with the fleet-wide sections this tool's output is an instance
 * of: what the error line looks like, and how stdout behaves. Without them the
 * slice names `error_codes` and `body_on` but not what either looks like, and
 * the agent that asked is holding a checkout-less binary with nowhere else to
 * look.
 *
 * No `exit_3_body`: this tool never exits 3. No `join_keys`, unlike `bolig`,
 * `tinglysning` and `dgs`: those are the DAWA paths the public-register tools
 * compose on, and this tool sits outside that graph on purpose — it reads the
 * user's own children's school, and no join key leads into it. Printing either
 * here would suggest otherwise.
 */
export function contractFrame(): Record<string, unknown> {
  const {
    exit_codes: codes,
    body_on: bodyOn,
    error_codes: errorCodes,
    commands,
    ...rest
  } = fleet.tools.aula;

  return {
    contract: fleet.contract,
    tool: CONTRACT_TOOL,
    exit_codes: expandExitCodes(codes),
    body_on: bodyOn,
    error_codes: errorCodes,
    error_body: fleet.error_body,
    stdout: fleet.stdout,
    commands,
    ...rest,
  };
}

/** The shared exit table, cut to the codes this tool emits, lowest first. */
function expandExitCodes(codes: readonly number[]): Record<string, string> {
  const table = fleet.exit_codes as Record<string, string>;
  const cut: Record<string, string> = {};
  for (const code of [...codes].sort((a, b) => a - b)) {
    const meaning = table[String(code)];
    // A code the shared table does not know is a contract that has come apart,
    // and printing it with an undefined meaning would hide that.
    if (meaning === undefined) throw new Error(`exit code ${code} is not in the shared table`);
    cut[String(code)] = meaning;
  }
  return cut;
}
