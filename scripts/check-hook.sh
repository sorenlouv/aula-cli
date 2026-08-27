#!/usr/bin/env bash
# PostToolUse hook: typecheck and lint after an agent edits TypeScript, and feed
# any complaint straight back into the agent's context. Wired up in
# .claude/settings.json, alongside the Prettier hook that formats the same edit.
#
# Why this exists: the login page's browser client used to be a string, so no
# tool ever read it. Now that it is real TSX in a second tsconfig project, the
# failure mode to design against is an agent editing src/browser/ and never
# learning that the DOM types, the JSX runtime or the hook rules rejected it.
# Finding that out at `bun run build` is several wrong turns too late.
#
# Deliberately NON-BLOCKING: it always exits 0 and reports through
# additionalContext rather than exit code 2. A type error mid-refactor is normal
# and an agent that gets hard-stopped on every intermediate state cannot work.
# Silence on success keeps it that way — the hook only speaks when it has news.
#
# Everything resolves from the edited file's own path, never $PWD, so it behaves
# identically in the main checkout and in a worktree. Same rule as format-hook.sh.
set -uo pipefail

payload=$(cat)
file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty' <<<"$payload")
[ -n "$file" ] || exit 0

# Only TypeScript. Prettier's hook takes everything else, and a JSON or Markdown
# edit has nothing for tsc or oxlint to say.
case "$file" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
tsc="$root/node_modules/.bin/tsc"
oxlint="$root/node_modules/.bin/oxlint"
cd "$root" || exit 0

report=""

# Both projects, always. A file's directory decides which tsconfig owns it, but
# an edit in either project can break the other — src/browser/bundle.ts is
# checked by the ROOT project despite its path, because the macro import pulls
# it there. Guessing from the path would get exactly that file wrong, and both
# projects together cost about a quarter of a second.
if [ -x "$tsc" ]; then
  types=$("$tsc" --noEmit 2>&1; "$tsc" --noEmit -p src/browser 2>&1)
  [ -n "$types" ] && report+="typecheck:"$'\n'"$types"$'\n'
fi

# Just the edited file: oxlint has no cross-file analysis, so the whole-tree walk
# would only add noise from code this edit never touched.
if [ -x "$oxlint" ]; then
  lint=$("$oxlint" "$file" 2>&1 | grep -v '^$')
  [ -n "$lint" ] && report+="lint:"$'\n'"$lint"$'\n'
fi

[ -n "$report" ] || exit 0

jq -n --arg r "$report" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("Checks on the file just edited:\n" + $r)
  },
  systemMessage: "typecheck/lint findings — see context"
}'
