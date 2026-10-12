#!/bin/sh
# Failure hook for watch.mjs: tells the maintainer, then asks Claude Code to
# draft a repair on its own branch in a separate worktree. It never pushes and
# never changes the checkout the service runs from.
#
# Arguments: <entry> <report path>
# Environment:
#   CLAUDEX_FRONTEND_CHECKOUT  the service checkout (required)
#   CLAUDEX_FRONTEND_STATE     the service state directory (required)
#   CLAUDEX_FRONTEND_NOTIFY    optional executable, called with one message
#   CLAUDEX_FRONTEND_REPAIR    set to 0 to notify only
set -eu
entry=$1 report=$2
checkout=${CLAUDEX_FRONTEND_CHECKOUT:?} state=${CLAUDEX_FRONTEND_STATE:?}
case $entry in index-*.js) ;; *) echo "Not an entry name" >&2; exit 64 ;; esac
name=${entry%.js}
notify() { [ -z "${CLAUDEX_FRONTEND_NOTIFY:-}" ] || "$CLAUDEX_FRONTEND_NOTIFY" "$1" || echo "Notification failed" >&2; }

notify "Claudex: Claude frontend $entry failed the adapter check. Report: $report"
[ "${CLAUDEX_FRONTEND_REPAIR:-1}" = 1 ] || exit 0

mkdir -p "$state/repairs"
worktree=$state/repairs/$name summary=$state/repairs/$name.md
git -C "$checkout" fetch --quiet origin main
git -C "$checkout" worktree add --quiet -b "frontend-repair/$name" "$worktree" origin/main
ln -s "$checkout/node_modules" "$worktree/node_modules"
prompt=$(sed -e "s|{{ENTRY}}|$entry|g" -e "s|{{REPORT}}|$report|g" -e "s|{{STATE}}|$state|g" "$checkout/dev/frontend-watch/repair-prompt.md")
status=0
(cd "$worktree" && timeout 3600 claude -p "$prompt" --permission-mode acceptEdits \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node:*),Bash(git status:*),Bash(git diff:*),Bash(git add:*),Bash(git commit:*),Bash(git log:*)") \
  > "$summary" 2>&1 || status=$?
commits=$(git -C "$worktree" rev-list --count origin/main..HEAD)
notify "Claudex: repair draft for $entry finished (exit $status, $commits commit(s)) on branch frontend-repair/$name. Summary: $summary"
exit "$status"
