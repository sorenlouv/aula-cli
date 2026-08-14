#!/usr/bin/env bash
#
# Show what changed upstream in aula-mcp's aula-auth since we vendored it.
#
# Deliberately diff-only: we modify the vendored files, so copying over them
# would silently discard local fixes. Read the diff and take what you want.
#
# Usage: scripts/vendor-diff.sh [path-to-aula-mcp-checkout]

set -euo pipefail

UPSTREAM="${1:-${AULA_MCP_PATH:-$HOME/dev/aula-prior-art/aula-mcp}}"
SRC="$UPSTREAM/packages/aula-auth/src"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/src/vendor/aula-auth"

if [[ ! -d "$SRC" ]]; then
  echo "No aula-mcp checkout at: $UPSTREAM" >&2
  echo "Pass one as \$1, or set \$AULA_MCP_PATH." >&2
  echo "  git clone https://github.com/Casperjuel/aula-mcp" >&2
  exit 1
fi

echo "vendored: $VENDOR"
echo "upstream: $SRC"
if commit=$(git -C "$UPSTREAM" rev-parse HEAD 2>/dev/null); then
  echo "upstream is at: $commit"
  echo "vendored from:  $(grep -o '`[0-9a-f]\{40\}`' "$VENDOR/VENDOR.md" | head -1 | tr -d '`')"
fi
echo

# LICENSE and VENDOR.md are ours to maintain, so they are not part of the diff.
if diff -ru --exclude=LICENSE --exclude=VENDOR.md "$VENDOR" "$SRC"; then
  echo "No drift — vendored copy matches upstream."
fi
