#!/usr/bin/env bash
#
# Prove the MitID tokens alone authenticate every endpoint we use.
#
# The cookie is the confound: it authenticates on its own, so with one present
# a passing run tells you nothing about the token. This hides the cookie for
# the duration (restoring it on any exit, including Ctrl-C) and runs the read
# commands against tokens only.
#
# Run `bun run login` first.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SESSION="${AULA_SESSION_FILE:-$HOME/.aula/session.json}"
HIDDEN="$SESSION.hidden-by-verify"

# Thread ids are account-specific, so the sensitive-thread check needs one
# supplied: first argument, or AULA_TEST_THREAD_ID.
THREAD_ID="${1:-${AULA_TEST_THREAD_ID:-}}"

restore() {
  [[ -f "$HIDDEN" ]] && mv "$HIDDEN" "$SESSION"
  return 0
}
trap restore EXIT INT TERM

if [[ -f "$SESSION" ]]; then
  mv "$SESSION" "$HIDDEN"
  echo "Cookie fallback hidden for the duration ($SESSION)."
else
  echo "No cookie fallback present — tokens are already the only credential."
fi
# Belt and braces: $AULA_COOKIE outranks tokens, so a stray one in the
# environment would silently invalidate the whole run.
unset AULA_COOKIE
echo

pass=0
fail=0
run() {
  local label="$1"; shift
  if out=$(bun src/cli.ts "$@" 2>&1); then
    printf '  ok    %-34s %s bytes\n' "$label" "$(printf '%s' "$out" | wc -c | tr -d ' ')"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-34s\n' "$label"
    printf '%s\n' "$out" | sed 's/^/          /' | head -6
    fail=$((fail + 1))
  fi
}

echo "Reads on token auth only:"
run "whoami"            whoami
run "messages"          messages --limit 5
if [[ -n "$THREAD_ID" ]]; then
  run "thread (sensitive)" thread "$THREAD_ID"
else
  printf '  skip  %-34s %s\n' "thread (sensitive)" "(pass a thread id as \$1 or set AULA_TEST_THREAD_ID)"
fi
run "posts"             posts --limit 5
run "calendar (POST+CSRF)" calendar --days 30
run "presence"          presence
run "schedule"          schedule
run "groups"            groups
run "contacts"          contacts
run "birthdays"         birthdays
run "notifications"     notifications
run "widgets"           widgets
run "ugeplan"           ugeplan
run "digest"            digest --days 7

echo
echo "Checks that need more than an exit code:"

# Step-up: sensitive threads come back *empty* rather than erroring when the
# assurance level has lapsed, so an exit code alone cannot catch this.
stepped=$(bun src/cli.ts whoami 2>/dev/null | grep -o '"isSteppedUp": *[a-z]*' | head -1)
echo "  ${stepped:-isSteppedUp: unknown}"
[[ "$stepped" == *true* ]] || echo "        -> run: bun src/cli.ts refresh-stepup"

# The integration payoff: the MitID username should come from the login itself
# now, not from the (currently hidden) session.json. No command prints
# sessionIdIsFallback directly, so ask family.ts for it.
read -r username fallback <<<"$(bun -e '
import { AulaClient } from "./src/client.ts";
import { resolveFamily, integrationContext } from "./src/family.ts";
const family = await resolveFamily(await AulaClient.create());
console.log(family.mitidUsername ?? "-", integrationContext(family).sessionIdIsFallback);
' 2>/dev/null)"
echo "  mitidUsername: ${username:--}   sessionIdIsFallback: ${fallback:-unknown}"
if [[ "$fallback" == "false" ]]; then
  echo "        -> good: Meebook/Huskelisten get the real MitID username"
else
  echo "        -> Meebook/Huskelisten will fall back to the Aula guardian id"
fi

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
