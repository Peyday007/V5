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

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/goals.ts "$@"
