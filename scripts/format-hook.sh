#!/usr/bin/env bash
# PostToolUse hook: run the repo's own Prettier on whatever file the agent just
# wrote, so agent edits land in the same shape VSCode's format-on-save produces.
# Wired up in .claude/settings.json.
#
# The hook receives the tool call as JSON on stdin. Everything is resolved from
# the edited file's own path — never from $PWD or an env var — so it behaves the
# same in the main checkout, in a worktree, and from a subdirectory.
set -uo pipefail

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$file" ] || exit 0

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
prettier="$root/node_modules/.bin/prettier"
[ -x "$prettier" ] || exit 0

# --ignore-unknown skips file types Prettier has no parser for; .prettierignore
# and .gitignore are resolved from the repo root, hence the cd.
cd "$root" || exit 0
"$prettier" --write --ignore-unknown --log-level warn "$file"
