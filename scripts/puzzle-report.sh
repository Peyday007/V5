#!/bin/sh
# Print one project's puzzle kernel from the authoritative rows, inside the
# deployed container.
#
# Same shape as `cash-report.sh` and `labor-report.sh`, and the same reason:
# `flyctl ssh console -C` opens a session in `/`, so the script has to cd to
# the app before `node --import tsx` can resolve anything.
#
# It prints the running artifact's own `BRAIN_REVISION` first. That is not
# decoration: a report read out of a container says nothing about *which*
# container unless the container says which commit it was built from, and the
# deployment system's own label is a claim about what it asked for rather than
# a reading of what is serving.
#
# Usage:  sh /app/scripts/puzzle-report.sh [--project prj_xxx] [--puzzle pzi_xxx]
set -e
cd "$(dirname "$0")/.."

# One connection, because this is a read beside a running app. §45 records what
# the alternative costs: a wrapper with no pool setting takes the adapter's
# default of ten against a Supabase pooler with a shared limit of fifteen, and
# the reading fails exactly when the Brain is busiest — which is exactly when
# somebody wants to take it.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/puzzle-report.ts "$@"
