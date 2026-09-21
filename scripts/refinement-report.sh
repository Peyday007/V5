#!/bin/sh
# Print where every deep dive spent its time, inside the deployed container.
#
# Same shape as `cash-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Usage:  sh /app/scripts/refinement-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/refinement-report.ts "$@"
