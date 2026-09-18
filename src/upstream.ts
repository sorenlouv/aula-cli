/**
 * `--upstream` — how to query Aula directly, for the reads this CLI does not
 * wrap.
 *
 * WHY THIS EXISTS AS A COMMAND rather than a file in the repository. The
 * material was already written: `API.md` is accurate and detailed. It was also
 * unreachable by the reader who needs it. End users install a compiled binary
 * and never clone this repo, and the skill an agent loads is a template
 * embedded in that binary — so every "see API.md" in it pointed at a path that
 * resolves to nothing on the machine where the agent is running. A bypass
 * document nobody can open is a bypass document that does not exist.
 *
 * So `UPSTREAM.md` is imported as text, the same way the skill template and
 * `contract.json` are, and printed on demand. `import.meta.dir` is a virtual
 * path in a compiled binary, so a `readFileSync` against it would compile
 * happily here and fail only for the user — that is the trap this import
 * avoids, and the reason the file cannot simply be read from disk.
 *
 * It costs nothing until asked for: one flag, one print, no session, no
 * request. `src/upstream.test.ts` holds its contents to the constants in the
 * source, so it cannot rot the way the READMEs did.
 */

import upstream from '../UPSTREAM.md' with { type: 'text' };

/** The document, verbatim. */
export function upstreamDoc(): string {
  return upstream;
}
