#!/bin/sh
# Read and decide goals from the authoritative rows, inside the deployed
# container. Same shape as `admin.sh`: `flyctl ssh console -C` opens a session
# in `/`, so this cds to the app before `node --import tsx` can resolve.
#
# One pooler client, because every command here is sequential: the reads walk
# goals one at a time and each write is one statement. §39 records why every
# wrapper beside a running app takes the smallest footprint on a shared limit.
#
# It prints the running artifact's own `BRAIN_REVISION` first, because a report
# read out of a container says nothing about *which* container otherwise.
set -e
cd "$(dirname "$0")/.."
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
# With one client, the only thing a query here can wait behind is this
# process's own query in flight. The planner's synchronous evaluation holds the
# loop for seconds at a time, and an expired timer runs before the I/O that
# would release the client, so the pool's 10 s default refused a goal's read on
# its own query (release check 45034423897, wst_7b4f…: "1/1 in use, 0 caller(s)
# waiting"). The read stays bounded by the check's 6-minute per-goal budget.
export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-120000}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"

# `ready`: has the running app finished its boot derived-state rebuild? The app
# writes this file, naming its own pid, when it has (server/index.ts). The
# release check waits for it (goals.yml) rather than reading plans beside the
# rebuild: three processes on the box OOM-killed the app on 2026-11-21. Starts
# no node, so asking costs nothing.
if [ "${1:-}" = ready ]; then
  marker="${BRAIN_DERIVED_STATE_MARKER:-${TMPDIR:-/tmp}/brain-derived-state-rebuilt}"
  pid=$(cut -d' ' -f1 "$marker" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "DERIVED_STATE READY $(cat "$marker")"
  else
    echo "DERIVED_STATE PENDING"
  fi
  exit 0
fi

exec nice -n 19 node --import tsx scripts/goals.ts "$@"
