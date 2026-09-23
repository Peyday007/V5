#!/bin/sh
# Print what Brain learned from the outcomes of its own work, inside the
# deployed container: the outcomes observed, the predictions beside them, the
# lessons with their samples, the decisions a lesson changed, the watches, and
# the capability proposals.
#
# Same shape as `labor-report.sh`, for the same reasons: cd to the app so
# `node --import tsx` resolves, one pooler connection because this is a read
# beside a running app, and the container's own revision first.
#
# Usage:  sh /app/scripts/learning-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."

export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/learning-report.ts "$@"
