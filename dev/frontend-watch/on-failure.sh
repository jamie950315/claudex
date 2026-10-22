#!/bin/sh
# Failure hook for watch.mjs: tells the maintainer. It never starts a model or
# changes any checkout; repairs are made and verified by hand.
#
# Arguments: <entry> <report path>
# Environment:
#   CLAUDEX_FRONTEND_NOTIFY    optional executable, called with one message
set -eu
entry=$1 report=$2
case $entry in index-*.js) ;; *) echo "Not an entry name" >&2; exit 64 ;; esac

# Messages may leave this machine: they carry the entry and adapter names only,
# never a path, a host name or report contents.
failed=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(Object.entries(r.adapters).filter(([,a])=>a.status!=="passed").map(([n])=>n).join(", "))' "$report" 2>/dev/null || true)
[ -z "${CLAUDEX_FRONTEND_NOTIFY:-}" ] || "$CLAUDEX_FRONTEND_NOTIFY" "Claudex: Claude frontend $entry failed the adapter check${failed:+ ($failed)}." || echo "Notification failed" >&2
