#!/bin/sh
# Print one project's labor map from the authoritative rows, inside the
# deployed container.
#
# Same shape as `cash-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# It prints the running artifact's own `BRAIN_REVISION` first. That is not
# decoration: a report read out of a container says nothing about *which*
# container unless the container says which commit it was built from, and the
# deployment system's own label is a claim about what it asked for rather than
# a reading of what is serving.
#
# Usage:  sh /app/scripts/labor-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/labor-report.ts "$@"
