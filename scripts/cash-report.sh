#!/bin/sh
# Print a Cash sprint's authoritative rows inside the deployed container.
#
# Same shape as `packet-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Usage:  sh /app/scripts/cash-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."

# One connection, for `labor-report.sh`'s reason and because this script just
# grew the condition that one was written from.
#
# §41 measured it: `laborSnapshot` fires seven reads through `Promise.all`, so
# a pool of two opens two pooler clients at once, and against the Supabase
# pooler's shared fifteen-client limit that is the difference between a report
# that answers and one that fails with `EMAXCONNSESSION`. `cash-report`
# succeeded at 00:40 where labor failed at 00:41 on the same Brain — not
# because the pooler changed in that minute, but because this script needed
# fewer clients.
#
# It needs more now: the social commerce section added a `commerceView`, whose
# snapshot reads five tables concurrently. That is the same shape, so it takes
# the same remedy rather than waiting to be measured failing. It costs a report
# a second and buys being readable exactly when the pooler is tight, which is
# when somebody wants to read it.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

# And the running artifact's own commit, as `labor-report.sh` already prints:
# a sprint read out of a container is attributable to a tree only if the
# container says which commit it was built from.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/cash-report.ts "$@"
